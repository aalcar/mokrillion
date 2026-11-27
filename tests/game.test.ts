import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { addDays, answerOverlap, buildGame, gameDate, loadScoredQuestions, saveGame, type DailyGame } from "../src/game/daily.ts";
import { editDistance, matchAnswer } from "../src/game/matching.ts";
import { createSession, nextQuestion, results, scoreSquare, shareText, startQuestion, submit, timeLeftMs } from "../src/game/session.ts";
import { loadKnowledge } from "../src/knowledge/queries.ts";

const kb = loadKnowledge();
const pool = loadScoredQuestions();

test("edit distance counts adjacent transpositions as one edit", () => {
  assert.equal(editDistance("infernus", "infrenus"), 1);
  assert.equal(editDistance("haze", "haze"), 0);
  assert.equal(editDistance("slot", "slow"), 1);
});

test("matching: exact, aliases, safe typo fixes, and no guessing", () => {
  const m = (t: string) => matchAnswer(kb, t);
  const name = (t: string) => { const r = m(t); return r.kind === "entity" ? r.entity.name : r.kind; };
  assert.equal(name("  INFERNUS "), "Infernus");
  assert.equal(name("geist"), "Lady Geist");
  assert.equal(name("apr"), "Armor Piercer");
  assert.equal(name("mo and krill"), "Mo & Krill");
  assert.equal(name("doorman"), "The Doorman");
  const fixed = m("infrenus");
  assert.ok(fixed.kind === "entity" && fixed.corrected && fixed.entity.name === "Infernus");
  // Two plausible items one edit apart: must ask, never pick.
  const amb = m("mystic slot");
  assert.equal(amb.kind, "suggest");
  assert.ok(amb.kind === "suggest" && amb.suggestions.map((e) => e.name).includes("Mystic Slow"));
  assert.equal(name("haz"), "suggest"); // too short to auto-correct
  assert.equal(name("xyzzy"), "unknown");
  assert.equal(name(""), "unknown");
});

test("daily selection: rules hold over many consecutive days, and is deterministic", () => {
  const g = config.game;
  const games: DailyGame[] = [];
  const start = "2027-01-01";
  for (let i = 0; i < 30; i++) games.push(buildGame(addDays(start, i), pool, games));
  for (const game of games) {
    const qs = game.questions;
    assert.equal(qs.length, g.questionsPerDay);
    assert.equal(new Set(qs.map((q) => q.id)).size, qs.length);
    assert.ok(qs.filter((q) => q.category === "name-trivia").length <= g.maxNameQuestions, game.date);
    assert.ok(qs.filter((q) => q.entityType === "hero").length >= g.minHeroQuestions, game.date);
    assert.ok(qs.filter((q) => q.entityType === "item").length >= g.minItemQuestions, game.date);
    const perCategory = new Map<string, number>();
    for (const q of qs) perCategory.set(q.category, (perCategory.get(q.category) ?? 0) + 1);
    assert.ok(Math.max(...perCategory.values()) <= g.maxPerCategory, game.date);
    for (const q of qs) assert.equal(q.answers.filter((a) => a.score === 100).length, 1);
    const scored = qs.map((q) => pool.find((p) => p.question.signature === q.id)!);
    for (let i = 0; i < scored.length; i++) for (let j = i + 1; j < scored.length; j++) {
      assert.ok(answerOverlap(scored[i], scored[j]) <= g.maxAnswerOverlap, `${game.date}: ${qs[i].id} vs ${qs[j].id}`);
    }
  }
  // No repeats while unused questions remain. Name questions are capped per day, so the binding limit is
  // the non-name pool divided by the non-name slots per day.
  const nonName = pool.filter((q) => q.question.category !== "name-trivia");
  const distinctDays = Math.min(
    Math.floor(nonName.length / (g.questionsPerDay - g.maxNameQuestions)),
    Math.floor(nonName.filter((q) => q.question.entityType === "hero").length / g.minHeroQuestions),
  );
  const firstDays = games.slice(0, distinctDays).flatMap((x) => x.questions.map((q) => q.id));
  assert.equal(new Set(firstDays).size, firstDays.length);
  // When reuse is unavoidable, nothing from the previous day comes back.
  for (let i = 1; i < games.length; i++) {
    const yesterday = new Set(games[i - 1].questions.map((q) => q.id));
    assert.ok(games[i].questions.every((q) => !yesterday.has(q.id)), games[i].date);
  }
  // Same date and history -> same questions.
  assert.deepEqual(buildGame(start, pool, []).questions.map((q) => q.id), games[0].questions.map((q) => q.id));
});

test("published games are immutable and must be complete", () => {
  const dir = mkdtempSync(join(tmpdir(), "mokrillion-games-"));
  const game = buildGame("2027-02-01", pool, []);
  saveGame(game, dir);
  assert.throws(() => saveGame(game, dir), /immutable/);
  assert.throws(() => saveGame({ ...game, date: "2027-02-02", questions: game.questions.slice(0, 6) }, dir), /refusing/);
});

test("game date uses the reset timezone", () => {
  // 2027-03-01 06:00 UTC is still Feb 28 in Los Angeles.
  assert.equal(gameDate(new Date("2027-03-01T06:00:00Z"), "America/Los_Angeles"), "2027-02-28");
  assert.equal(gameDate(new Date("2027-03-01T09:00:00Z"), "America/Los_Angeles"), "2027-03-01");
});

test("session: retries, lock on first correct answer, timeout, results", () => {
  const game = buildGame("2027-04-01", pool, []);
  const s = createSession(game);
  const t0 = 1_000_000;
  const q0 = game.questions[0];
  startQuestion(s, t0);
  assert.equal(timeLeftMs(s, t0 + 10_000), 20_000);

  const valid = new Set(q0.answers.map((a) => a.entityId));
  const wrongSameType = (q0.entityType === "hero" ? kb.heroes : kb.items).find((e) => !valid.has(e.id))!;
  const otherType = (q0.entityType === "hero" ? kb.items : kb.heroes)[0];
  assert.deepEqual(submit(s, kb, wrongSameType.name, t0 + 1000), { kind: "wrong", name: wrongSameType.name, reason: "not-valid" });
  assert.equal((submit(s, kb, otherType.name, t0 + 2000) as { reason: string }).reason, "wrong-type");
  assert.equal(submit(s, kb, "xyzzy", t0 + 3000).kind, "unknown");
  const answer = q0.answers[0];
  assert.deepEqual(submit(s, kb, answer.name, t0 + 4000), { kind: "correct", name: answer.name, score: answer.score, corrected: false });
  assert.equal(submit(s, kb, q0.answers[1].name, t0 + 5000).kind, "closed"); // locked in

  assert.ok(nextQuestion(s));
  startQuestion(s, t0 + 10_000);
  assert.equal(submit(s, kb, game.questions[1].answers[0].name, t0 + 10_000 + 30_001).kind, "timeout");

  while (nextQuestion(s));
  const r = results(s);
  assert.equal(r.total, answer.score);
  assert.equal(r.max, 700);
  assert.equal(r.questions[1].answer, null);
  assert.equal(r.questions[1].score, 0);
  assert.equal(r.questions[0].attempts, 4);
});

test("share text: name, total and one square per question", () => {
  assert.deepEqual([0, 10, 30, 60, 85, 100].map(scoreSquare), ["⬛", "🟥", "🟧", "🟨", "🟩", "🟪"]);
  const game = buildGame("2027-03-01", pool, []);
  const s = createSession(game);
  const q0 = game.questions[0], top = q0.answers.find((a) => a.score === 100)!;
  startQuestion(s, 0);
  assert.equal(submit(s, kb, top.name, 1).kind, "correct");
  while (nextQuestion(s));
  const [head, squares] = shareText(s, "Alex").split("\n");
  assert.equal(head, "Alex · Mokrillion 2027-03-01 · 100/700");
  assert.equal(squares, "🟪" + "⬛".repeat(game.questions.length - 1));
});

test("a weapon name counts as its hero and is shown with it", () => {
  const holliday = kb.findByName("holliday")!;
  const game: DailyGame = { date: "2027-05-01", knowledgeVersion: "", scoringVersion: "", generatedAt: "", questions: [{
    id: "t", prompt: "t", category: "weapon-name", entityType: "hero",
    answers: [{ entityId: holliday.id, name: holliday.name, rank: 1, score: 100 }] }] };
  const s = createSession(game);
  startQuestion(s, 0);
  const r = submit(s, kb, "docs orders", 1);
  assert.ok(r.kind === "correct" && r.name === "Holliday (Doc's Orders)", JSON.stringify(r));
});
