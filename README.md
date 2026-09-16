# jev-router

Automatic model routing for Claude Code. Each turn goes to the cheapest model that can
actually handle it — trivial edits to Haiku, hard debugging to Opus — with the decision made
by [Jev](https://docs.typesafe.ai), TypeSafe's System One decision model.

It runs the real Claude Code CLI. The interface, keybindings, tools, permission prompts,
`/compact`, `/resume` and session handling are unchanged, because they are still Claude
Code's.

## Quick start

Requires [Claude Code](https://code.claude.com/docs/en/setup) and Node.js 20.12+.

```bash
npm install -g jev-router
echo "JEV_API_KEY=..." > ~/.jev-claude.env
jev-claude
```

Get a key from [TypeSafe](https://docs.typesafe.ai) for free. The package is `jev-router`;
the command it installs is `jev-claude`. No `ANTHROPIC_API_KEY` is needed:
`jev-claude` reuses your existing `claude login`, so a Claude Pro or Max subscription works
as-is. Without a Jev key you simply get plain Claude Code.

Every argument is forwarded to `claude`, so `jev-claude -p "..."`, `jev-claude --resume` and
the rest behave exactly as you expect.

## Using it

Sessions start on a **Jev Auto** entry added to the `/model` picker. While it is selected,
every turn is routed. Pick any other model and routing stands down entirely: your choice goes
to the API untouched and Jev is not consulted. Reselect Jev Auto to resume routing
mid-session.

A status line shows which mode you are in and what the last turn actually used:

```
⚡ haiku p=0.98 · my-project · 8% context        routed, Jev confidence 0.98
⏸ manual Opus 4.6 · my-project · 21% context     your own choice
```

This matters because Claude Code's own UI reports the model it *requested*, not the one the
proxy routed to. It has no way to know the request was rewritten.

The status line is installed with `--settings`, which merges rather than replaces. If you
already have a `statusLine` configured, yours is kept and nothing is injected. Set
`JEV_NO_STATUSLINE=1` to disable it.

> Choosing any row with `Enter` makes Claude Code save it as your default for new sessions.
> `jev-claude` restores your previous default on exit, so a saved `jev-auto` can never break
> plain `claude`. Press `s` instead to switch for the current session only.

## How it works

`jev-claude` starts a proxy on a loopback port and launches the real `claude` with
`ANTHROPIC_BASE_URL` pointing at it. Claude Code sends its normal requests; the proxy
rewrites one field and forwards everything upstream.

```
you -> claude (real CLI, real UI) -> jev-claude proxy -> api.anthropic.com
                                            |
                                            +-> Jev: which tier does this turn need?
```

Claude Code does not validate model names behind a custom base URL, so the `jev-auto`
sentinel reaches the proxy as an exact "route this turn" signal rather than something to
infer.

Your credentials are never read, stored or modified. The proxy forwards the `authorization`
header it receives without inspecting it.

## Routing rules

One Jev call per user turn selects a tier. `src/policy.mjs` then applies, in order:

- an explicit `use opus` in your message wins outright;
- a Jev failure, timeout or unrecognised answer keeps the current model;
- a low-confidence answer never downgrades, and caps upgrades at Sonnet;
- a downgrade is refused once the conversation is large, since switching models invalidates
  the prompt cache and the rebuild costs more than the downgrade saves;
- the tier is clamped to what is enabled, stepping up rather than down, and never up into
  Fable, which bills extra usage credits.

Routing is fail-open by construction: every error path keeps the original model.

Three kinds of request are deliberately not routed:

| Request | Reason |
| --- | --- |
| Any model other than `jev-auto` | You chose it. This also covers Claude Code's internal Haiku calls for titles and summaries. |
| Tool-loop continuations | A turn spans many requests. The tier is chosen once and pinned, so the model cannot change mid-task. |
| Calls carrying no tools | Auxiliary work, not a user turn. |

Sub-agents are routed, but pinned separately, so a sub-agent's choice cannot leak into the
main conversation.

## Configuration

| Variable | Effect |
| --- | --- |
| `JEV_API_KEY` | Required for routing. `TYPESAFE_API_KEY` also works. |
| `JEV_ALLOW_FABLE` | Set to `1` to let the router pick Fable, which bills extra usage credits. Off by default. |
| `JEV_NO_STATUSLINE` | Set to `1` to stop injecting the status line. |
| `JEV_DEBUG` | Logs every decision and rewrite. Interactive sessions write to `~/.jev-claude.log`, since stderr would corrupt Claude Code's UI; `-p` mode writes to stderr. |
| `JEV_DUMP` | Path prefix for dumping request bodies, for debugging wire-format changes. |

Values are read from the environment, from `~/.jev-claude.env`, and from a `.env` in the
launch directory, in increasing order of precedence. Since `jev-claude` is normally installed
globally, `~/.jev-claude.env` is the usual place.

Tier definitions, the Jev question, confidence thresholds and timeouts all live in
`src/config.mjs`, which is the entire policy surface.

## Compatibility notes

Three things the proxy has to handle, none of them documented:

- **MCP tool schemas.** Claude Code normalises draft-04 JSON Schema relics before sending
  them first-party, but skips that step when `ANTHROPIC_BASE_URL` is set. An MCP server
  emitting `"exclusiveMinimum": true` would have the entire request rejected, so the proxy
  performs the conversion itself.
- **Model capabilities.** Claude Code composes each body for the model it believes it is
  using. Routing down to Haiku while leaving `thinking`, `output_config.effort` or a
  `clear_thinking` context-management strategy in place is a hard 400, so those fields are
  stripped for tiers that do not support them.
- **`HEAD /`.** Claude Code probes the base URL before its first request.

## Development

```bash
npm install
echo "JEV_API_KEY=..." > .env

npm test                     # 44 offline tests
node test/live-routing.mjs   # real Jev calls across four difficulty tiers
node bin/jev-claude.mjs -p "what is 2+2?"

npm link                     # try the globally installed form
```

`npm test` covers the policy decision table with synthetic Jev answers, plus the proxy's pure
functions: schema sanitising, turn detection, capability stripping, conversation keying and
settings restoration.

The wording of the Jev question matters more than expected. Instructing Jev to judge the
reasoning a request demands rather than the length of the reply it asks for moved a hard
debugging prompt ending in "answer in one sentence" from 0.21 confidence on Haiku to 0.81 on
Opus.

## Limitations

- Your prompt text is sent to TypeSafe for the routing decision. Nothing else is.
- Jev adds roughly 300 ms to the first request of a turn, and about a second on the first
  call of a session while TLS is established. Tool-loop requests add nothing.
- Claude Code's request format is not a public contract. If a future version moves things
  around, `JEV_DUMP` is how you find out.
- Developed and tested on Windows against Claude Code v2.1.101.

## License

MIT
