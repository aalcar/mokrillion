# Mokrillion

Daily Deadlock trivia. Every question has many right answers; rarer ones score more (10–100, max 700 a day).
Facts come from [The Deadlock Wiki](https://deadlock.wiki) (CC BY-NC-SA 4.0), play stats from
[Deadlock API](https://deadlock-api.com).

## Quick start

Needs Node 22.6+.

```
npm install
npm run game -- play      # play today's game in the terminal
```

## Run the Discord bot

1. Create an app at https://discord.com/developers/applications. Under **Bot**, copy the token.
2. Under **OAuth2 > URL Generator**, tick `bot` and `applications.commands`, then `Send Messages`. Open the link and add the bot to your server.
3. Put this in `.env`:
   ```
   DISCORD_TOKEN=...
   DISCORD_CLIENT_ID=...   # Application ID
   DISCORD_GUILD_ID=...    # your server ID
   ```
4. `npm run bot:register` (once), then `npm run bot` (keep it running).

Players type `/play` in the server and answer in DMs. `/share` posts their score without spoilers.
One game per player per day; the day resets at midnight Pacific.

## Make more questions

LLM steps need a key in `.env`: `ANTHROPIC_API_KEY` and/or `GEMINI_API_KEY` (free). If Anthropic fails or runs
out of credit, it switches to Gemini.

```
npm run questions -- list                         # all questions
npm run questions -- score <number|signature>     # rank answers and save (~$0.06 on Sonnet)
npm run questions -- show <signature>             # see a saved table
npm run questions -- set-rarest <signature> <answer>   # pick the 100-point answer yourself
npm run questions -- propose hero 8               # have the LLM write new questions
npm run game -- generate --days 7                 # publish the next week of games
```

## Refresh game data (after a patch)

```
npm run ingest && npm run ingest:stats && npm run normalize
```

Then re-score questions.

## How scoring works

1. Every valid answer is listed up front, from wiki data (or LLM-checked with quoted evidence).
2. An LLM ranks the answers from most to least obvious, 5 times in shuffled order.
3. That ranking is mixed with how often your rank range (Ritualist–Oracle) picks the hero or buys the item.
   - "Name a 3,200 item" style questions lean on play stats.
   - "Name an item with Melee Resist" style questions lean on the LLM.
4. Close calls near the top get extra head-to-head checks and a review pass.
5. Points: about 8% of answers get 10, 17% get 30, 30% get 60, the rest 85, and exactly one gets 100.
   Your `set-rarest` picks always win.

Scores are estimates, not real answer counts. Every saved question keeps its full breakdown.

## Settings

All in `src/config.ts`. Useful `.env` overrides: `MOKRILLION_PROVIDER` (`anthropic` or `gemini`),
`MOKRILLION_MODEL`, `MOKRILLION_GEMINI_MODEL`, `MOKRILLION_MAX_COST_USD` (default 5 per run),
`MOKRILLION_MIN_BADGE` / `MOKRILLION_MAX_BADGE` (rank range for play stats).

## Tests

```
npm test && npm run typecheck
```
