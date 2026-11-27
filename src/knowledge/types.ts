export type Score = 10 | 30 | 60 | 85 | 100;

/** One displayed property of an ability or item, as shown on the in-game card. */
export interface Prop {
  key: string;
  label: string | null;
  /** Number, or display string with unit such as "12m". */
  value: number | string;
  type: string | null;
  /** Spirit/other scaling attached to the base value, if any. */
  scale?: { value: number; type: string };
  statusEffect?: string;
  /** True when the wiki marks the value as only conditionally applied. */
  conditional?: boolean;
  /** Section heading on the card, e.g. "On Hit:". */
  title?: string;
}

export interface AbilityUpgrade {
  tier: 1 | 2 | 3;
  description: string | null;
  /** Raw property deltas applied by this upgrade. */
  changes: Record<string, unknown>;
}

export interface Ability {
  key: string;
  name: string;
  /** 1-3 regular abilities, 4 = ultimate. */
  slot: 1 | 2 | 3 | 4;
  description: string;
  props: Prop[];
  upgrades: AbilityUpgrade[];
}

export interface Weapon {
  name: string | null;
  description: string | null;
  bulletDamagePerPellet: number;
  pelletsPerShot: number;
  roundsPerSecond: number;
  clipSize: number;
  reloadTime: number;
  reloadSingle: boolean;
  bulletSpeed: number;
  falloffStartRange: number;
  falloffEndRange: number;
  canCrit: boolean;
  dps: number;
  sustainedDps: number;
  /** e.g. "Spreadshot", "CloseRange". */
  weaponTypes: string[];
}

export interface HeroAttributes {
  internalKey: string;
  heroType: string | null;
  /** Wiki one-liner and playstyle blurb; context for ranking only, never a question source. */
  role: string | null;
  playstyle: string | null;
  maxHealth: number;
  baseHealthRegen: number;
  maxMoveSpeed: number;
  sprintSpeed: number;
  stamina: number;
  staminaCooldown: number;
  lightMeleeDamage: number;
  heavyMeleeDamage: number;
  weapon: Weapon;
  /** Per-level gains (boons), raw keys from wiki. */
  levelScaling: Record<string, number>;
  /** Wiki categories such as "Heroes with spin up weapons". */
  categories: string[];
  abilities: Ability[];
  /** % of matches (Deadlock API, experienced-rank matches) that include this hero; null if absent. */
  popularity: number | null;
}

export type ItemSlot = "Weapon" | "Vitality" | "Spirit";

export interface ItemSection {
  /** "Innate", "Passive", "Active", ... */
  kind: string;
  description: string | null;
  cooldown: number | null;
  props: Prop[];
}

export interface ItemAttributes {
  internalKey: string;
  cost: number;
  /** 1-4 in the main mode; 5 = Street Brawl exclusive. */
  tier: 1 | 2 | 3 | 4 | 5;
  slot: ItemSlot;
  /** "Passive", "InstantCast", "Press", ... */
  activation: string;
  isActive: boolean;
  isImbue: boolean;
  /** Street Brawl mode-exclusive item; excluded from main-mode questions. */
  streetBrawl: boolean;
  /** Entity ids this item upgrades from. */
  components: string[];
  /** Entity ids that use this item as a component. */
  upgradesInto: string[];
  description: string;
  sections: ItemSection[];
  statusEffects: string[];
  /** % of players (Deadlock API, experienced-rank matches) who bought it; null if absent from the stats. */
  popularity: number | null;
}

interface EntityBase {
  id: string;
  name: string;
  aliases: string[];
  sourceUrls: string[];
}

export interface Hero extends EntityBase {
  type: "hero";
  attributes: HeroAttributes;
}

export interface Item extends EntityBase {
  type: "item";
  attributes: ItemAttributes;
}

export type Entity = Hero | Item;

export interface KnowledgeFile {
  knowledgeVersion: string;
  generatedFrom: Record<string, number>; // data page -> revision id
  entities: Entity[];
}

export type EntityType = Entity["type"];

/** A question with its complete, validated answer pool, before rarity scoring. */
export interface CandidateQuestion {
  /** Stable identity used to avoid repeats, e.g. "item-cost:3200". */
  signature: string;
  prompt: string;
  category: string;
  entityType: EntityType;
  answerIds: string[];
  validation: {
    method: "deterministic" | "llm";
    /** The exact rule answers were checked against. */
    criterion: string;
    notes?: string[];
  };
}

export interface ScoredAnswer {
  entityId: string;
  /** 1 = most obvious. */
  rank: number;
  score: Score;
}

export interface Question {
  id: string;
  prompt: string;
  category: string;
  entityType: EntityType;
  answers: ScoredAnswer[];
}

export interface DailyGame {
  date: string;
  questions: Question[];
  knowledgeVersion: string;
  scoringVersion: string;
}
