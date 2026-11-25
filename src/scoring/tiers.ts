import { config } from "../config.ts";
import type { Score } from "../knowledge/types.ts";

/**
 * Point tiers for `n` candidates ordered from most obvious to most obscure.
 * The last candidate gets 100; 10/30/60 get their configured shares (at least one each,
 * rounded); 85 takes the rest. Needs n >= 5 so all five tiers are nonempty.
 */
export function assignTiers(n: number, shares = config.tierShares): Score[] {
  if (n < 5) throw new Error(`need at least 5 candidates for five tiers, got ${n}`);
  const rest = n - 1; // excluding the single 100
  const counts = [shares[10], shares[30], shares[60]].map((s) => Math.max(1, Math.round(s * n)));
  // Shrink the largest of 60/30/10 until 85 keeps at least one candidate.
  while (counts[0] + counts[1] + counts[2] > rest - 1) {
    const i = counts.indexOf(Math.max(...counts));
    counts[i]--;
  }
  const c85 = rest - counts[0] - counts[1] - counts[2];
  return [
    ...Array<Score>(counts[0]).fill(10),
    ...Array<Score>(counts[1]).fill(30),
    ...Array<Score>(counts[2]).fill(60),
    ...Array<Score>(c85).fill(85),
    100,
  ];
}
