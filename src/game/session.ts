// One player's run through a daily game. Pure state + timestamps, so any interface (CLI, web server,
// Discord bot) can drive it and the server stays the authority on timing and scoring.
import { config } from "../config.ts";
import type { Knowledge } from "../knowledge/queries.ts";
import type { DailyGame } from "./daily.ts";
import { matchAnswer } from "./matching.ts";

export type SubmitResult =
  | { kind: "correct"; name: string; score: number; corrected: boolean }
  /** A real hero/item that is not a valid answer (or the wrong type). The player may try again. */
  | { kind: "wrong"; name: string; reason: "not-valid" | "wrong-type" }
  | { kind: "suggest"; names: string[] }
  | { kind: "unknown" }
  | { kind: "timeout" }
  | { kind: "closed" };

interface QuestionState {
  startedAt: number | null;
  answer: { entityId: string; name: string; score: number } | null;
  attempts: { text: string; result: SubmitResult["kind"] }[];
  closed: boolean;
}

export interface Session {
  game: DailyGame;
  current: number;
  questions: QuestionState[];
}

const LIMIT_MS = () => config.game.secondsPerQuestion * 1000;

export function createSession(game: DailyGame): Session {
  return {
    game,
    current: 0,
    questions: game.questions.map(() => ({ startedAt: null, answer: null, attempts: [], closed: false })),
  };
}

/** Start the timer for the current question (idempotent). */
export function startQuestion(s: Session, now: number): void {
  const q = s.questions[s.current];
  if (q && q.startedAt === null) q.startedAt = now;
}

export function timeLeftMs(s: Session, now: number): number {
  const q = s.questions[s.current];
  if (!q || q.startedAt === null || q.closed) return 0;
  return Math.max(0, q.startedAt + LIMIT_MS() - now);
}

/**
 * Submit an answer for the current question. Wrong, unknown and uncertain answers can be retried
 * until time runs out; the first correct answer locks in.
 */
export function submit(s: Session, kb: Knowledge, text: string, now: number): SubmitResult {
  const state = s.questions[s.current];
  const question = s.game.questions[s.current];
  if (!state || state.closed || state.startedAt === null) return { kind: "closed" };
  const result = evaluate();
  state.attempts.push({ text, result: result.kind });
  if (result.kind === "correct" || result.kind === "timeout") state.closed = true;
  return result;

  function evaluate(): SubmitResult {
    if (now > state.startedAt! + LIMIT_MS()) return { kind: "timeout" };
    const m = matchAnswer(kb, text);
    if (m.kind === "unknown") return { kind: "unknown" };
    if (m.kind === "suggest") return { kind: "suggest", names: m.suggestions.map((e) => e.name) };
    const hit = question.answers.find((a) => a.entityId === m.entity.id);
    if (hit) {
      state.answer = { entityId: hit.entityId, name: hit.name, score: hit.score };
      return { kind: "correct", name: hit.name, score: hit.score, corrected: m.corrected };
    }
    return { kind: "wrong", name: m.entity.name, reason: m.entity.type === question.entityType ? "not-valid" : "wrong-type" };
  }
}

/** Close the current question (time up or player skips) and move on. Returns false when the game is over. */
export function nextQuestion(s: Session): boolean {
  const state = s.questions[s.current];
  if (state) state.closed = true;
  s.current++;
  return s.current < s.game.questions.length;
}

export interface QuestionResult {
  prompt: string;
  answer: string | null;
  score: number;
  attempts: number;
  topAnswer: string;
  answerCount: number;
}

export function results(s: Session): { questions: QuestionResult[]; total: number; max: number } {
  const questions = s.game.questions.map((q, i) => {
    const st = s.questions[i];
    return {
      prompt: q.prompt,
      answer: st.answer?.name ?? null,
      score: st.answer?.score ?? 0,
      attempts: st.attempts.length,
      topAnswer: q.answers.find((a) => a.score === 100)!.name,
      answerCount: q.answers.length,
    };
  });
  return { questions, total: questions.reduce((t, q) => t + q.score, 0), max: 100 * questions.length };
}

const SQUARES: Record<number, string> = { 0: "⬛", 10: "🟥", 30: "🟧", 60: "🟨", 85: "🟩", 100: "🟪" };

/** Wordle-style square for one question's score. */
export const scoreSquare = (score: number) => SQUARES[score] ?? "⬛";

/** Spoiler-free share text: name, date, total, then one square per question. */
export function shareText(s: Session, name: string): string {
  const r = results(s);
  return `${name} · Mokrillion ${s.game.date} · ${r.total}/${r.max}\n${r.questions.map((q) => scoreSquare(q.score)).join("")}`;
}
