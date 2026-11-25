// Sanity checks on the committed knowledge snapshot (data/entities.json).
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadKnowledge } from "../src/knowledge/queries.ts";

const kb = loadKnowledge(); // throws if any name/alias maps to two entities

test("entity counts are plausible", () => {
  assert.ok(kb.heroes.length >= 40 && kb.heroes.length <= 60, `heroes: ${kb.heroes.length}`);
  assert.ok(kb.items.length >= 140 && kb.items.length <= 200, `items: ${kb.items.length}`);
});

test("every hero has 4 described abilities", () => {
  for (const h of kb.heroes) {
    assert.equal(h.attributes.abilities.length, 4, h.name);
    for (const a of h.attributes.abilities) assert.ok(a.description, `${h.name}: ${a.name}`);
  }
});

test("item links resolve and costs match tiers", () => {
  const cost = { 1: 800, 2: 1600, 3: 3200, 4: 6400 };
  for (const i of kb.items) {
    for (const c of [...i.attributes.components, ...i.attributes.upgradesInto]) assert.ok(kb.get(c), `${i.name} -> ${c}`);
    assert.equal(i.attributes.cost, cost[i.attributes.tier], i.name);
  }
});

test("known facts and aliases", () => {
  const abrams = kb.findByName("abrams")!;
  assert.equal(abrams.type === "hero" && abrams.attributes.maxHealth, 800);
  assert.equal(kb.findByName("Geist")?.name, "Lady Geist");
  assert.equal(kb.findByName("apr")?.name, "Armor Piercer");
  assert.equal(kb.findByName("mo and krill")?.name, "Mo & Krill");
});
