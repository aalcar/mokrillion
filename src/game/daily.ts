// Daily game selection and persistence. A game file is written once, complete, and never changed.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import type { EntityType, Score } from "../knowledge/types.ts";
import { seededRandom, shuffled, type ScoredQuestion } from "../scoring/rank.ts";

export interface GameQuestion {
  id: string;
  prompt: string;
  category: string;
  entityType: EntityType;
  /** Every valid answer with its fixed score, most obvious first. */
  answers: { entityId: string; name: string; rank: number; score: Score }[];
}

export interface DailyGame {
  date: string;
  knowledgeVersion: string;
  scoringVersion: string;
  generatedAt: string;
  questions: GameQuestion[];
}

const DATA = join(import.meta.dirname, "../../data");
export const GAMES_DIR = join(DATA, "games");
const QUESTIONS_DIR = join(DATA, "questions");

/** Calendar date (YYYY-MM-DD) in the game's reset timezone. */
export function gameDate(now = new Date(), timeZone = config.game.timezone): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export function loadScoredQuestions(dir = QUESTIONS_DIR): ScoredQuestion[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

export function loadGame(date: string, dir = GAMES_DIR): DailyGame | null {
  const file = join(dir, `${date}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

export function loadGames(dir = GAMES_DIR): DailyGame[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

const isName = (q: ScoredQuestion) => q.question.category === "name-trivia";

/** Same underlying property, e.g. both clip-size thresholds: "hero-stat:clipSize:high:29" -> "hero-stat:clipSize". */
const topic = (q: ScoredQuestion) => q.question.signature.replace(/:(high|low):[^:]+$/, "");

/** Share of the smaller answer pool that also answers the other question. */
export function answerOverlap(a: ScoredQuestion, b: ScoredQuestion): number {
  const ids = new Set(a.question.answerIds);
  const shared = b.question.answerIds.filter((id) => ids.has(id)).length;
  return shared / Math.min(a.question.answerIds.length, b.question.answerIds.length);
}

/** True if `picked` can still be completed to a valid game. */
function feasible(picked: ScoredQuestion[], target: number): boolean {
  const g = config.game;
  const left = target - picked.length;
  const heroes = picked.filter((q) => q.question.entityType === "hero").length;
  const items = picked.length - heroes;
  return Math.max(0, g.minHeroQuestions - heroes) + Math.max(0, g.minItemQuestions - items) <= left;
}

/**
 * Pick questions for `date`: deterministic for a given date and pool, with variety rules and no
 * reuse of questions from games in the previous `repeatWindowDays` days (relaxed only if the pool is too small).
 */
export function selectQuestions(date: string, pool: ScoredQuestion[], previous: DailyGame[]): ScoredQuestion[] {
  const g = config.game;
  const recent = new Set(
    previous.filter((p) => p.date < date && p.date >= addDays(date, -g.repeatWindowDays)).flatMap((p) => p.questions.map((q) => q.id)),
  );
  // Last date each question appeared before `date`; never-used questions sort first, then least recently used.
  const lastUsed = new Map<string, string>();
  for (const p of previous.filter((p) => p.date < date)) for (const q of p.questions) {
    if ((lastUsed.get(q.id) ?? "") < p.date) lastUsed.set(q.id, p.date);
  }
  const age = (q: ScoredQuestion) => lastUsed.get(q.question.signature) ?? "";
  for (const candidates of [pool.filter((q) => !recent.has(q.question.signature)), pool]) {
    for (let attempt = 0; attempt < 50; attempt++) {
      // Secret salt on the host keeps future games unguessable from the public repo; empty in tests.
      const order = shuffled(candidates, seededRandom(`${date}#${process.env.MOKRILLION_GAME_SALT ?? ""}#${attempt}`)).sort((a, b) => age(a).localeCompare(age(b)));
      const picked: ScoredQuestion[] = [];
      for (const q of order) {
        if (picked.length === g.questionsPerDay) break;
        const sameCategory = picked.filter((p) => p.question.category === q.question.category).length;
        if (sameCategory >= g.maxPerCategory) continue;
        if (isName(q) && picked.filter(isName).length >= g.maxNameQuestions) continue;
        if (picked.some((p) => topic(p) === topic(q) || answerOverlap(p, q) > g.maxAnswerOverlap)) continue;
        if (!feasible([...picked, q], g.questionsPerDay)) continue;
        picked.push(q);
      }
      if (picked.length === g.questionsPerDay) return picked;
    }
  }
  throw new Error(`could not build a valid ${g.questionsPerDay}-question game for ${date} from ${pool.length} scored questions`);
}

export function buildGame(date: string, pool: ScoredQuestion[], previous: DailyGame[]): DailyGame {
  const picked = selectQuestions(date, pool, previous);
  const versions = (f: (q: ScoredQuestion) => string) => [...new Set(picked.map(f))].sort().join(",");
  return {
    date,
    knowledgeVersion: versions((q) => q.knowledgeVersion),
    scoringVersion: versions((q) => q.scoringVersion),
    generatedAt: new Date().toISOString(),
    questions: picked.map((s) => ({
      id: s.question.signature,
      prompt: s.question.prompt,
      category: s.question.category,
      entityType: s.question.entityType,
      answers: s.answers.map(({ entityId, name, rank, score }) => ({ entityId, name, rank, score })),
    })),
  };
}

/** Validate a finished game before it is published. */
export function checkGame(game: DailyGame): string | null {
  if (game.questions.length !== config.game.questionsPerDay) return `has ${game.questions.length} questions`;
  for (const q of game.questions) {
    if (q.answers.filter((a) => a.score === 100).length !== 1) return `${q.id} does not have exactly one 100-point answer`;
    if (new Set(q.answers.map((a) => a.entityId)).size !== q.answers.length) return `${q.id} has duplicate answers`;
  }
  return null;
}

/** Write a game atomically. Existing games are immutable. */
export function saveGame(game: DailyGame, dir = GAMES_DIR): string {
  const problem = checkGame(game);
  if (problem) throw new Error(`refusing to publish ${game.date}: ${problem}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${game.date}.json`);
  if (existsSync(file)) throw new Error(`${game.date} already exists; games are immutable`);
  writeFileSync(`${file}.tmp`, JSON.stringify(game, null, 1));
  renameSync(`${file}.tmp`, file);
  return file;
}
