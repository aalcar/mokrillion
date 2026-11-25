// Manually run: downloads a raw snapshot of deadlock.wiki data into data/raw/.
// Everything fetched is untrusted data: parsed with JSON.parse only, never executed.
// Wiki content is CC BY-NC-SA 4.0 (https://deadlock.wiki).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = "https://deadlock.wiki";
const UA = "mokrillion-ingest/0.1 (private non-commercial trivia game)";
const RAW_DIR = join(import.meta.dirname, "../../data/raw");

export const DATA_PAGES = [
  "HeroData",
  "ItemData",
  "AbilityCards",
  "ItemCards",
  "Lang en",
  "ItemPopularity",
  "LatestUpdate",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    await sleep(1000); // be polite: ~1 request/second
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) return await res.text();
      if (attempt >= 3 || res.status < 500) throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
}

const api = async (params: Record<string, string>): Promise<any> =>
  JSON.parse(await get(`${BASE}/api.php?${new URLSearchParams({ format: "json", ...params })}`));

/** Follows MediaWiki "continue" until done, collecting the result of `pick` for each page. */
async function apiAll<T>(params: Record<string, string>, pick: (r: any) => T[]): Promise<T[]> {
  const out: T[] = [];
  let cont: Record<string, string> = {};
  do {
    const r = await api({ ...params, ...cont });
    out.push(...pick(r));
    cont = r.continue ?? {};
  } while (Object.keys(cont).length);
  return out;
}

const categoryMembers = (cat: string): Promise<string[]> =>
  apiAll({ action: "query", list: "categorymembers", cmtitle: `Category:${cat}`, cmnamespace: "0", cmlimit: "500" },
    (r) => r.query.categorymembers.map((m: any) => m.title as string));

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  const fileName = (page: string) => `${page.replace(/ /g, "_")}.json`;

  for (const page of DATA_PAGES) {
    const text = await get(`${BASE}/index.php?title=${encodeURIComponent(`Data:${page}.json`)}&action=raw`);
    JSON.parse(text); // fail loudly on non-JSON
    await writeFile(join(RAW_DIR, fileName(page)), text);
    console.log(`fetched Data:${page}.json`);
  }

  const revs = await api({ action: "query", prop: "revisions", rvprop: "ids",
    titles: DATA_PAGES.map((p) => `Data:${p}.json`).join("|") });
  const revisions: Record<string, number> = {};
  for (const p of Object.values<any>(revs.query.pages)) revisions[p.title] = p.revisions?.[0]?.revid;

  // Categories: hero/item membership + hero trait categories (ready-made predicates).
  const traitCats = await apiAll<string>({ action: "query", list: "allcategories", aclimit: "500", acprefix: "Heroes " },
    (r) => r.query.allcategories.map((c: any) => c["*"] as string));
  const categories: Record<string, string[]> = {};
  for (const cat of ["Heroes", "Items", ...traitCats.filter((c) => !c.includes("/"))]) {
    categories[cat] = await categoryMembers(cat);
    console.log(`category ${cat}: ${categories[cat].length}`);
  }

  // Redirects pointing at hero and item pages, used as alias candidates.
  const titles = [...new Set([...categories.Heroes, ...categories.Items])];
  const redirects: Record<string, string[]> = {};
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50).join("|");
    await apiAll({ action: "query", titles: batch, prop: "redirects", rdlimit: "500", rdnamespace: "0" }, (r) => {
      for (const p of Object.values<any>(r.query.pages)) {
        (redirects[p.title] ??= []).push(...(p.redirects ?? []).map((x: any) => x.title));
      }
      return [];
    });
  }

  await writeFile(join(RAW_DIR, "categories.json"), JSON.stringify(categories, null, 1));
  await writeFile(join(RAW_DIR, "redirects.json"), JSON.stringify(redirects, null, 1));
  await writeFile(join(RAW_DIR, "manifest.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), source: BASE, license: "CC BY-NC-SA 4.0", revisions }, null, 1));
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
