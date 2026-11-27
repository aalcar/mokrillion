// Question pipeline CLI. Every step writes inspectable JSON under data/.
//   npm run questions -- list
//   npm run questions -- propose item 8        (LLM: propose + validate semantic questions)
//   npm run questions -- score item-cost:3200  (LLM: rank + score; or "score 12" by list index)
//   npm run questions -- score-new [N]         (LLM: score every question not saved yet, or the first N)
//   npm run questions -- show item-cost:3200   (or "show 12" by list index)
// Add --no-cache to force fresh LLM calls (e.g. to measure ranking stability).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deterministicCandidates } from "../generation/templates.ts";
import { proposeSemantic, validateSemantic, type Proposal } from "../generation/semantic.ts";
import { loadKnowledge } from "../knowledge/queries.ts";
import type { CandidateQuestion, EntityType } from "../knowledge/types.ts";
import { createAsk, usageSummary } from "../llm.ts";
import { applyOverride, loadOverrides, OVERRIDES_FILE, scoreQuestion, type ScoredQuestion } from "../scoring/rank.ts";

const DATA = join(import.meta.dirname, "../../data");
const SEMANTIC_FILE = join(DATA, "candidates/semantic.json");
const QUESTIONS_DIR = join(DATA, "questions");

interface SemanticFile {
  accepted: CandidateQuestion[];
  rejected: { proposal: Proposal; reason: string; notes: string[] }[];
}

const args = process.argv.slice(2).filter((a) => a !== "--no-cache");
const ask = createAsk({ useCache: !process.argv.includes("--no-cache") });
const kb = loadKnowledge();
const slug = (sig: string) => sig.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const questionFile = (sig: string) => join(QUESTIONS_DIR, `${slug(sig)}.json`);

function readSemantic(): SemanticFile {
  return existsSync(SEMANTIC_FILE) ? JSON.parse(readFileSync(SEMANTIC_FILE, "utf8")) : { accepted: [], rejected: [] };
}

function allCandidates(): CandidateQuestion[] {
  return [...deterministicCandidates(kb), ...readSemantic().accepted];
}

/** A candidate by its `list` index or its signature. */
function findCandidate(arg: string): CandidateQuestion {
  const all = allCandidates();
  const q = /^\d+$/.test(arg) ? all[Number(arg)] : all.find((x) => x.signature === arg);
  if (!q) throw new Error(`no candidate question "${arg}" (see: list)`);
  return q;
}

function printScored(s: ScoredQuestion) {
  const sig = new Map(s.diagnostics.signals.map((x) => [x.id, x]));
  console.log(`\n${s.question.prompt}  [${s.question.signature}]`);
  console.log(`validation: ${s.question.validation.method} - ${s.question.validation.criterion}`);
  console.log(`pass agreement (Kendall tau): ${s.diagnostics.passAgreement.toFixed(2)}   knowledge ${s.knowledgeVersion}   scoring v${s.scoringVersion}   ${s.model}\n`);
  console.log("rank  pts  name                          borda  passes            pop    spell  key    fit(e/n/s)  perception");
  for (const a of s.answers) {
    const x = sig.get(a.entityId)!;
    console.log(
      `${String(a.rank).padStart(4)}  ${String(a.score).padStart(3)}  ${a.name.padEnd(28)}  ${x.borda.toFixed(2)}   ` +
      `${x.passPositions.map((p) => String(p + 1).padStart(2)).join(" ").padEnd(16)}  ${x.popularity === null ? "   - " : x.popularity.toFixed(1).padStart(5)}  ` +
      `${String(x.spellingCost).padStart(4)}   ${x.key.toFixed(3)}  ${x.fit ? `${x.fit.expected}/${x.fit.neutral}/${x.fit.surprising}`.padEnd(10) : "-".padEnd(10)}  ${x.perception ?? ""}`,
    );
  }
  const name = (id: string) => kb.get(id)!.name;
  console.log("\npairwise:");
  for (const p of s.diagnostics.pairwise) console.log(`  [${p.purpose}] ${name(p.a)} vs ${name(p.b)}: ${p.rarer ? `${name(p.rarer)} rarer` : "disagreement (no change)"}`);
  if (s.diagnostics.override) console.log(`owner override: 100 points -> ${kb.get(s.diagnostics.override.rarest)!.name}`);
  console.log("review:");
  for (const r of s.diagnostics.review) console.log(`  ${r.name} ${r.claim} than ${r.compareWith} -> ${r.outcome}\n    ${r.reason}`);
  if (!s.diagnostics.review.length) console.log("  no challenges");
}

const [cmd, ...rest] = args;
try {
  if (cmd === "list") {
    allCandidates().forEach((q, i) => {
      const scored = existsSync(questionFile(q.signature)) ? "scored" : "      ";
      console.log(`${String(i).padStart(3)}  ${scored}  ${String(q.answerIds.length).padStart(3)}  ${q.signature}  |  ${q.prompt}`);
    });
  } else if (cmd === "propose") {
    const type = rest[0] as EntityType;
    if (type !== "hero" && type !== "item") throw new Error("usage: propose <hero|item> [count]");
    const file = readSemantic();
    const avoid = [...allCandidates().filter((q) => q.entityType === type).map((q) => q.prompt), ...file.rejected.map((r) => r.proposal.prompt)];
    const proposals = await proposeSemantic(kb, ask, type, Number(rest[1] ?? 8), avoid);
    for (const p of proposals) {
      const r = await validateSemantic(kb, ask, p);
      if (r.candidate && !file.accepted.some((q) => q.signature === r.candidate!.signature)) {
        file.accepted.push(r.candidate);
        console.log(`ACCEPT ${r.candidate.answerIds.length}  ${p.prompt}`);
      } else {
        const reason = r.rejection ?? "duplicate signature";
        file.rejected.push({ proposal: p, reason, notes: r.notes });
        console.log(`REJECT ${p.prompt}\n       ${reason}`);
      }
    }
    mkdirSync(join(DATA, "candidates"), { recursive: true });
    writeFileSync(SEMANTIC_FILE, JSON.stringify(file, null, 1));
  } else if (cmd === "score") {
    const q = findCandidate(rest.join(" "));
    const scored = await scoreQuestion(kb, ask, q);
    mkdirSync(QUESTIONS_DIR, { recursive: true });
    writeFileSync(questionFile(q.signature), JSON.stringify(scored, null, 1));
    printScored(scored);
  } else if (cmd === "score-new") {
    // Score every candidate without a saved file (optionally the first N); stops cleanly at the budget.
    const todo = allCandidates().filter((q) => !existsSync(questionFile(q.signature))).slice(0, rest[0] ? Number(rest[0]) : undefined);
    console.log(`${todo.length} unscored questions`);
    mkdirSync(QUESTIONS_DIR, { recursive: true });
    for (const [i, q] of todo.entries()) {
      try {
        const scored = await scoreQuestion(kb, ask, q);
        writeFileSync(questionFile(q.signature), JSON.stringify(scored, null, 1));
        const top = scored.answers.find((a) => a.score === 100)!;
        console.log(`[${i + 1}/${todo.length}] ${q.signature}: Mo-Krillion ${kb.get(top.entityId)!.name}`);
      } catch (e) {
        console.error(`[${i + 1}/${todo.length}] ${q.signature}: ${(e as Error).message}`);
        if (/budget/.test((e as Error).message)) break;
      }
    }
  } else if (cmd === "eval") {
    // Compare stored scores with human judgments (data/eval/judgments.json).
    type J = { signature: string; note: string };
    const judg = JSON.parse(readFileSync(join(DATA, "eval/judgments.json"), "utf8")) as {
      rarest?: (J & { entityId: string })[];
      mostCommon?: (J & { entityId: string })[];
      pairs?: (J & { rarer: string; commoner: string })[];
    };
    const load = (sig: string): ScoredQuestion | null =>
      existsSync(questionFile(sig)) ? JSON.parse(readFileSync(questionFile(sig), "utf8")) : null;
    const tally = { hit: 0, total: 0 };
    const report = (ok: boolean, text: string) => {
      tally.total++;
      if (ok) tally.hit++;
      console.log(`${ok ? "HIT " : "MISS"}  ${text}`);
    };
    for (const [kind, list] of [["rarest", judg.rarest ?? []], ["mostCommon", judg.mostCommon ?? []]] as const) {
      for (const j of list) {
        const s = load(j.signature);
        if (!s) { console.log(`not scored: ${j.signature}`); continue; }
        const a = s.answers.find((x) => x.entityId === j.entityId)!;
        const want = kind === "rarest" ? 100 : 10;
        report(a.score === want, `[${kind}] ${s.question.prompt} ${a.name}: rank ${a.rank}/${s.answers.length}, ${a.score} pts (v${s.scoringVersion})`);
      }
    }
    for (const j of judg.pairs ?? []) {
      const s = load(j.signature);
      if (!s) { console.log(`not scored: ${j.signature}`); continue; }
      const r = s.answers.find((x) => x.entityId === j.rarer)!, c = s.answers.find((x) => x.entityId === j.commoner)!;
      report(r.rank > c.rank, `[pair] ${r.name} (rank ${r.rank}, ${r.score}) rarer than ${c.name} (rank ${c.rank}, ${c.score}) (v${s.scoringVersion})`);
    }
    console.log(`\n${tally.hit}/${tally.total} human judgments matched`);
  } else if (cmd === "set-rarest") {
    // questions set-rarest <signature|index> <answer name>   (picks the 100-point answer; no LLM calls)
    // Signatures and names can both contain spaces, so take the longest leading words that name a candidate.
    const all = allCandidates();
    const split = [...rest.keys()].slice(1).reverse().map((i) => {
      const arg = rest.slice(0, i).join(" ");
      return { q: /^\d+$/.test(arg) ? all[Number(arg)] : all.find((x) => x.signature === arg), name: rest.slice(i).join(" ") };
    }).find((x) => x.q);
    const entity = split && kb.findByName(split.name);
    if (!split || !entity) throw new Error("usage: set-rarest <signature|index> <answer name>");
    const sig = split.q!.signature;
    const overrides = loadOverrides();
    overrides[sig] = { rarest: entity.id };
    writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2) + "\n");
    if (existsSync(questionFile(sig))) {
      const updated = applyOverride(JSON.parse(readFileSync(questionFile(sig), "utf8")), entity.id);
      writeFileSync(questionFile(sig), JSON.stringify(updated, null, 1));
    }
    console.log(`${sig}: 100 points -> ${entity.name}`);
  } else if (cmd === "show") {
    const file = questionFile(findCandidate(rest.join(" ")).signature);
    if (!existsSync(file)) throw new Error(`not scored yet: ${rest.join(" ")}`);
    printScored(JSON.parse(readFileSync(file, "utf8")));
  } else {
    console.log("usage: questions list | propose <hero|item> [count] | score <signature|index> | score-new [N] | show <signature|index> | eval | set-rarest <signature|index> <answer>  [--no-cache]");
  }
} finally {
  if (cmd === "propose" || cmd === "score" || cmd === "score-new") console.log(`\n${usageSummary()}`);
}
