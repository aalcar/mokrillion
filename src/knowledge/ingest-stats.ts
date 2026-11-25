// Manually run: downloads gameplay statistics from the Deadlock API (https://deadlock-api.com, MIT)
// into data/raw/. Two cheap analytics requests: hero pick counts and item purchase counts,
// restricted to matches whose average badge (tier * 10 + subtier) is within the players' own range.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const API = "https://api.deadlock-api.com";
const UA = "mokrillion-ingest/0.1 (private non-commercial trivia game)";
const RAW_DIR = join(import.meta.dirname, "../../data/raw");
/** Default 61-89 = Ritualist 1 through Oracle 9, the rank range of the intended players. */
const MIN_BADGE = Number(process.env.MOKRILLION_MIN_BADGE ?? 61);
const MAX_BADGE = Number(process.env.MOKRILLION_MAX_BADGE ?? 89);

async function get(path: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: { "User-Agent": UA } });
    if (res.ok) return JSON.parse(await res.text());
    const wait = Number(res.headers.get("retry-after") ?? 5);
    if (attempt >= 3 || ![429, 503].includes(res.status)) throw new Error(`HTTP ${res.status} for ${path}`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

const query = `min_average_badge=${MIN_BADGE}&max_average_badge=${MAX_BADGE}&game_mode=normal`;
const heroStats = await get(`/v1/analytics/hero-stats?${query}`);
const itemStats = await get(`/v1/analytics/item-stats?${query}`);
if (!Array.isArray(heroStats) || !Array.isArray(itemStats)) throw new Error("unexpected response shape");

await writeFile(join(RAW_DIR, "deadlock-api-hero-stats.json"), JSON.stringify(heroStats));
await writeFile(join(RAW_DIR, "deadlock-api-item-stats.json"), JSON.stringify(itemStats));
const manifestPath = join(RAW_DIR, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.stats = { source: API, license: "MIT", fetchedAt: new Date().toISOString(), query, window: "API default (last 30 days)" };
await writeFile(manifestPath, JSON.stringify(manifest, null, 1));
console.log(`fetched stats for ${heroStats.length} heroes and ${itemStats.length} items (${query})`);
