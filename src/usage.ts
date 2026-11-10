/** Running totals of model usage, printed on shutdown and available via !usage. */
export const usage = { decisions: 0, decisionInputTokens: 0, llmCalls: 0, llmInputTokens: 0, llmOutputTokens: 0, llmCostUsd: 0 }

export function usageSummary() {
  return `Laya (local): ${usage.decisions} decisions, ${usage.decisionInputTokens} input tokens, no API cost | LLM: ${usage.llmCalls} calls, ${usage.llmInputTokens} in / ${usage.llmOutputTokens} out tokens (~$${usage.llmCostUsd.toFixed(3)} at API list price)`
}
