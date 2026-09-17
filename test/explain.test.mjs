import test from "node:test";
import assert from "node:assert/strict";
import { formatExplanation } from "../src/explain.mjs";

test("formats the last routing decision", () => {
  const output = formatExplanation({
    tier: "sonnet",
    confidence: 0.94,
    reason: "jev",
    metrics: {
      taskComplexity: 0.82,
      reasoningRequired: 0.91,
      toolComplexity: 0.64,
      contextSize: 0.31,
    },
  });

  assert.match(output, /Task complexity     0\.82/);
  assert.match(output, /Selected model: SONNET/);
  assert.match(output, /Confidence: 94%/);
  assert.match(output, /Decision: Jev recommendation/);
});
