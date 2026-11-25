// Tunable parameters for generation and scoring. Env vars override the LLM settings.
export const config = {
  /**
   * "anthropic" or "gemini". Unset: Anthropic if ANTHROPIC_API_KEY is set, else Gemini if GEMINI_API_KEY is.
   * Either way a run falls back to Gemini when Anthropic rejects the key or the credit balance is empty.
   */
  provider: process.env.MOKRILLION_PROVIDER as "anthropic" | "gemini" | undefined,
  model: process.env.MOKRILLION_MODEL ?? "claude-opus-5-5",
  geminiModel: process.env.MOKRILLION_GEMINI_MODEL ?? "gemini-3.8-flash",
  effort: (process.env.MOKRILLION_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max",
  /** Hard stop for one CLI run's estimated API spend. */
  maxCostUSD: Number(process.env.MOKRILLION_MAX_COST_USD ?? 5),
  /** Retries when the model returns output that fails validation (on top of SDK network retries). */
  maxRetries: 2,

  /** Answer pool bounds for a question to be usable. */
  minPool: 5,
  maxPool: 60,

  /** Shuffled listwise ranking passes per question. */
  rankingPasses: 5,
  /** Weights of the final rank key; see README "Scoring". */
  weights: { llm: 0.6, popularity: 0.3, spelling: 0.1 },
  /** How many of the rarest candidates get round-robin pairwise comparisons. */
  rareContenders: 4,
  maxReviewChallenges: 5,
  /** Share of candidates per tier, most obvious first. 85 takes the rest, 100 is exactly one. */
  tierShares: { 10: 0.08, 30: 0.17, 60: 0.3 },

  /** Bump when the scoring algorithm or its parameters change. */
  scoringVersion: "3",
};
