# Mokrillion

Daily Deadlock trivia based on Mokrillion which is based on Krillion (i didnt like the other scoring algorithm)
Data comes from [The Deadlock Wiki](https://deadlock.wiki) (CC BY-NC-SA 4.0) and [Deadlock API](https://deadlock-api.com).

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

Players type `/play` in the server and answer in DMs. `/share` posts their score as colored squares (⬛ 0 · 🟥 10 · 🟧 30 · 🟨 60 · 🟩 85 · 🟪 100, the Mo-Krillion), no spoilers.
One game per player per day; the day resets at midnight Pacific.

## Hosting

The bot needs an always-on machine with a disk (it saves games in progress under `data/plays/`), so serverless
hosts and Heroku (wipes disk on restart) won't work. Cheapest good option: a DigitalOcean droplet paid by the
GitHub Student Pack's $200 credit (the $6/mo Ubuntu droplet runs free for a year). After that, an Oracle Cloud
Always Free VM works with the same steps.

On a fresh Ubuntu box (as root):

```
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs git
useradd -m bot && su - bot -c "git clone https://github.com/aalcar/mokrillion.git"
cd /home/bot/mokrillion && su bot -c "npm ci"
nano .env          # DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, plus:
                   # MOKRILLION_GAME_SALT=<any long random string, e.g. from `openssl rand -hex 16`>
chown bot .env && chmod 600 .env
su bot -c "npm run bot:register"
cp deploy/mokrillion.service /etc/systemd/system/ && systemctl enable --now mokrillion
journalctl -u mokrillion -f    # logs
```

Nightly backup of player games (`crontab -e` as bot):

```
0 4 * * * tar czf /home/bot/plays-$(date +\%a).tgz -C /home/bot/mokrillion/data plays
```

Deploy an update from your laptop: push to GitHub, then

```
ssh root@<droplet-ip> 'su bot -c "cd ~/mokrillion && git pull && npm ci" && systemctl restart mokrillion'
```

Daily games are built on the server the first time someone plays that day. They are not committed to git, and
the salt keeps future picks unguessable from this public repo.

## Make more questions

LLM steps need a key in `.env`: `ANTHROPIC_API_KEY` and/or `GEMINI_API_KEY` (free). If Anthropic fails or runs
out of credit, it switches to Gemini.

```
npm run questions -- list                         # all questions
npm run questions -- score <number|signature>     # rank answers and save (~$0.06 on Sonnet)
npm run questions -- score-new [N]                # score every question not saved yet (stops at the budget)
npm run questions -- show <number|signature>      # see a saved table
npm run questions -- set-rarest <number|signature> <answer>   # pick the Mo-Krillion (100-point answer) yourself
npm run questions -- propose hero 8               # have the LLM write new questions
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
5. Points: about 8% of answers get 10, 17% get 30, 30% get 60, the rest 85, and exactly one, the Mo-Krillion, gets 100.
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
