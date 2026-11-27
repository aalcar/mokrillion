// Daily game admin + terminal play.
//   npm run game -- generate [YYYY-MM-DD] [--days N]   build and publish games (default: today, 1 day)
//   npm run game -- list                               published games
//   npm run game -- play [YYYY-MM-DD]                  play in the terminal (default: today)
import { createInterface } from "node:readline/promises";
import { addDays, buildGame, gameDate, loadGame, loadGames, loadScoredQuestions, saveGame } from "../game/daily.ts";
import { createSession, nextQuestion, results, shareText, startQuestion, submit, timeLeftMs } from "../game/session.ts";
import { loadKnowledge } from "../knowledge/queries.ts";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};

if (cmd === "generate") {
  const days = Number(flag("--days") ?? 1);
  const start = args[0] ?? gameDate();
  const pool = loadScoredQuestions();
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    if (loadGame(date)) {
      console.log(`${date}: already published, skipped`);
      continue;
    }
    const game = buildGame(date, pool, loadGames());
    saveGame(game);
    console.log(`${date}: ${game.questions.map((q) => q.id).join(" | ")}`);
  }
} else if (cmd === "list") {
  for (const g of loadGames()) console.log(`${g.date}  ${g.questions.length} questions  scoring v${g.scoringVersion}`);
} else if (cmd === "play") {
  await play(args[0] ?? gameDate());
} else {
  console.log("usage: game generate [date] [--days N] | list | play [date]");
}

async function play(date: string) {
  const game = loadGame(date);
  if (!game) throw new Error(`no game published for ${date} (run: npm run game -- generate ${date})`);
  const kb = loadKnowledge();
  const session = createSession(game);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nMokrillion ${date}: ${game.questions.length} questions, 30 seconds each. Rarer correct answers score more; the rarest is the Mo-Krillion (100).\n`);

  do {
    const q = game.questions[session.current];
    console.log(`\nQ${session.current + 1}. ${q.prompt}`);
    startQuestion(session, Date.now());
    for (;;) {
      const left = timeLeftMs(session, Date.now());
      if (left <= 0) {
        console.log("Time's up!");
        break;
      }
      let text: string;
      try {
        text = await rl.question(`[${Math.ceil(left / 1000)}s] > `, { signal: AbortSignal.timeout(left) });
      } catch {
        console.log("\nTime's up!");
        break;
      }
      if (!text.trim()) continue;
      const r = submit(session, kb, text, Date.now());
      if (r.kind === "correct") {
        console.log(r.score === 100 ? `${r.name}: Mo-Krillion! +100 points` : `Correct${r.corrected ? ` (${r.name})` : ""}! +${r.score} points`);
        break;
      }
      if (r.kind === "timeout" || r.kind === "closed") {
        console.log("Time's up!");
        break;
      }
      if (r.kind === "wrong") console.log(r.reason === "wrong-type" ? `${r.name} isn't a${q.entityType === "item" ? "n item" : " hero"}. Try again.` : `${r.name} doesn't fit. Try again.`);
      else if (r.kind === "suggest") console.log(`Did you mean ${r.names.join(" or ")}? Try again.`);
      else console.log("Not a hero or item I recognise. Try again.");
    }
  } while (nextQuestion(session));
  rl.close();

  const r = results(session);
  console.log(`\nResults for ${date}: ${r.total} / ${r.max}\n`);
  r.questions.forEach((q, i) => {
    console.log(`Q${i + 1}. ${q.prompt}`);
    console.log(`    you: ${q.answer ?? "-"} (${q.score} pts)   Mo-Krillion: ${q.topAnswer}   (${q.answerCount} valid answers)`);
  });
  console.log(`\n${shareText(session, "You")}`);
}
