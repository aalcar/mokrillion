// Converts the raw wiki snapshot (data/raw/) into data/entities.json.
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ability, Entity, Hero, Item, ItemSection, ItemSlot, KnowledgeFile, Prop } from "./types.ts";

export interface Raw {
  heroData: Record<string, any>;
  itemData: Record<string, any>;
  abilityCards: Record<string, any>;
  itemCards: Record<string, any>;
  lang: Record<string, string>;
  popularity: Record<string, any>;
  latestUpdate: { latest_update: { year: number; month: string; day: number } };
  categories: Record<string, string[]>;
  redirects: Record<string, string[]>;
  revisions: Record<string, number>;
  /** Manual alias overlay: entity id -> additions/removals. */
  aliasOverlay: Record<string, { add?: string[]; remove?: string[] }>;
  /** Hash of the raw files, for knowledgeVersion. */
  rawHash: string;
}

const WIKI = "https://deadlock.wiki";
const pageUrl = (title: string) => `${WIKI}/${encodeURIComponent(title.replace(/ /g, "_"))}`;
const SLOT: Record<string, ItemSlot> = { Weapon: "Weapon", Armor: "Vitality", Tech: "Spirit" };

/** Lowercase, strip accents/punctuation, "&" -> "and", collapse whitespace. Used for all name matching. */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const humanize = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");

/** Wiki/game rich text -> plain text. Inline attribute placeholders become their readable names. */
export function cleanText(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/\{\w:[^}]*?'(\w+)'\}/g, (_, k) => humanize(k))
    .replace(/\{\w:(\w+)\}/g, (_, k) => humanize(k))
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const langText = (lang: Record<string, string>, key: string | null | undefined) =>
  key ? cleanText(lang[key.replace(/^#/, "")]) || null : null;

function toProp(p: any, lang: Record<string, string>): Prop {
  const prop: Prop = {
    key: p.Key,
    label: p.Name ?? lang[`${p.Key}_label`] ?? null,
    value: p.Value,
    type: p.Type ?? null,
  };
  if (p.Scale && typeof p.Scale.Value === "number") prop.scale = { value: p.Scale.Value, type: p.Scale.Type };
  if (p.StatusEffect) prop.statusEffect = p.StatusEffect;
  if (typeof p.UsageFlags === "string" && p.UsageFlags.includes("Conditional")) prop.conditional = true;
  if (p.Title) prop.title = p.Title;
  return prop;
}

/** Fallback text for upgrades without a description string, e.g. "Cooldown -20". */
function describeChanges(changes: Record<string, any>, props: Prop[]): string {
  return Object.entries(changes)
    .map(([k, v]) => {
      const label = props.find((p) => p.key === k)?.label ?? humanize(k);
      const n = typeof v === "number" ? v : v?.Value;
      return `${label} ${n > 0 ? "+" : ""}${n}`;
    })
    .join(", ");
}

function buildAbility(card: any, slot: 1 | 2 | 3 | 4, lang: Record<string, string>): Ability {
  const props: Prop[] = [];
  for (const info of Object.keys(card).filter((k) => /^Info\d+$/.test(k)).map((k) => card[k])) {
    for (const p of [...(info?.Main?.Props ?? []), ...(info?.Alt ?? [])]) if (p.Value !== 0) props.push(toProp(p, lang));
  }
  for (const [key, h] of Object.entries<any>(card.Headers ?? {})) {
    if (typeof h.Value === "number" && h.Value > 0 && !props.some((p) => p.key === key)) {
      props.push(toProp({ ...h, Key: key }, lang));
    }
  }
  return {
    key: card.Key,
    name: card.Name,
    slot,
    description:
      langText(lang, card.DescKey) ??
      Object.keys(card).filter((k) => /^Info\d+$/.test(k)).map((k) => langText(lang, card[k]?.DescKey)).filter(Boolean).join(" "),
    props,
    upgrades: (card.Upgrades ?? []).map((u: any, i: number) => {
      const { DescKey, ...changes } = u;
      return { tier: (i + 1) as 1 | 2 | 3, description: langText(lang, DescKey) ?? describeChanges(changes, props), changes };
    }),
  };
}

const isAbbreviation = (s: string) => /^[A-Z0-9]{2,5}$/.test(s);

/** Abbreviations from the game's shop search string, e.g. "Extended Magazine XM EM Ext Mag" -> ["XM", "EM"]. */
function searchAliases(lang: Record<string, string>, key: string): string[] {
  return (lang[`${key}_search`] ?? "").split(/\s+/).filter(isAbbreviation);
}

function itemPopularity(popularity: Record<string, any>): Map<string, number> {
  const sums = new Map<string, number>();
  let slots = 0;
  for (const hero of Object.values<any>(popularity)) {
    for (const phase of Object.values<any>(hero.phases ?? {})) {
      slots++;
      for (const [item, [pickRate]] of Object.entries<any>(phase)) sums.set(item, (sums.get(item) ?? 0) + pickRate);
    }
  }
  return new Map([...sums].map(([k, v]) => [k, Math.round((v / slots) * 100) / 100]));
}

export function normalize(raw: Raw): KnowledgeFile {
  const { lang } = raw;
  const heroPages = new Set(raw.categories.Heroes ?? []);
  const itemPages = new Set(raw.categories.Items ?? []);
  const traitCats = Object.keys(raw.categories).filter((c) => c !== "Heroes" && c !== "Items");
  const dataUrl = (page: string) => `${WIKI}/Data:${page.replace(/ /g, "_")}.json`;

  const entities: Entity[] = [];
  const titleOf = new Map<string, string>(); // entity id -> wiki page title

  for (const [key, h] of Object.entries<any>(raw.heroData)) {
    if (h.IsDisabled || !h.Name || !heroPages.has(h.Name)) continue;
    const cards = raw.abilityCards[key] ?? {};
    const abilities = ([1, 2, 3, 4] as const)
      .filter((s) => cards[s])
      .map((s) => buildAbility(cards[s], s, lang));
    const w = h.Weapon ?? {};
    const hero: Hero = {
      id: key,
      name: h.Name,
      type: "hero",
      aliases: [],
      sourceUrls: [pageUrl(h.Name), dataUrl("HeroData"), dataUrl("AbilityCards")],
      attributes: {
        internalKey: key,
        heroType: h.Type ?? null,
        maxHealth: h.MaxHealth,
        baseHealthRegen: h.BaseHealthRegen,
        maxMoveSpeed: h.MaxMoveSpeed,
        sprintSpeed: h.SprintSpeed,
        stamina: h.Stamina,
        staminaCooldown: Math.round(h.StaminaCooldown * 100) / 100,
        lightMeleeDamage: h.LightMeleeDamage,
        heavyMeleeDamage: h.HeavyMeleeDamage,
        weapon: {
          bulletDamagePerPellet: w.BulletDamage,
          pelletsPerShot: w.BulletsPerShot,
          roundsPerSecond: w.RoundsPerSecond,
          clipSize: w.ClipSize,
          reloadTime: w.ReloadTime,
          reloadSingle: !!w.ReloadSingle,
          bulletSpeed: w.BulletSpeed,
          falloffStartRange: w.FalloffStartRange,
          falloffEndRange: w.FalloffEndRange,
          canCrit: w.CanCrit !== false,
          dps: w.DPS,
          sustainedDps: w.SustainedDPS,
          weaponTypes: (w.WeaponTypes ?? []).map((t: string) => t.replace("Attribute_EWeaponAttribute_", "")),
        },
        levelScaling: h.LevelScaling ?? {},
        categories: traitCats.filter((c) => raw.categories[c].includes(h.Name)),
        abilities,
      },
    };
    entities.push(hero);
    titleOf.set(key, h.Name);
  }

  const pop = itemPopularity(raw.popularity);
  const items: Item[] = [];
  for (const [key, it] of Object.entries<any>(raw.itemData)) {
    if (it.IsDisabled || it.StreetBrawl || !it.Name || !it.Cost || ![1, 2, 3, 4].includes(it.Tier)) continue;
    const title = [it.Name, `${it.Name} (item)`].find((t) => itemPages.has(t));
    if (!title || !SLOT[it.Slot]) continue;
    const card = raw.itemCards[key] ?? {};
    const sections: ItemSection[] = Object.keys(card)
      .filter((k) => /^Info\d+$/.test(k))
      .map((k) => card[k])
      .map((info: any) => ({
        // Untyped info blocks on passive items are the passive effect.
        kind: info.Type ?? (it.Activation === "Passive" ? "Passive" : "Unknown"),
        description: langText(lang, info.DescKey),
        cooldown: typeof info.Cooldown === "number" ? info.Cooldown : null,
        props: [...(info.Main ?? []), ...(info.Alt ?? [])].filter((p: any) => p.Value !== 0).map((p: any) => toProp(p, lang)),
      }));
    const description =
      cleanText(it.Description) || sections.map((s) => s.description).filter(Boolean).join(" ");
    items.push({
      id: key,
      name: it.Name,
      type: "item",
      aliases: [],
      sourceUrls: [pageUrl(title), dataUrl("ItemData"), dataUrl("ItemCards")],
      attributes: {
        internalKey: key,
        cost: it.Cost,
        tier: it.Tier,
        slot: SLOT[it.Slot],
        activation: it.Activation,
        isActive: it.Activation !== "Passive",
        isImbue: !!it.IsImbue,
        components: it.Components ?? [],
        upgradesInto: [],
        description,
        sections,
        statusEffects: [...new Set(sections.flatMap((s) => s.props.map((p) => p.statusEffect).filter((x): x is string => !!x)))],
        popularity: pop.get(key) ?? null,
      },
    });
    titleOf.set(key, title);
  }

  // Keep only component links to live items, then build reverse links.
  const itemIds = new Set(items.map((i) => i.id));
  for (const item of items) item.attributes.components = item.attributes.components.filter((c) => itemIds.has(c));
  for (const item of items) {
    for (const c of item.attributes.components) {
      items.find((i) => i.id === c)!.attributes.upgradesInto.push(item.id);
    }
  }
  entities.push(...items);

  assignAliases(entities, raw, titleOf);

  const d = raw.latestUpdate.latest_update;
  const month = new Date(`${d.month} 1, 2000`).getMonth() + 1;
  const date = `${d.year}-${String(month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  return { knowledgeVersion: `${date}-${raw.rawHash.slice(0, 8)}`, generatedFrom: raw.revisions, entities };
}

/**
 * Aliases = wiki redirects + shop search abbreviations + manual overlay.
 * Hero redirects are mostly jokes/lore names, so for heroes only abbreviations and
 * name fragments ("Geist", "Harrow") are kept; item redirects are mostly former item
 * names and are kept unless removed in the overlay.
 * A candidate is dropped if it collides with any canonical entity name, any ability name,
 * or is claimed by more than one entity, so aliases never resolve ambiguously.
 */
function assignAliases(entities: Entity[], raw: Raw, titleOf: Map<string, string>) {
  const unknown = Object.keys(raw.aliasOverlay).filter((id) => !titleOf.has(id));
  if (unknown.length) throw new Error(`aliases.json references unknown entity ids: ${unknown.join(", ")}`);
  const canonical = new Set(entities.map((e) => normalizeName(e.name)));
  const abilityNames = new Set(
    entities.flatMap((e) => (e.type === "hero" ? e.attributes.abilities.map((a) => normalizeName(a.name)) : [])),
  );
  const candidates = new Map<string, string[]>(); // entity id -> raw alias candidates
  for (const e of entities) {
    const nameWords = new Set(normalizeName(e.name).split(" "));
    const redirects = (raw.redirects[titleOf.get(e.id)!] ?? []).filter(
      (a) => e.type === "item" || isAbbreviation(a) || normalizeName(a).split(" ").every((w) => nameWords.has(w)),
    );
    const list = [...redirects, ...searchAliases(raw.lang, e.id)];
    candidates.set(e.id, list);
  }
  const claims = new Map<string, Set<string>>();
  for (const [id, list] of candidates) {
    for (const a of list) {
      const n = normalizeName(a);
      if (!claims.has(n)) claims.set(n, new Set());
      claims.get(n)!.add(id);
    }
  }
  for (const e of entities) {
    const overlay = raw.aliasOverlay[e.id] ?? {};
    const removed = new Set((overlay.remove ?? []).map(normalizeName));
    const kept = new Map<string, string>();
    for (const a of candidates.get(e.id)!) {
      const n = normalizeName(a);
      if (!n || canonical.has(n) || abilityNames.has(n) || claims.get(n)!.size > 1 || removed.has(n)) continue;
      if (!kept.has(n)) kept.set(n, a);
    }
    for (const a of overlay.add ?? []) kept.set(normalizeName(a), a); // manual additions are trusted
    e.aliases = [...kept.values()].sort();
  }
}

const RAW_DIR = join(import.meta.dirname, "../../data/raw");
const DATA_DIR = join(import.meta.dirname, "../../data");

export async function loadRaw(dir = RAW_DIR): Promise<Raw> {
  const read = async (f: string) => JSON.parse(await readFile(join(dir, f), "utf8"));
  const hash = createHash("sha256");
  for (const f of (await readdir(dir)).filter((f) => f !== "manifest.json").sort()) {
    hash.update(f).update(await readFile(join(dir, f)));
  }
  const manifest = await read("manifest.json");
  return {
    heroData: await read("HeroData.json"),
    itemData: await read("ItemData.json"),
    abilityCards: await read("AbilityCards.json"),
    itemCards: await read("ItemCards.json"),
    lang: await read("Lang_en.json"),
    popularity: await read("ItemPopularity.json"),
    latestUpdate: await read("LatestUpdate.json"),
    categories: await read("categories.json"),
    redirects: await read("redirects.json"),
    revisions: manifest.revisions,
    aliasOverlay: JSON.parse(await readFile(join(DATA_DIR, "aliases.json"), "utf8")),
    rawHash: hash.digest("hex"),
  };
}

if (import.meta.filename === process.argv[1]) {
  const kb = normalize(await loadRaw());
  await writeFile(join(DATA_DIR, "entities.json"), JSON.stringify(kb, null, 1));
  const count = (t: string) => kb.entities.filter((e) => e.type === t).length;
  console.log(`knowledge ${kb.knowledgeVersion}: ${count("hero")} heroes, ${count("item")} items`);
}
