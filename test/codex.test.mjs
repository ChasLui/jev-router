import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addJevModel,
  applyCodexTier,
  codexConversationKey,
  codexModels,
  codexNewTurnPrompt,
  isCodexAuxiliaryPrompt,
  jevDecisionEvents,
  startCodexProxy,
  upstreamFor,
} from "../src/codex-proxy.mjs";
import { codexArgs, installCodexSkill } from "../src/codex-cli.mjs";
import { readStatus } from "../src/status.mjs";

test("Codex uses a temporary authenticated Jev provider", () => {
  const args = codexArgs("http://127.0.0.1:1234", ["--sandbox", "read-only"]);
  assert.deepEqual(args.slice(0, 2), ["--model", "jev-router"]);
  assert(args.includes('model_provider="jev"'));
  assert(args.includes("model_providers.jev.requires_openai_auth=true"));
  assert.deepEqual(args.slice(-2), ["--sandbox", "read-only"]);
  assert.equal(codexArgs("http://127.0.0.1:1234", ["--model", "gpt-5.6-sol"]).filter((a) => a === "--model").length, 1);
});

test("installs the bundled explanation skill for Codex", (t) => {
  const home = mkdtempSync(join(tmpdir(), "jev-codex-skill-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = installCodexSkill(home);
  assert.match(target, /jev-router-explain[\\/]SKILL\.md$/);
  assert.match(readFileSync(target, "utf8"), /name: jev-explain/);
});

test("reads only fresh Codex user turns", () => {
  const body = {
    input: [
      { type: "additional_tools", role: "developer", tools: [{}] },
      { role: "user", content: [{ type: "input_text", text: "Fix the bug" }] },
      { role: "user", content: [{ type: "input_text", text: "<system_reminder>tools</system_reminder>" }] },
      {
        role: "user",
        content: "<environment_context><current_date>2026-09-17</current_date></environment_context>",
      },
    ],
  };
  assert.equal(codexNewTurnPrompt(body), "Fix the bug");
  body.input.push({ type: "function_call_output", call_id: "1", output: "done" });
  assert.equal(codexNewTurnPrompt(body), null);
  assert.equal(
    codexNewTurnPrompt({
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: "Generate a concise, single-line task title of at most 36 characters" },
        {
          role: "user",
          content: "<environment_context><timezone>Asia/Calcutta</timezone></environment_context>",
        },
      ],
    }),
    null,
  );
  assert.equal(isCodexAuxiliaryPrompt("Generate a concise, single-line task title of at most 36 characters"), true);
});

test("reads Codex 0.155 turns that carry top-level tools and trailing hook context", () => {
  // Trimmed from a real Codex 0.155.1 `exec` request body.
  const text = (value) => [{ type: "input_text", text: value }];
  const body = {
    tools: [{ type: "function", name: "exec_command" }],
    input: [
      { type: "message", role: "developer", content: text("<permissions instructions>...") },
      { type: "message", role: "user", content: text("# AGENTS.md instructions\n\n<INSTRUCTIONS>...") },
      { type: "message", role: "developer", content: text("hook session-start context") },
      { type: "message", role: "user", content: text("Run `ls package.json`") },
      { type: "message", role: "developer", content: text("<openviking-context>...") },
    ],
  };
  assert.equal(codexNewTurnPrompt(body), "Run `ls package.json`");
  assert.equal(codexNewTurnPrompt({ ...body, tools: [] }), null);
  body.input.push(
    { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls package.json"}', call_id: "c1" },
    { type: "function_call_output", call_id: "c1", output: "package.json" },
  );
  assert.equal(codexNewTurnPrompt(body), null);
});

// Trimmed from real Codex 0.155.1 requests captured around compaction.
const compactionShapes = () => {
  const text = (value) => [{ type: "input_text", text: value }];
  const meta = (kind, compaction) => ({
    turn_id: "turn-1",
    "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn-1", request_kind: kind, compaction }),
  });
  const task = { type: "message", role: "user", content: text("Use the shell to cat README.md") };
  return {
    // Auto (mid_turn/pre_turn) and manual /compact summarisation requests carry no tools.
    summary: {
      tools: [],
      client_metadata: meta("compaction", { trigger: "manual", phase: "standalone_turn" }),
      input: [
        task,
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading." }] },
        { type: "message", role: "user", content: text("You are performing a CONTEXT CHECKPOINT COMPACTION. ...") },
      ],
    },
    // The request resuming a turn after mid-turn auto-compaction looks like a fresh user turn.
    resumed: {
      tools: [{ type: "function", name: "exec_command" }],
      client_metadata: meta("turn"),
      input: [
        { type: "message", role: "developer", content: text("<permissions instructions>...") },
        task,
        { type: "message", role: "user", content: text("Another language model started to solve this problem ...") },
        { type: "message", role: "developer", content: text("hook context") },
      ],
    },
  };
};

test("Codex compaction requests are never new user turns", () => {
  const { summary, resumed } = compactionShapes();
  assert.equal(codexNewTurnPrompt(summary), null);
  assert.equal(codexNewTurnPrompt(resumed, "turn-1"), null);
  assert.match(codexNewTurnPrompt(resumed, "turn-0"), /^Another language model/);
});

test("proxy does not re-route a turn resumed after mid-turn compaction", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end(""));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  let routeCalls = 0;
  const { port, close } = await startCodexProxy({
    apiBaseURL: `http://127.0.0.1:${upstream.address().port}/v1`,
    route: async () => {
      routeCalls++;
      return null;
    },
  });
  t.after(close);
  const { resumed } = compactionShapes();
  const first = { ...resumed, model: "jev-router", prompt_cache_key: "main", input: resumed.input.slice(0, 2) };
  for (const body of [first, { ...resumed, model: "jev-router", prompt_cache_key: "main" }]) {
    await fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.text());
  }
  assert.equal(routeCalls, 1);
});

test("keeps sub-agent routing state separate", () => {
  const base = { input: [{ role: "user", content: "same prompt" }] };
  assert.notEqual(
    codexConversationKey({ ...base, prompt_cache_key: "main" }),
    codexConversationKey({ ...base, prompt_cache_key: "sub-agent" }),
  );
});

test("adds Jev Router to the native model catalog", () => {
  const catalog = addJevModel({
    models: [{
      slug: "gpt-5.6-terra",
      display_name: "GPT-5.6-Terra",
      visibility: "list",
      supported_in_api: true,
      priority: 2,
    }],
  });
  assert.equal(catalog.models[0].slug, "jev-router");
  assert.equal(catalog.models[0].display_name, "Jev Router");
  assert.equal(catalog.models[1].slug, "gpt-5.6-terra");
});

test("routes subscription auth to ChatGPT and API keys to the public API", () => {
  assert.equal(
    upstreamFor({ "chatgpt-account-id": "acct" }, "/responses"),
    "https://chatgpt.com/backend-api/codex",
  );
  assert.equal(upstreamFor({ authorization: "Bearer sk-test" }, "/responses"), "https://api.openai.com/v1");
  assert.equal(upstreamFor({ authorization: "Bearer sk-test" }, "/models"), "https://chatgpt.com/backend-api/codex");
});

test("maps tiers and clamps unsupported reasoning effort", () => {
  const body = { model: "jev-router", reasoning: { effort: "max" } };
  const models = new Map([[
    "gpt-5.6-luna",
    { default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium" }] },
  ]]);
  applyCodexTier(body, "haiku", models);
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.reasoning.effort, "medium");
});

test("sends exact available GPT models to Jev", () => {
  const models = new Map([
    ["gpt-5.6-terra", { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra" }],
    ["gpt-5.6-sol", { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" }],
  ]);
  assert.deepEqual(codexModels(models).map(({ id, tier }) => ({ id, tier })), [
    { id: "gpt-5.6-terra", tier: "sonnet" },
    { id: "gpt-5.6-sol", tier: "opus" },
  ]);
});

test("surfaces routing as a native commentary event", () => {
  const events = jevDecisionEvents({ tier: "opus", confidence: 0.91, reason: "jev" });
  assert.match(events, /response\.output_item\.added/);
  assert.match(events, /response\.output_text\.delta/);
  assert.match(events, /response\.output_item\.done/);
  assert.match(events, /"phase":"commentary"/);
  assert.match(events, /\[Jev\] routed this turn to gpt-5\.6-sol/);
  assert.match(events, /confidence 0\.91/);

  const unavailable = jevDecisionEvents({
    tier: "sonnet",
    confidence: null,
    reason: "jev-unavailable/no-change",
  });
  assert.match(unavailable, /Add routing credentials \(JEV_API_KEY, JEV_PROVIDER=cloudflare, or JEV_PROVIDER=vercel\)/);
  assert.match(unavailable, /using gpt-5\.6-terra/);
});

test("proxy preserves Codex auth, picker, routing, and native decision output", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        url: req.url,
        authorization: req.headers.authorization,
        account: req.headers["chatgpt-account-id"],
        body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null,
      });
      if (req.url.startsWith("/backend-api/codex/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          models: [{
            slug: "gpt-5.6-terra",
            display_name: "GPT-5.6-Terra",
            visibility: "list",
            supported_in_api: true,
            priority: 2,
          }, {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6-Sol",
            visibility: "list",
            supported_in_api: true,
            priority: 3,
          }],
        }));
      }
      res.end(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n',
      );
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
  const statusId = `codex-test-${process.pid}`;
  let routeCalls = 0;
  const { port, close } = await startCodexProxy({
    chatgptBaseURL: `${upstreamURL}/backend-api/codex`,
    apiBaseURL: `${upstreamURL}/v1`,
    route: async ({ models }) => {
      routeCalls++;
      assert.deepEqual(models.map((model) => model.id), ["gpt-5.6-terra", "gpt-5.6-sol"]);
      return {
        choice: "gpt-5.6-sol",
        confidence: 0.91,
        request: { state: { request: "debug this race" } },
        response: { answers: { model: { choice: "gpt-5.6-sol", confidence: 0.91 } } },
        metrics: {
          taskComplexity: 0.82,
          reasoningRequired: 0.91,
          toolComplexity: 0.64,
          contextSize: 0.31,
        },
      };
    },
    statusId,
  });
  t.after(close);
  const headers = { authorization: "Bearer subscription-token", "chatgpt-account-id": "acct" };

  const catalog = await fetch(`http://127.0.0.1:${port}/models?client_version=1`, { headers }).then((r) => r.json());
  assert.equal(catalog.models[0].slug, "jev-router");

  const response = await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      prompt_cache_key: "main",
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: [{ type: "input_text", text: "debug this race" }] },
      ],
    }),
  }).then((r) => r.text());

  assert.equal(seen[0].authorization, "Bearer subscription-token");
  assert.equal(seen[0].account, "acct");
  assert.equal(seen[1].body.model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).tier, "opus");
  assert.equal(readStatus(statusId).model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).prompt, "debug this race");
  assert.equal(readStatus(statusId).jev.request.state.request, "debug this race");
  assert.equal(readStatus(statusId).history.length, 1);
  assert.equal(readStatus(statusId).metrics.reasoningRequired, 0.91);
  assert(response.indexOf("response.created") < response.indexOf("[Jev] routed this turn"));
  assert(response.indexOf("[Jev] routed this turn") < response.indexOf("response.completed"));

  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: "Generate a concise, single-line task title of at most 36 characters" },
        {
          role: "user",
          content: "<environment_context><timezone>Asia/Calcutta</timezone></environment_context>",
        },
      ],
    }),
  });
  assert.equal(routeCalls, 1);
  assert.equal(readStatus(statusId).confidence, 0.91);
  assert.equal(readStatus(statusId).history.length, 1);

  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      prompt_cache_key: "main",
      input: [{ role: "user", content: [{ type: "input_text", text: "$jev-explain" }] }],
    }),
  });
  assert.equal(routeCalls, 1);
  assert.equal(seen[3].body.model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).metrics.reasoningRequired, 0.91);
});

test("JEV_CODEX_API_BASE_URL sends all traffic, /models included, to a custom gateway", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    res.end(req.url.startsWith("/v1/models") ? JSON.stringify({ data: [{ id: "deepseek-v4.1-flash" }] }) : "");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const env = { JEV_CODEX_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1` };
  for (const tier of ["FAST", "BALANCED", "STRONG", "LONG"]) env[`JEV_CODEX_${tier}_MODEL`] = `gw-${tier.toLowerCase()}`;
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let candidates;
  const { port, close } = await startCodexProxy({
    route: async ({ models }) => {
      candidates = models.map((model) => model.id);
      return { choice: "gw-fast", confidence: 0.9 };
    },
  });
  t.after(close);
  const headers = { authorization: "Bearer sk-test", "chatgpt-account-id": "acct" };

  const catalog = await fetch(`http://127.0.0.1:${port}/models?client_version=1`, { headers }).then((r) => r.json());
  assert.deepEqual(catalog, { data: [{ id: "deepseek-v4.1-flash" }] });
  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: [{ type: "input_text", text: "rename this variable" }] },
      ],
    }),
  });
  assert.deepEqual(seen, ["/v1/models?client_version=1", "/v1/responses"]);
  assert.deepEqual(candidates, ["gw-fast", "gw-balanced", "gw-strong"]);
});
