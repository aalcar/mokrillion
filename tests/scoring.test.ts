import assert from "node:assert/strict";
import { test } from "node:test";
import { deterministicCandidates } from "../src/generation/templates.ts";
import { validateSemantic } from "../src/generation/semantic.ts";
import type { Ask, AskOptions } from "../src/llm.ts";
import { loadKnowledge } from "../src/knowledge/queries.ts";
import { aggregate, kendallTau, summary, percentiles, refineOrder, scoreQuestion, seededRandom, shuffled, spellingCost } from "../src/scoring/rank.ts";
import { assignTiers } from "../src/scoring/tiers.ts";

const kb = loadKnowledge();

test("tiers: five nonempty tiers, exactly one 100, ordered, majority 60/85 for large pools", () => {
  for (let n = 5; n <= 60; n++) {
    const t = assignTiers(n);
    assert.equal(t.length, n);
    assert.equal(t.filter((s) => s === 100).length, 1);
    assert.equal(t.at(-1), 100);
    for (const s of [10, 30, 60, 85]) assert.ok(t.includes(s as 10), `n=${n} missing ${s}`);
    assert.deepEqual(t, [...t].sort((a, b) => a - b));
    if (n >= 10) assert.ok(t.filter((s) => s === 60 || s === 85).length > n / 2, `n=${n}`);
  }
  assert.throws(() => assignTiers(4));
});

test("seeded shuffle is deterministic and a permutation", () => {
  const xs = Array.from({ length: 20 }, (_, i) => i);
  const a = shuffled(xs, seededRandom("q#1")), b = shuffled(xs, seededRandom("q#1"));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, shuffled(xs, seededRandom("q#2")));
  assert.deepEqual([...a].sort((x, y) => x - y), xs);
});

test("percentiles and kendall tau", () => {
  assert.deepEqual(percentiles([10, 20, 20, 40]), [0, 0.5, 0.5, 1]);
  assert.equal(kendallTau(["a", "b", "c"], ["a", "b", "c"]), 1);
  assert.equal(kendallTau(["a", "b", "c"], ["c", "b", "a"]), -1);
});

test("spelling cost uses cheapest non-abbreviation spelling", () => {
  assert.equal(spellingCost(kb.findByName("Lady Geist")!), 4); // "Lady"; "LG" is an abbreviation and does not count
  assert.ok(spellingCost(kb.findByName("Diviner's Kevlar")!) <= "Kevlar".length);
});

test("aggregate: each signal drives the key when it has all the weight", () => {
  const ids = kb.items.slice(0, 6).map((e) => e.id);
  const ents = ids.map((id) => kb.get(id)!);
  const pass = { ranking: ids, perceptions: new Map() };
  const sortBy = (w: { llm: number; popularity: number; spelling: number }) =>
    [...aggregate(ents, [pass, pass, pass], w)].sort((a, b) => a.key - b.key || a.id.localeCompare(b.id)).map((s) => s.id);
  aggregate(ents, [pass], { llm: 1, popularity: 0, spelling: 0 }).forEach((s, i) => assert.ok(Math.abs(s.borda - i / 5) < 1e-9));
  assert.deepEqual(sortBy({ llm: 1, popularity: 0, spelling: 0 }), ids);
  const byPopularity = [...ents].sort((a, b) => (b.attributes.popularity ?? 0) - (a.attributes.popularity ?? 0)).map((e) => e.id);
  assert.equal(sortBy({ llm: 0, popularity: 1, spelling: 0 })[0], byPopularity[0]); // most bought = most obvious
});

test("refineOrder: boundary swaps only when inverted; contenders sorted by consistent wins", () => {
  const order = ["a", "b", "c", "d", "e", "f"];
  const out = refineOrder(order, [
    { a: "a", b: "b", rarer: "a", purpose: "tier-boundary" }, // inverted -> swap
    { a: "b", b: "c", rarer: "c", purpose: "tier-boundary" }, // already fine
    { a: "d", b: "e", rarer: "d", purpose: "rare-contenders" },
    { a: "d", b: "f", rarer: "d", purpose: "rare-contenders" },
    { a: "e", b: "f", rarer: null, purpose: "rare-contenders" },
  ]);
  assert.deepEqual(out, ["b", "a", "c", "e", "f", "d"]);
});

test("deterministic candidates: pools match their predicates and bounds", () => {
  const qs = deterministicCandidates(kb);
  const cost = qs.find((q) => q.signature === "item-cost:3200")!;
  assert.deepEqual(cost.answerIds, kb.items.filter((i) => i.attributes.cost === 3200).map((i) => i.id).sort());
  for (const q of qs) {
    assert.ok(q.answerIds.length >= 5 && q.answerIds.length <= 60, q.signature);
    for (const id of q.answerIds) assert.equal(kb.get(id)!.type, q.entityType, q.signature);
  }
  assert.equal(new Set(qs.map((q) => q.signature)).size, qs.length);
});

/** Fake LLM: ranks alphabetically, judges the alphabetically later name rarer, raises no review challenges. */
function fakeAsk(
  semanticYes: (name: string) => boolean = () => false,
  review: (prompt: string) => unknown[] = () => [],
): Ask & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async <T,>(o: AskOptions<T>): Promise<T> => {
    calls.push(o.label);
    const names = (s: string) => [...s.matchAll(/^- (.+?) - /gm)].map((m) => m[1]);
    let out: unknown;
    if (o.label.startsWith("rank:")) {
      const ns = names(o.prompt).sort();
      out = { perceptions: ns.map((name) => ({ name, perception: "x", fit: "neutral" })), ranking: ns };
    }
    else if (o.label.startsWith("pairwise:")) {
      out = { judgments: [...o.prompt.matchAll(/^Pair (\d+): (.+?) - .*\| (.+?) - /gm)].map((m) => ({ pair: +m[1], rarer: [m[2], m[3]].sort()[1] })) };
    } else if (o.label.startsWith("review:")) out = { challenges: review(o.prompt) };
    else if (o.label.startsWith("screen:")) out = { verdicts: kb.heroes.map((h) => ({ name: h.name, verdict: semanticYes(h.name) ? "yes" : "no" })) };
    else if (o.label.startsWith("verify:")) {
      const list = o.prompt.split("Candidates: ")[1]!.split(", ");
      out = { verdicts: list.map((name) => ({ name, verdict: "yes", evidence: kb.findByName(name)!.type === "hero" ? `${name} (hero)` : "" })) };
    } else throw new Error(`unexpected ${o.label}`);
    const parsed = o.schema.parse(out);
    const problem = o.validate?.(parsed);
    if (problem) throw new Error(`fake output invalid: ${problem}`);
    return parsed;
  }) as Ask & { calls: string[] };
  fn.calls = calls;
  return fn;
}

test("scoreQuestion end to end with a fake LLM", async () => {
  const q = deterministicCandidates(kb).find((x) => x.signature.startsWith("hero-stat:maxHealth"))!;
  const ask = fakeAsk();
  const s = await scoreQuestion(kb, ask, q);
  assert.equal(s.answers.length, q.answerIds.length);
  assert.deepEqual(s.answers.map((a) => a.entityId).sort(), [...q.answerIds].sort());
  assert.equal(s.answers.filter((a) => a.score === 100).length, 1);
  assert.equal(s.diagnostics.passAgreement, 1);
  // Alphabetical ranking is identical across passes, so the rarest is alphabetically last
  // (spelling may nudge the middle, but pairwise among the rarest also favours the later name).
  const lastName = s.answers.map((a) => a.name).sort().at(-1);
  assert.equal(s.answers.at(-1)!.name, lastName);
  assert.equal(ask.calls.filter((c) => c.startsWith("rank:")).length, 5);
  assert.equal(ask.calls.filter((c) => c.startsWith("review:")).length, 1);
});

test("semantic validation needs evidence that appears in the wiki text", async () => {
  const proposal = { prompt: "Name a hero ...", entityType: "hero" as const, category: "hero-ability-effect" as const, criterion: "test" };
  const yes = new Set(kb.heroes.slice(0, 6).map((h) => h.name));
  const r = await validateSemantic(kb, fakeAsk((n) => yes.has(n)), proposal);
  assert.ok(r.candidate, r.rejection ?? "");
  assert.equal(r.candidate!.answerIds.length, 6);
  const few = await validateSemantic(kb, fakeAsk((n) => n === kb.heroes[0].name), proposal);
  assert.equal(few.candidate, null);
});

test("item summaries include built-in stats even when the description is a side effect", () => {
  const leech = summary(kb.findByName("Leech")!);
  assert.match(leech, /Stats: .*Spirit Lifesteal 30.*Bullet Lifesteal 30/);
  assert.ok(leech.startsWith("Leech - Tier 4"));
});

test("review challenges backed by gameplay data are applied without a comparison", async () => {
  const q = deterministicCandidates(kb).find((x) => x.signature === "item-cost:6400")!;
  let picked: [string, string] | undefined;
  const ask = fakeAsk(undefined, (prompt) => {
    // Table lines: "1. Name - 10 pts". Pick an earlier (more obvious) item that is bought less than a later one.
    const names = [...prompt.matchAll(/^\d+\. (.+) - \d+ pts$/gm)].map((m) => m[1]);
    const pop = (n: string) => kb.findByName(n)!.attributes.popularity ?? 0;
    for (let i = 0; i < names.length && !picked; i++) {
      for (let j = i + 1; j < names.length; j++) if (pop(names[i]) < pop(names[j])) { picked = [names[i], names[j]]; break; }
    }
    return [{ name: picked![0], compareWith: picked![1], claim: "should_be_more_obscure", reason: "test" }];
  });
  const s = await scoreQuestion(kb, ask, q);
  assert.equal(s.diagnostics.review[0].outcome, "applied-by-data");
  const rank = (n: string) => s.answers.find((a) => a.name === n)!.rank;
  assert.ok(rank(picked![0]) > rank(picked![1]), "challenged answer moved below the one it was compared with");
  assert.equal(ask.calls.filter((c) => c.startsWith("pairwise:") ).length, 2, "only the regular pairwise round, no review comparison");
});
