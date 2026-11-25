// Knowledge-base inspection CLI.
//   npm run kb -- stats
//   npm run kb -- show "Armor Piercer"
//   npm run kb -- where item cost=3200 slot=Spirit
//   npm run kb -- where hero maxHealth>800 weapon.clipSize<20
import { loadKnowledge } from "../knowledge/queries.ts";
import type { Entity } from "../knowledge/types.ts";

const kb = loadKnowledge();
const [cmd, ...args] = process.argv.slice(2);

const lookup = (obj: any, path: string) => path.split(".").reduce((o, k) => o?.[k], obj);

function matches(e: Entity, cond: string): boolean {
  const m = cond.match(/^([\w.]+)(>=|<=|!=|=|>|<)(.*)$/);
  if (!m) throw new Error(`bad condition: ${cond}`);
  const [, path, op, rawValue] = m;
  const actual = lookup(e.attributes, path);
  const want: unknown = rawValue === "true" ? true : rawValue === "false" ? false : isNaN(+rawValue) ? rawValue : +rawValue;
  if (Array.isArray(actual)) return op === "=" ? actual.includes(want) : !actual.includes(want);
  switch (op) {
    case "=": return actual === want;
    case "!=": return actual !== want;
    case ">": return actual > (want as number);
    case "<": return actual < (want as number);
    case ">=": return actual >= (want as number);
    case "<=": return actual <= (want as number);
  }
  return false;
}

if (cmd === "stats") {
  console.log(`knowledge ${kb.version}: ${kb.heroes.length} heroes, ${kb.items.length} items`);
  const counts = new Map<string, number>();
  for (const i of kb.items) {
    const k = `T${i.attributes.tier} ${i.attributes.slot} (${i.attributes.cost})`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...counts].sort()) console.log(`  ${k}: ${n}`);
} else if (cmd === "show") {
  const e = kb.findByName(args.join(" ")) ?? kb.get(args[0]);
  if (!e) throw new Error(`no entity named "${args.join(" ")}"`);
  console.log(JSON.stringify(e, null, 2));
} else if (cmd === "where") {
  const [type, ...conds] = args;
  const hits = kb.entities.filter((e) => e.type === type && conds.every((c) => matches(e, c)));
  for (const e of hits) console.log(`${e.id}\t${e.name}`);
  console.log(`${hits.length} matches`);
} else {
  console.log("usage: kb stats | kb show <name> | kb where <hero|item> <path><op><value>...");
}
