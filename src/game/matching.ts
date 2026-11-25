// Free-text answer -> entity. Exact names and aliases first, then conservative typo matching that
// never silently resolves an ambiguous or distant guess.
import { normalizeName } from "../knowledge/normalize.ts";
import type { Knowledge } from "../knowledge/queries.ts";
import type { Entity } from "../knowledge/types.ts";

export type Match =
  /** Resolved to one entity; `corrected` when a single typo was fixed. */
  | { kind: "entity"; entity: Entity; corrected: boolean }
  /** Close to one or more entities but not certain: show as "did you mean". Not counted as an answer. */
  | { kind: "suggest"; suggestions: Entity[] }
  | { kind: "unknown" };

/** Optimal string alignment distance (Levenshtein plus adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

export function matchAnswer(kb: Knowledge, text: string): Match {
  const input = normalizeName(text);
  if (!input) return { kind: "unknown" };
  const exact = kb.findByName(input);
  if (exact) return { kind: "entity", entity: exact, corrected: false };

  // Best distance per entity over its name and aliases (aliases shorter than 4 letters are exact-only).
  const scored = kb.entities
    .map((e) => ({
      e,
      d: Math.min(...[e.name, ...e.aliases].map(normalizeName).filter((n) => n.length >= 4).map((n) => editDistance(input, n))),
    }))
    .sort((x, y) => x.d - y.d);
  const [best, second] = scored;
  // One typo on a name of 5+ characters, with no other entity within two edits: safe to auto-correct.
  if (best.d === 1 && input.length >= 5 && (!second || second.d >= 3)) return { kind: "entity", entity: best.e, corrected: true };
  // Otherwise offer suggestions within a length-scaled distance; never auto-accept them.
  const limit = Math.max(1, Math.floor(input.length / 4));
  const suggestions = scored.filter((x) => x.d <= limit).slice(0, 3).map((x) => x.e);
  return suggestions.length ? { kind: "suggest", suggestions } : { kind: "unknown" };
}
