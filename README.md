# Mokrillion

Deadlock-themed daily trivia where obscure correct answers score more. Facts come from
[The Deadlock Wiki](https://deadlock.wiki) (CC BY-NC-SA 4.0).

## Setup

Node 22.6+. `npm install`, then put API keys in `.env` (only needed for LLM steps):

```
ANTHROPIC_API_KEY=...   # optional
GEMINI_API_KEY=...      # optional, free tier at https://aistudio.google.com/apikey
```

Provider choice: Anthropic if `ANTHROPIC_API_KEY` is set, otherwise Gemini. If Anthropic rejects the key or
the account is out of credit mid-run, the run switches to Gemini automatically (when `GEMINI_API_KEY` is set).
Force one with `MOKRILLION_PROVIDER=anthropic|gemini`.

Optional env: `MOKRILLION_MODEL` (Anthropic, default `claude-opus-5-5`), `MOKRILLION_GEMINI_MODEL`
(default `gemini-3.8-flash`), `MOKRILLION_EFFORT` (Anthropic, default `medium`), `MOKRILLION_MAX_COST_USD`
(per-run budget, default 5; Gemini free tier counts as $0).

Different models rank differently, so cached answers are per model and every scored question records which
model(s) produced it. Compare rankings from different models with care.

## Commands

| Command | What it does |
|---|---|
| `npm run ingest` | Download a raw wiki snapshot into `data/raw/` |
| `npm run normalize` | Build `data/entities.json` from the snapshot |
| `npm run kb -- stats \| show <name> \| where <hero\|item> <path><op><value>` | Inspect the knowledge base |
| `npm run questions -- list` | All candidate questions with pool sizes |
| `npm run questions -- propose <hero\|item> [n]` | LLM proposes semantic questions; each is validated over the whole universe |
| `npm run questions -- score <signature\|index>` | Rank and score one question, save to `data/questions/`, print the full table |
| `npm run questions -- show <signature>` | Re-print a stored scored question |
| `npm run game -- generate [date] [--days N]` | Build and publish daily games (default: today in America/Los_Angeles); published games never change |
| `npm run game -- list` | Published games |
| `npm run game -- play [date]` | Play a daily game in the terminal |
| `npm run questions -- set-rarest <signature> <answer>` | Owner pick for a question's 100-point answer (`data/overrides.json`) |
| `npm test`, `npm run typecheck` | Offline tests (LLM is faked) and type check |

LLM responses are cached in `data/cache/llm/` so reruns are reproducible; add `--no-cache` for fresh calls.

## Answer pools

- **Deterministic questions** (cost, tier/slot, active items, component items, innate stat bonuses, wiki
  hero categories, hero stat thresholds): pools are exact predicates over `entities.json`.
- **Semantic questions** (effects described in text): the model screens *every* hero or item, then a
  separate call re-checks each plausible one and must quote evidence. A yes counts only if the quote
  appears in that entity's wiki text. Any unresolved/"unsure" entity rejects the question as ambiguous.

## Scoring

Target: how readily an experienced player thinks of an answer **for this question**. Steps
(`src/scoring/rank.ts`):

1. **Listwise ranking**: 5 passes, each with a differently shuffled candidate order; output must be an
   exact permutation (validated, bounded retries).
2. **Aggregation**: Borda (mean normalized position) blended with gameplay rarity (hero pick rate or item
   purchase rate from the [Deadlock API](https://deadlock-api.com) in Ritualist–Oracle matches, the group's own
   rank range; `npm run ingest:stats`, `MOKRILLION_MIN_BADGE`/`MOKRILLION_MAX_BADGE`) and spelling cost.
   Weights depend on the question type, from human judgments:
   - membership questions (cost, tier, active, component, name spelling): `0.25 × LLM + 0.7 × gameplay + 0.05 × spelling`
     (recall follows what players see in games);
   - association questions (stat bonuses, hero traits and stats, semantic): `0.8 × LLM + 0.15 × gameplay + 0.05 × spelling`
     (recall follows whether players link the answer to the property).
3. **Targeted pairwise**: all pairs among the 4 rarest candidates plus each tier boundary, asked in both
   orientations; only judgments that agree both ways change the order.
4. **Adversarial review**: a reviewer may challenge up to 5 placements (swap X and Y). If the gameplay data
   clearly agrees (the one it calls rarer is played/bought at most 2/3 as often), the swap is applied; otherwise it becomes a
   two-orientation comparison and is applied only if that holds. The reviewer never sets points.
5. **Tiers** (`src/scoring/tiers.ts`): ~8% → 10, ~17% → 30, ~30% → 60, rest → 85, last → 100.

Every scored question stores per-pass positions, signals, pairwise results, review outcomes and pass
agreement (mean Kendall tau). These are model estimates, not measured answer frequencies.

## Daily games

`src/game/` holds the engine; interfaces only call it.

- `daily.ts`: picks 7 scored questions per date, deterministic per date and history. Rules: at most one
  name question, at most 2 per category, at least 2 hero and 2 item questions, no two questions on the same
  stat or sharing more than half their answers, and no reuse within 60 days while the pool allows (otherwise
  least recently used first). Games are validated and written atomically to `data/games/<date>.json`.
- `matching.ts`: exact names and aliases, then one-typo auto-correction only when unambiguous (5+ letters,
  nothing else within 2 edits). Anything less certain is a "did you mean" suggestion, never a guess.
- `session.ts`: per-player state with timestamps; 30 seconds per question, unlimited retries for wrong or
  unknown answers, the first correct answer locks in, results with each question's 100-point answer.
