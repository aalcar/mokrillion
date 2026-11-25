// Single entry point for LLM calls: structured output, validation retries, disk cache,
// token/cost accounting and a per-run budget.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { config } from "./config.ts";

export interface AskOptions<T> {
  /** Short name for logs, e.g. "rank:item-cost:3200#2". */
  label: string;
  system: string;
  /** Large stable block (e.g. the candidate universe), sent first and prompt-cached. */
  context?: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Return an error message to make the model retry, or null if the output is acceptable. */
  validate?: (output: T) => string | null;
}

export type Ask = <T>(opts: AskOptions<T>) => Promise<T>;

// $ per million tokens: input, output, cache read, cache write (5m).
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

export const usage = { calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0 };

export function usageSummary(): string {
  const u = usage;
  return `LLM: ${u.calls} calls (+${u.cacheHits} cached), in ${u.inputTokens} / out ${u.outputTokens} / cache read ${u.cacheReadTokens} / cache write ${u.cacheWriteTokens} tokens, ~$${u.costUSD.toFixed(2)} (${config.model})`;
}

const CACHE_DIR = join(import.meta.dirname, "../data/cache/llm");

export function createAsk({ useCache = true } = {}): Ask {
  const client = new Anthropic({ timeout: 10 * 60 * 1000 });

  return async function ask<T>(opts: AskOptions<T>): Promise<T> {
    const key = createHash("sha256")
      .update(JSON.stringify([config.model, config.effort, opts.system, opts.context ?? "", opts.prompt]))
      .digest("hex");
    const cacheFile = join(CACHE_DIR, `${key}.json`);
    if (useCache && existsSync(cacheFile)) {
      const cached = opts.schema.parse(JSON.parse(readFileSync(cacheFile, "utf8")));
      if (!opts.validate?.(cached)) {
        usage.cacheHits++;
        return cached;
      }
    }

    let prompt = opts.prompt;
    for (let attempt = 0; ; attempt++) {
      if (usage.costUSD >= config.maxCostUSD) {
        throw new Error(`LLM budget of $${config.maxCostUSD} reached (set MOKRILLION_MAX_COST_USD to raise it)`);
      }
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      if (opts.context) content.push({ type: "text", text: opts.context, cache_control: { type: "ephemeral" } });
      content.push({ type: "text", text: prompt });

      const res = await client.beta.messages.parse({
        model: config.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: config.effort, format: betaZodOutputFormat(opts.schema) },
        system: opts.system,
        messages: [{ role: "user", content }],
      });
      record(res.usage);

      if (res.stop_reason === "refusal") throw new Error(`${opts.label}: model refused (${res.stop_details?.category})`);
      const out = res.parsed_output;
      const problem = out == null ? `output did not match the schema (stop_reason ${res.stop_reason})` : opts.validate?.(out);
      if (!problem) {
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(out));
        return out!;
      }
      if (attempt >= config.maxRetries) throw new Error(`${opts.label}: ${problem}`);
      console.warn(`${opts.label}: retrying (${problem})`);
      prompt = `${opts.prompt}\n\nYour previous answer was rejected: ${problem}. Fix this.`;
    }
  };
}

function record(u: Anthropic.Beta.BetaUsage) {
  const [pin, pout, pread, pwrite] = PRICES[config.model] ?? [0, 0, 0, 0];
  usage.calls++;
  usage.inputTokens += u.input_tokens;
  usage.outputTokens += u.output_tokens;
  usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
  usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
  usage.costUSD +=
    (u.input_tokens * pin + u.output_tokens * pout +
      (u.cache_read_input_tokens ?? 0) * pread + (u.cache_creation_input_tokens ?? 0) * pwrite) / 1e6;
}
