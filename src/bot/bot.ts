// Discord bot. /play starts (or resumes) today's game in the player's DMs; answers are typed as DM
// messages. /share posts a spoiler-free score line in the channel. The answer key never leaves the bot.
//   env: DISCORD_TOKEN (required)
import { Client, Events, GatewayIntentBits, MessageFlags, Partials, type DMChannel, type User } from "discord.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGame, gameDate, loadGame, loadGames, loadScoredQuestions, saveGame, type DailyGame } from "../game/daily.ts";
import { createSession, nextQuestion, results, startQuestion, submit, timeLeftMs, type Session } from "../game/session.ts";
import { loadKnowledge } from "../knowledge/queries.ts";

const PLAYS_DIR = join(import.meta.dirname, "../../data/plays");
const kb = loadKnowledge();
const timers = new Map<string, NodeJS.Timeout>();

// ---------- game + session persistence ----------

/** Today's game; built from the scored pool on first use if not published yet (deterministic, no LLM). */
function todaysGame(): DailyGame {
  const date = gameDate();
  const existing = loadGame(date);
  if (existing) return existing;
  const game = buildGame(date, loadScoredQuestions(), loadGames());
  try {
    saveGame(game);
  } catch (e) {
    const raced = loadGame(date); // another request published it first
    if (raced) return raced;
    throw e;
  }
  return game;
}

type StoredSession = Omit<Session, "game"> & { date: string; finished: boolean };
const playFile = (date: string, userId: string) => join(PLAYS_DIR, date, `${userId}.json`);

function loadSession(game: DailyGame, userId: string): (Session & { finished: boolean }) | null {
  const file = playFile(game.date, userId);
  if (!existsSync(file)) return null;
  const s: StoredSession = JSON.parse(readFileSync(file, "utf8"));
  return { game, current: s.current, questions: s.questions, finished: s.finished };
}

function saveSession(s: Session, userId: string, finished: boolean) {
  const file = playFile(s.game.date, userId);
  mkdirSync(join(PLAYS_DIR, s.game.date), { recursive: true });
  const stored: StoredSession = { date: s.game.date, current: s.current, questions: s.questions, finished };
  writeFileSync(`${file}.tmp`, JSON.stringify(stored));
  renameSync(`${file}.tmp`, file);
}

// ---------- message formatting ----------

function resultsText(s: Session): string {
  const r = results(s);
  const lines = r.questions.map(
    (q, i) => `**Q${i + 1}.** ${q.prompt}\n> you: **${q.answer ?? "-"}** (${q.score} pts) · 100-pt answer: **${q.topAnswer}** · ${q.answerCount} valid answers`,
  );
  return `**Mokrillion ${s.game.date}: ${r.total} / ${r.max}**\n\n${lines.join("\n")}`;
}

export function shareLine(s: Session): string {
  const r = results(s);
  return `Mokrillion ${s.game.date}: **${r.total} / ${r.max}**  ${r.questions.map((q) => (q.score ? String(q.score) : "✗")).join(" · ")}`;
}

// ---------- game loop ----------

interface Active { session: Session & { finished: boolean }; user: User; dm: DMChannel }
const active = new Map<string, Active>();

async function askCurrent(a: Active): Promise<void> {
  const { session, user, dm } = a;
  clearTimeout(timers.get(user.id));
  if (session.current >= session.game.questions.length) {
    session.finished = true;
    saveSession(session, user.id, true);
    active.delete(user.id);
    await dm.send(`${resultsText(session)}\n\nUse **/share** in the server to post your score.`);
    return;
  }
  const q = session.game.questions[session.current];
  startQuestion(session, Date.now()); // keeps the original start time when resuming
  saveSession(session, user.id, false);
  const left = timeLeftMs(session, Date.now());
  if (left <= 0) return timeUp(a);
  await dm.send(`**Q${session.current + 1}/${session.game.questions.length}.** ${q.prompt}\n⏱ ${Math.ceil(left / 1000)}s`);
  const index = session.current;
  timers.set(user.id, setTimeout(() => {
    if (active.get(user.id) === a && a.session.current === index) void timeUp(a);
  }, left));
}

async function timeUp(a: Active): Promise<void> {
  await a.dm.send("⌛ Time's up!");
  nextQuestion(a.session);
  await askCurrent(a);
}

async function onAnswer(a: Active, text: string): Promise<void> {
  const r = submit(a.session, kb, text, Date.now());
  const q = a.session.game.questions[a.session.current];
  switch (r.kind) {
    case "correct":
      clearTimeout(timers.get(a.user.id));
      await a.dm.send(`✅ ${r.corrected ? `${r.name}! ` : ""}**+${r.score}**`);
      nextQuestion(a.session);
      return askCurrent(a);
    case "timeout":
    case "closed":
      return timeUp(a);
    case "wrong":
      saveSession(a.session, a.user.id, false);
      await a.dm.send(r.reason === "wrong-type" ? `❌ ${r.name} isn't ${q.entityType === "item" ? "an item" : "a hero"}. Try again.` : `❌ ${r.name} doesn't fit. Try again.`);
      return;
    case "suggest":
      await a.dm.send(`🤔 Did you mean ${r.names.map((n) => `**${n}**`).join(" or ")}? Type it again.`);
      return;
    case "unknown":
      await a.dm.send("🤷 Not a hero or item I know. Try again.");
  }
}

// ---------- Discord wiring ----------

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel], // DM channels are not cached until used
});

client.once(Events.ClientReady, (c) => console.log(`Mokrillion bot logged in as ${c.user.tag}`));

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    const game = todaysGame();
    const user = interaction.user;
    const saved = loadSession(game, user.id);

    if (interaction.commandName === "share") {
      if (!saved?.finished) {
        await interaction.reply({ content: "Finish today's game first (/play).", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply(`${user.displayName}: ${shareLine(saved)}`);
      return;
    }

    if (interaction.commandName === "play") {
      if (saved?.finished) {
        await interaction.reply({ content: `You've already played today (${results(saved).total} / 700). New game after midnight Pacific.`, flags: MessageFlags.Ephemeral });
        return;
      }
      if (active.has(user.id)) {
        await interaction.reply({ content: "Your game is running in DMs.", flags: MessageFlags.Ephemeral });
        return;
      }
      const dm = await user.createDM();
      const a: Active = { session: saved ?? { ...createSession(game), finished: false }, user, dm };
      try {
        // Send the intro before starting any timer, so a blocked DM fails before the game starts.
        await dm.send(saved ? "Resuming your game." : "**Mokrillion**: name a valid answer for each question. Rarer correct answers score more (10-100). Wrong answers are free, keep typing until time runs out.");
      } catch {
        await interaction.reply({ content: "I can't DM you. Allow direct messages from server members (Privacy Settings) and try /play again.", flags: MessageFlags.Ephemeral });
        return;
      }
      active.set(user.id, a);
      await interaction.reply({ content: saved ? "Resuming your game in DMs." : "Game sent to your DMs! 7 questions, 30 seconds each.", flags: MessageFlags.Ephemeral });
      await askCurrent(a);
    }
  } catch (e) {
    console.error(e);
    const content = "Something went wrong starting the game.";
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.guildId) return; // DMs only
  const a = active.get(message.author.id);
  if (!a) return;
  try {
    await onAnswer(a, message.content);
  } catch (e) {
    console.error(e);
  }
});

if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN is not set");
await client.login(process.env.DISCORD_TOKEN);
