import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanText, normalize, normalizeName, type Raw } from "../src/knowledge/normalize.ts";
import type { Hero, Item } from "../src/knowledge/types.ts";

const item = (over: Record<string, unknown>) => ({
  Name: "X", Description: null, Cost: 800, Tier: 1, Activation: "Passive", Slot: "Weapon",
  Components: null, IsDisabled: false, StreetBrawl: false, IsImbue: false, ...over,
});

function fixture(over: Partial<Raw> = {}): Raw {
  return {
    heroData: {
      hero_atlas: { Name: "Abrams", IsDisabled: false, MaxHealth: 800, Stamina: 3, StaminaCooldown: 4.5000045, Weapon: { BulletDamage: 3.78, BulletsPerShot: 9, WeaponTypes: ["Attribute_EWeaponAttribute_Spreadshot"] } },
      hero_ghost: { Name: "Lady Geist", IsDisabled: false, Weapon: {} },
      hero_testhero: { Name: "Test", IsDisabled: true, Weapon: {} },
      hero_werewolf_transformed: { Name: "Silver (Transformed)", IsDisabled: false, Weapon: {} },
    },
    itemData: {
      upgrade_basic: item({ Name: "Basic Mag", Description: '<span class="highlight">More</span> ammo &amp; stuff' }),
      upgrade_big: item({ Name: "Big Mag", Cost: 3200, Tier: 3, Slot: "Armor", Components: ["upgrade_basic", "upgrade_gone"] }),
      upgrade_gone: item({ Name: "Gone", IsDisabled: true }),
      upgrade_brawl: item({ Name: "Brawl Thing", StreetBrawl: true }),
      upgrade_t5: item({ Name: "Legend", Tier: 5, Cost: 9999 }),
      upgrade_lifesteal: item({ Name: "Bullet Lifesteal", Slot: "Tech" }),
    },
    abilityCards: {
      hero_atlas: {
        "1": { Key: "a1", Name: "Siphon Life", DescKey: "a1_desc",
          Info1: { Main: { Props: [{ Key: "DPS", Name: "Damage Per Second", Value: 22, Scale: { Value: 0.6, Type: "spirit" } }, { Key: "Unused", Value: 0 }] } },
          Upgrades: [{ AbilityCooldown: -20 }, { AbilityDuration: 2 }, { Radius: 2, DescKey: "a1_t3" }] },
      },
      hero_ghost: { "1": { Key: "g1", Name: "Essence Bomb", DescKey: "g1_desc", Upgrades: [] } },
    },
    itemCards: {
      upgrade_big: { Info1: { Type: "Active", DescKey: "#big_active", Cooldown: 30, Main: [{ Key: "StunDuration", Value: 1, StatusEffect: "Stun" }], Alt: [] } },
    },
    lang: {
      a1_desc: "Drain health, dealing {g:citadel_inline_attribute:'SpiritDPS'}.",
      a1_t3: "+2m Radius",
      g1_desc: "Bomb.",
      big_active: "Stun <b>enemies</b>.",
      upgrade_basic_search: "Basic Mag BM",
    },
    popularity: {
      hero_atlas: { phases: { early: { upgrade_basic: [40, 50] }, late: { upgrade_basic: [20, 50], upgrade_big: [10, 50] } } },
    },
    latestUpdate: { latest_update: { year: 2026, month: "November", day: 4 } },
    categories: {
      Heroes: ["Abrams", "Lady Geist", "Heroes"],
      Items: ["Basic Mag", "Big Mag", "Bullet Lifesteal (item)", "Brawl Thing", "Legend"],
      "Heroes with 3 stamina": ["Abrams"],
    },
    redirects: {
      "Lady Geist": ["Geist", "LG", "Grandma", "Essence Bomb"],
      "Basic Mag": ["Old Mag", "Shared"],
      "Big Mag": ["Shared", "Abrams"],
    },
    revisions: { "Data:HeroData.json": 1 },
    aliasOverlay: { upgrade_big: { add: ["Biggie"], remove: ["Gone Alias"] } },
    rawHash: "abcdef1234567890",
    ...over,
  };
}

const kb = normalize(fixture());
const get = (id: string) => kb.entities.find((e) => e.id === id);

test("filters unavailable heroes and items", () => {
  assert.deepEqual(kb.entities.map((e) => e.id).sort(),
    ["hero_atlas", "hero_ghost", "upgrade_basic", "upgrade_big", "upgrade_lifesteal"]);
});

test("version combines patch date and raw hash", () => {
  assert.equal(kb.knowledgeVersion, "2026-11-04-abcdef12");
});

test("item fields: slot mapping, html cleanup, components, reverse links", () => {
  const basic = get("upgrade_basic") as Item, big = get("upgrade_big") as Item;
  assert.equal(big.attributes.slot, "Vitality");
  assert.equal((get("upgrade_lifesteal") as Item).attributes.slot, "Spirit");
  assert.equal(basic.attributes.description, "More ammo & stuff");
  assert.deepEqual(big.attributes.components, ["upgrade_basic"]); // disabled component dropped
  assert.deepEqual(basic.attributes.upgradesInto, ["upgrade_big"]);
  assert.equal(big.attributes.description, "Stun enemies.");
  assert.deepEqual(big.attributes.statusEffects, ["Stun"]);
  assert.equal(big.attributes.isActive, false);
  assert.equal(big.attributes.sections[0].cooldown, 30);
});

test("item disambiguated page title is matched", () => {
  assert.ok(get("upgrade_lifesteal")!.sourceUrls[0].endsWith("Bullet_Lifesteal_(item)"));
});

test("popularity is mean pick rate over all hero phases", () => {
  assert.equal((get("upgrade_basic") as Item).attributes.popularity, 30);
  assert.equal((get("upgrade_big") as Item).attributes.popularity, 5);
  assert.equal((get("upgrade_lifesteal") as Item).attributes.popularity, null);
});

test("hero abilities: placeholders filled, zero props dropped, upgrade fallback text", () => {
  const h = get("hero_atlas") as Hero;
  const a = h.attributes.abilities[0];
  assert.equal(a.description, "Drain health, dealing Spirit DPS.");
  assert.deepEqual(a.props.map((p) => p.key), ["DPS"]);
  assert.deepEqual(a.props[0].scale, { value: 0.6, type: "spirit" });
  assert.deepEqual(a.upgrades.map((u) => u.description), ["Ability Cooldown -20", "Ability Duration +2", "+2m Radius"]);
  assert.deepEqual(h.attributes.weapon.weaponTypes, ["Spreadshot"]);
  assert.deepEqual(h.attributes.categories, ["Heroes with 3 stamina"]);
  assert.equal(h.attributes.staminaCooldown, 4.5);
});

test("aliases: hero jokes and ability names dropped, collisions dropped, overlay applied", () => {
  assert.deepEqual(get("hero_ghost")!.aliases, ["Geist", "LG"]);
  assert.deepEqual(get("upgrade_basic")!.aliases, ["BM", "Old Mag"]);
  assert.deepEqual(get("upgrade_big")!.aliases, ["Biggie"]); // "Shared" ambiguous, "Abrams" is canonical
});

test("unknown overlay ids are rejected", () => {
  assert.throws(() => normalize(fixture({ aliasOverlay: { upgrade_typo: { add: ["x"] } } })), /upgrade_typo/);
});

test("normalizeName and cleanText", () => {
  assert.equal(normalizeName("  Mo & Krill "), "mo and krill");
  assert.equal(normalizeName("Diviner’s Kevlar"), "diviners kevlar");
  assert.equal(normalizeName("High-Velocity Rounds"), "high velocity rounds");
  assert.equal(cleanText("a<br/>b {s:BonusHealth} &nbsp; c"), "a b Bonus Health c");
});
