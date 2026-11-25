// Deterministic question families: answer pools come straight from predicates over the knowledge base.
import { config } from "../config.ts";
import type { Knowledge } from "../knowledge/queries.ts";
import type { CandidateQuestion, Hero, Item } from "../knowledge/types.ts";

const souls = (n: number) => n.toLocaleString("en-US");

/** Wiki hero categories that make fair questions, with player-facing wording. */
const HERO_CATEGORIES: Record<string, string> = {
  "Heroes with spreadshot weapons": "Name a hero whose weapon is a spreadshot (fires multiple pellets per shot).",
  "Heroes with automatic weapons": "Name a hero with a fully automatic weapon.",
  "Heroes with 2 stamina": "Name a hero who has only 2 base stamina.",
  "Heroes with fast dash speed": "Name a hero with fast dash speed.",
  "Heroes with slow dash speed": "Name a hero with slow dash speed.",
  "Heroes with boon scaling abilities": "Name a hero with an ability that scales with boons (hero level).",
  "Heroes with melee scaling abilities": "Name a hero with an ability that scales with melee damage.",
  "Heroes with weapon scaling abilities": "Name a hero with an ability that scales with weapon damage.",
  // The wiki category mixes heroes with non-default base Spirit Resist (Lash, Baba, Pocket) and heroes who start
  // at the default but gain extra Spirit Resist as they level (McGinnis, Kelvin, Venator), so the wording covers both.
  "Heroes with modified spirit resist":
    "Name a hero whose Spirit Resist differs from a standard hero's, either at base or in how it grows as they level up.",
};

/** Numeric value of a card prop such as 12, "0.75m" or "20%"; null if not numeric. */
export function numericValue(v: number | string): number | null {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Labels of the always-on (innate, unconditional, positive) stat bonuses an item gives. */
export function innateStatLabels(item: Item): string[] {
  const labels = new Set<string>();
  for (const s of item.attributes.sections) {
    if (s.kind !== "Innate") continue;
    for (const p of s.props) {
      const v = numericValue(p.value);
      if (p.label && !p.conditional && v !== null && v > 0) labels.add(p.label);
    }
  }
  return [...labels];
}

/** Threshold so that roughly `target` heroes qualify (ties included). */
function threshold(values: number[], target: number, direction: "high" | "low"): number {
  const sorted = [...values].sort((a, b) => (direction === "high" ? b - a : a - b));
  return sorted[Math.min(target, sorted.length) - 1];
}

export function deterministicCandidates(kb: Knowledge): CandidateQuestion[] {
  const out: CandidateQuestion[] = [];
  const add = (q: Omit<CandidateQuestion, "validation">, criterion: string) =>
    out.push({ ...q, answerIds: [...q.answerIds].sort(), validation: { method: "deterministic", criterion } });
  const items = kb.items, heroes = kb.heroes;
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  for (const cost of [...new Set(items.map((i) => i.attributes.cost))].sort((a, b) => a - b)) {
    add({ signature: `item-cost:${cost}`, prompt: `Name an item that costs ${souls(cost)} souls.`, category: "item-cost",
      entityType: "item", answerIds: ids(items.filter((i) => i.attributes.cost === cost)) }, `cost == ${cost}`);
  }
  for (const slot of ["Weapon", "Vitality", "Spirit"] as const) {
    for (const tier of [1, 2, 3, 4]) {
      add({ signature: `item-slot-tier:${slot}:${tier}`, prompt: `Name a Tier ${tier} ${slot} item.`, category: "item-cost",
        entityType: "item", answerIds: ids(items.filter((i) => i.attributes.slot === slot && i.attributes.tier === tier)) },
        `slot == ${slot} && tier == ${tier}`);
    }
    add({ signature: `item-active:${slot}`, prompt: `Name a ${slot} item with an active ability.`, category: "item-effect",
      entityType: "item", answerIds: ids(items.filter((i) => i.attributes.slot === slot && i.attributes.isActive)) },
      `slot == ${slot} && activation != Passive`);
    add({ signature: `item-component:${slot}`, prompt: `Name a ${slot} item that is a component of (upgrades into) another item.`,
      category: "item-upgrade-path", entityType: "item",
      answerIds: ids(items.filter((i) => i.attributes.slot === slot && i.attributes.upgradesInto.length)) },
      `slot == ${slot} && upgradesInto non-empty`);
  }
  const byLabel = new Map<string, Item[]>();
  for (const i of items) for (const l of innateStatLabels(i)) byLabel.set(l, [...(byLabel.get(l) ?? []), i]);
  for (const [label, list] of byLabel) {
    add({ signature: `item-stat:${label}`, category: "item-stat-bonus", entityType: "item", answerIds: ids(list),
      prompt: `Name an item that gives a built-in ${label.replace(/^Bonus /, "")} bonus (not counting conditional, stacking or active effects).` },
      `innate unconditional prop labelled "${label}" with value > 0`);
  }

  for (const [cat, prompt] of Object.entries(HERO_CATEGORIES)) {
    add({ signature: `hero-category:${cat}`, prompt, category: "hero-weapon", entityType: "hero",
      answerIds: ids(heroes.filter((h) => h.attributes.categories.includes(cat))) }, `in wiki category "${cat}"`);
  }
  const heroThreshold = (key: string, get: (h: Hero) => number, dir: "high" | "low", text: (x: number) => string) => {
    const x = threshold(heroes.map(get), 10, dir);
    const pool = heroes.filter((h) => (dir === "high" ? get(h) >= x : get(h) <= x));
    add({ signature: `hero-stat:${key}:${dir}:${x}`, prompt: text(x), category: "hero-base-stat", entityType: "hero",
      answerIds: ids(pool) }, `${key} ${dir === "high" ? ">=" : "<="} ${x}`);
  };
  heroThreshold("maxHealth", (h) => h.attributes.maxHealth, "high",
    (x) => `Name a hero with at least ${x} base max health (level 1, no items or boons).`);
  heroThreshold("clipSize", (h) => h.attributes.weapon.clipSize, "high",
    (x) => `Name a hero whose base clip size is at least ${x} (no items or boons).`);
  heroThreshold("clipSize", (h) => h.attributes.weapon.clipSize, "low",
    (x) => `Name a hero whose base clip size is ${x} or fewer (no items or boons).`);

  return out.filter((q) => q.answerIds.length >= config.minPool && q.answerIds.length <= config.maxPool);
}
