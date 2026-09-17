const WIDTH = 33;
const row = (text = "") => `│ ${text.slice(0, WIDTH - 2).padEnd(WIDTH - 2)} │`;
const metric = (value) => (Number.isFinite(value) ? value.toFixed(2) : "n/a");

const decision = (reason = "") => {
  if (reason.includes("override")) return "prompt override";
  if (reason.includes("jev-unavailable")) return "Jev unavailable; held";
  if (reason.includes("low-confidence-no-downgrade")) return "low confidence; held";
  if (reason.includes("low-confidence-capped")) return "low confidence; capped";
  if (reason.includes("cache-rebuild")) return "cache rebuild avoided";
  if (reason.includes("unavailable")) return "nearest available tier";
  return "Jev recommendation";
};

export function formatExplanation(status) {
  if (!status) return "Jev Router: no routing decision has been recorded for this session.";
  if (status.manual) return "Jev Router: routing is paused because you selected a model manually.";

  const m = status.metrics ?? {};
  return [
    `┌${"─".repeat(WIDTH)}┐`,
    row("Jev Router"),
    row(),
    row(`Task complexity     ${metric(m.taskComplexity)}`),
    row(`Reasoning required  ${metric(m.reasoningRequired)}`),
    row(`Tool complexity     ${metric(m.toolComplexity)}`),
    row(`Context size        ${metric(m.contextSize)}`),
    row(),
    row(`Selected model: ${(status.model ?? status.tier ?? "unknown").toUpperCase()}`),
    row(),
    row(`Confidence: ${status.confidence == null ? "n/a" : `${Math.round(status.confidence * 100)}%`}`),
    row(`Decision: ${decision(status.reason)}`),
    `└${"─".repeat(WIDTH)}┘`,
  ].join("\n");
}
