// Question pipeline CLI. Every step writes inspectable JSON under data/.
//   npm run questions -- list
//   npm run questions -- propose item 8        (LLM: propose + validate semantic questions)
//   npm run questions -- score item-cost:3200  (LLM: rank + score; or "score 12" by list index)
//   npm run questions -- show item-cost:3200
// Add --no-cache to force fresh LLM calls (e.g. to measure ranking stability).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deterministicCandidates } from "../generation/templates.ts";
import { proposeSemantic, validateSemantic, type Proposal } from "../generation/semantic.ts";
import { loadKnowledge } from "../knowledge/queries.ts";
import type { CandidateQuestion, EntityType } from "../knowledge/types.ts";
import { createAsk, usageSummary } from "../llm.ts";
import { scoreQuestion, type ScoredQuestion } from "../scoring/rank.ts";

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
    const all = allCandidates();
    const q = /^\d+$/.test(rest[0] ?? "") ? all[Number(rest[0])] : all.find((x) => x.signature === rest.join(" "));
    if (!q) throw new Error(`no candidate question "${rest.join(" ")}" (see: list)`);
    const scored = await scoreQuestion(kb, ask, q);
    mkdirSync(QUESTIONS_DIR, { recursive: true });
    writeFileSync(questionFile(q.signature), JSON.stringify(scored, null, 1));
    printScored(scored);
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
  } else if (cmd === "show") {
    const file = questionFile(rest.join(" "));
    if (!existsSync(file)) throw new Error(`not scored yet: ${rest.join(" ")}`);
    printScored(JSON.parse(readFileSync(file, "utf8")));
  } else {
    console.log("usage: questions list | propose <hero|item> [count] | score <signature|index> | show <signature> | eval  [--no-cache]");
  }
} finally {
  if (cmd === "propose" || cmd === "score") console.log(`\n${usageSummary()}`);
}
