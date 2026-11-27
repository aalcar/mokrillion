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
  "Heroes that don't deal critical damage": "Name a hero whose bullets can't deal critical (headshot) damage.",
  "Heroes with burst weapons": "Name a hero whose weapon fires in bursts.",
  "Heroes with alternate fire weapons": "Name a hero whose weapon has an alternate fire mode.",
  "Heroes with spin up weapons": "Name a hero whose weapon spins up (fires faster the longer you shoot).",
  "Heroes with single reload weapons": "Name a hero whose weapon reloads one shell at a time.",
  "Heroes with 4 stamina": "Name a hero who has 4 base stamina.",
  "Heroes with modified crit scale": "Name a hero whose headshots deal a non-standard crit bonus (higher or lower than normal).",
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

/** Letters of a name for spelling questions: lowercase a-z only, leading "The " dropped ("The Doorman" -> "doorman"). */
export function nameLetters(name: string): string {
  return name.toLowerCase().replace(/^the /, "").replace(/[^a-z]/g, "");
}

/** Questions about how names are spelled. Pools are kept small enough to be interesting. */
function nameQuestions(kb: Knowledge): Omit<CandidateQuestion, "validation">[] {
  const out: Omit<CandidateQuestion, "validation">[] = [];
  for (const type of ["hero", "item"] as const) {
    // Only hero names have a leading "The" (The Doorman) or symbols (Mo & Krill).
    const rule = type === "hero" ? ' Ignore a leading "The" and any symbols.' : "";
    const pool = type === "hero" ? kb.heroes : kb.items;
    const noun = type === "hero" ? "a hero" : "an item";
    const maxContains = type === "hero" ? 15 : 25;
    const q = (sig: string, prompt: string, match: (letters: string, name: string) => boolean) =>
      out.push({ signature: `name:${type}:${sig}`, prompt, category: "name-trivia", entityType: type,
        answerIds: pool.filter((e) => match(nameLetters(e.name), e.name)).map((e) => e.id) });
    for (const c of "abcdefghijklmnopqrstuvwxyz") {
      const C = c.toUpperCase();
      q(`starts:${c}`, `Name ${noun} whose name starts with the letter ${C}.${rule}`, (l) => l.startsWith(c));
      q(`ends:${c}`, `Name ${noun} whose name ends with the letter ${C}.${rule}`, (l) => l.endsWith(c));
      const contains = pool.filter((e) => nameLetters(e.name).includes(c)).length;
      if (contains <= maxContains) q(`contains:${c}`, `Name ${noun} whose name contains the letter ${C}.`, (l) => l.includes(c));
    }
    q("double-letter", `Name ${noun} whose name has the same letter twice in a row within a word (like the "ll" in "Billy").`,
      (_, name) => name.toLowerCase().split(/[^a-z]+/).some((w) => /([a-z])\1/.test(w)));
    const lengths = pool.map((e) => nameLetters(e.name).length).sort((a, b) => a - b);
    const short = lengths[Math.min(9, lengths.length - 1)];
    q(`short:${short}`, `Name ${noun} whose name has ${short} letters or fewer (letters only, not spaces or symbols).${type === "hero" ? ' Ignore a leading "The".' : ""}`, (l) => l.length <= short);
    if (type === "hero") q("multi-word", "Name a hero whose name is more than one word.", (_, name) => name.trim().split(/\s+/).length > 1);
    else q("one-word", "Name an item whose name is a single word.", (_, name) => !/\s/.test(name.trim()));
  }
  return out;
}

/** Spelling questions about hero weapon names; the hero name or the weapon name both count as an answer. */
function weaponNameQuestions(heroes: Hero[]): Omit<CandidateQuestion, "validation">[] {
  const out: Omit<CandidateQuestion, "validation">[] = [];
  const either = " (the hero or the weapon name both count)";
  const q = (sig: string, prompt: string, match: (weapon: string) => boolean) =>
    out.push({ signature: `weapon-name:${sig}`, prompt: prompt + either, category: "weapon-name", entityType: "hero",
      answerIds: heroes.filter((h) => h.attributes.weapon.name && match(h.attributes.weapon.name)).map((h) => h.id) });
  q("possessive", "Name a hero whose weapon's name has an 's (like Somebody's Something)", (n) => /'s\b/i.test(n));
  q("starts-the", 'Name a hero whose weapon\'s name starts with "The"', (n) => /^the /i.test(n));
  for (const c of "abcdefghijklmnopqrstuvwxyz") {
    // Weapon names are long, so only rare letters make a fair "contains" question.
    if (heroes.filter((h) => nameLetters(h.attributes.weapon.name ?? "").includes(c)).length > 10) continue;
    q(`contains:${c}`, `Name a hero whose weapon's name contains the letter ${c.toUpperCase()}`, (n) => nameLetters(n).includes(c));
  }
  return out;
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
  const heroThreshold = (key: string, get: (h: Hero) => number, dir: "high" | "low", text: (x: number) => string,
    category = "hero-base-stat", target = 10) => {
    // Round the cut-off the way the prompt shows it, so the prompt and the answer pool always agree.
    const raw = threshold(heroes.map(get), target, dir);
    const step = Math.abs(raw) >= 100 ? 1 : 10; // whole numbers for big values (bullet speed), one decimal otherwise
    const x = (dir === "high" ? Math.floor : Math.ceil)(raw * step) / step;
    const pool = heroes.filter((h) => (dir === "high" ? get(h) >= x : get(h) <= x));
    if (pool.length > 2 * target) return; // a big tie at the cut-off makes the question meaningless
    add({ signature: `hero-stat:${key}:${dir}:${x}`, prompt: text(x), category, entityType: "hero",
      answerIds: ids(pool) }, `${key} ${dir === "high" ? ">=" : "<="} ${x}`);
  };
  heroThreshold("maxHealth", (h) => h.attributes.maxHealth, "high",
    (x) => `Name a hero with at least ${x} base max health (level 1, no items or boons).`);
  heroThreshold("clipSize", (h) => h.attributes.weapon.clipSize, "high",
    (x) => `Name a hero whose base clip size is at least ${x} (no items or boons).`);
  heroThreshold("clipSize", (h) => h.attributes.weapon.clipSize, "low",
    (x) => `Name a hero whose base clip size is ${x} or fewer (no items or boons).`);

  heroThreshold("sprintSpeed", (h) => h.attributes.sprintSpeed, "high",
    (x) => `Name a hero with a base sprint speed of at least ${x} m/s.`);
  heroThreshold("maxMoveSpeed", (h) => h.attributes.maxMoveSpeed, "high",
    (x) => `Name a hero with a base move speed of at least ${x} m/s.`, "hero-base-stat", 8);
  heroThreshold("lightMeleeDamage", (h) => h.attributes.lightMeleeDamage, "high",
    (x) => `Name a hero whose base light melee deals at least ${x} damage.`, "hero-base-stat", 7);

  // Weapon stats ("hero-weapon"): answers are heroes, weapon names also accepted.
  const w = (h: Hero) => h.attributes.weapon;
  heroThreshold("roundsPerSecond", (h) => w(h).roundsPerSecond, "high",
    (x) => `Name a hero whose weapon fires at least ${x} rounds per second.`, "hero-weapon");
  heroThreshold("roundsPerSecond", (h) => w(h).roundsPerSecond, "low",
    (x) => `Name a hero whose weapon fires ${x} rounds per second or fewer.`, "hero-weapon");
  heroThreshold("bulletSpeed", (h) => w(h).bulletSpeed, "high",
    (x) => `Name a hero whose bullets travel at least ${x} m/s.`, "hero-weapon");
  heroThreshold("bulletSpeed", (h) => w(h).bulletSpeed, "low",
    (x) => `Name a hero whose bullets travel ${x} m/s or slower.`, "hero-weapon");
  heroThreshold("dps", (h) => w(h).dps, "high",
    (x) => `Name a hero whose base weapon DPS is at least ${x} (no items or boons).`, "hero-weapon");
  heroThreshold("dps", (h) => w(h).dps, "low",
    (x) => `Name a hero whose base weapon DPS is ${x} or lower (no items or boons).`, "hero-weapon");
  heroThreshold("bulletDamage", (h) => w(h).bulletDamagePerPellet, "high",
    (x) => `Name a hero whose base damage per bullet (or pellet) is at least ${x}.`, "hero-weapon");
  heroThreshold("falloffEndRange", (h) => w(h).falloffEndRange, "low",
    (x) => `Name a hero whose weapon damage fully falls off by ${x}m or less.`, "hero-weapon");

  for (const q of weaponNameQuestions(heroes)) add(q, `weapon name rule: ${q.signature}`);

  add({ signature: "item-imbue", prompt: "Name an item that imbues (permanently upgrades) one of your abilities.", category: "item-effect",
    entityType: "item", answerIds: ids(items.filter((i) => i.attributes.isImbue)) }, "isImbue");
  // Stat bonus within one slot, e.g. "a Vitality item with Spirit Power", when it narrows the stat question.
  for (const [label, list] of byLabel) for (const slot of ["Weapon", "Vitality", "Spirit"] as const) {
    const inSlot = list.filter((i) => i.attributes.slot === slot);
    if (inSlot.length === list.length || inSlot.length > 15) continue;
    add({ signature: `item-stat-slot:${label}:${slot}`, category: "item-stat-bonus", entityType: "item", answerIds: ids(inSlot),
      prompt: `Name a ${slot} item that gives a built-in ${label.replace(/^Bonus /, "")} bonus (not counting conditional, stacking or active effects).` },
      `slot == ${slot} && innate unconditional prop labelled "${label}" with value > 0`);
  }

  // Street Brawl mode-exclusive items.
  const sb = kb.streetBrawlItems;
  const sbQ = (sig: string, prompt: string, list: Item[], criterion: string) =>
    add({ signature: `street-brawl:${sig}`, prompt, category: "street-brawl", entityType: "item", answerIds: ids(list) }, criterion);
  sbQ("all", "Name an item that is only sold in Street Brawl.", sb, "streetBrawl");
  for (const slot of ["Weapon", "Vitality", "Spirit"] as const) {
    sbQ(`slot:${slot}`, `Name a ${slot} item that is only sold in Street Brawl.`, sb.filter((i) => i.attributes.slot === slot), `streetBrawl && slot == ${slot}`);
  }
  sbQ("active", "Name an item with an active ability that is only sold in Street Brawl.", sb.filter((i) => i.attributes.isActive), "streetBrawl && isActive");

  for (const q of nameQuestions(kb)) add(q, `name spelling rule: ${q.signature}`);

  return out.filter((q) => q.answerIds.length >= config.minPool && q.answerIds.length <= config.maxPool);
}
