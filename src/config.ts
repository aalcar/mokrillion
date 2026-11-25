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
  /**
   * Weights of the final rank key, by question type (see README "Scoring"). Human judgments showed that for
   * membership questions ("name a 3,200 item") recall follows what players see in games, while for association
   * questions ("name an item with Melee Resist") it follows whether players link the answer to the property.
   */
  weights: {
    membership: { llm: 0.25, popularity: 0.7, spelling: 0.05 },
    association: { llm: 0.8, popularity: 0.15, spelling: 0.05 },
  },
  /** Signature prefixes of membership questions; everything else is an association question. */
  membershipPrefixes: ["item-cost:", "item-slot-tier:", "item-active:", "item-component:", "name:"],
  /** How many of the rarest candidates get round-robin pairwise comparisons. */
  rareContenders: 4,
  maxReviewChallenges: 5,
  /**
   * A reviewer challenge is applied on gameplay data alone only when the answer it calls rarer is played/bought
   * at most 1/margin as often as the other; closer calls go to a model comparison.
   */
  reviewDataMargin: 1.5,
  /** Share of candidates per tier, most obvious first. 85 takes the rest, 100 is exactly one. */
  tierShares: { 10: 0.08, 30: 0.17, 60: 0.3 },

  /** Bump when the scoring algorithm or its parameters change. */
  scoringVersion: "8",
};
