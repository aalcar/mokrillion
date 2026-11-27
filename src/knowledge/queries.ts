import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeName } from "./normalize.ts";
import type { Entity, Hero, Item, KnowledgeFile } from "./types.ts";

export interface Knowledge {
  version: string;
  entities: Entity[];
  heroes: Hero[];
  /** Main-mode items only. */
  items: Item[];
  streetBrawlItems: Item[];
  get(id: string): Entity | undefined;
  /** Exact lookup by normalized canonical name or alias. Fuzzy matching lives in the game layer. */
  findByName(text: string): Entity | undefined;
}

export function buildKnowledge(file: KnowledgeFile): Knowledge {
  const byId = new Map(file.entities.map((e) => [e.id, e]));
  const byName = new Map<string, Entity>();
  for (const e of file.entities) {
    for (const n of [e.name, ...e.aliases].map(normalizeName)) {
      const prev = byName.get(n);
      if (prev && prev.id !== e.id) throw new Error(`name "${n}" maps to both ${prev.id} and ${e.id}`);
      byName.set(n, e);
    }
  }
  return {
    version: file.knowledgeVersion,
    entities: file.entities,
    heroes: file.entities.filter((e): e is Hero => e.type === "hero"),
    items: file.entities.filter((e): e is Item => e.type === "item" && !e.attributes.streetBrawl),
    streetBrawlItems: file.entities.filter((e): e is Item => e.type === "item" && e.attributes.streetBrawl),
    get: (id) => byId.get(id),
    findByName: (text) => byName.get(normalizeName(text)),
  };
}

export const loadKnowledge = (path = join(import.meta.dirname, "../../data/entities.json")): Knowledge =>
  buildKnowledge(JSON.parse(readFileSync(path, "utf8")));
