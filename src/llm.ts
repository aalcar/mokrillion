// Single entry point for LLM calls: structured output, validation retries, disk cache,
// token/cost accounting and a per-run budget. Supports Anthropic and Google Gemini; a run
// switches to Gemini if Anthropic rejects the credentials or the account is out of credit.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ApiError, GoogleGenAI } from "@google/genai";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
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

type Provider = "anthropic" | "gemini";

// $ per million tokens: input, output, cache read, cache write (5m). Unlisted models (e.g. Gemini free tier) count as $0.
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

export const usage = {
  calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0,
  models: new Set<string>(),
};

/** Models that actually answered during this run (cache hits excluded). */
export const modelsUsed = () => [...usage.models].join(" + ") || "cache only";

export function usageSummary(): string {
  const u = usage;
  return `LLM: ${u.calls} calls (+${u.cacheHits} cached), in ${u.inputTokens} / out ${u.outputTokens} / cache read ${u.cacheReadTokens} / cache write ${u.cacheWriteTokens} tokens, ~$${u.costUSD.toFixed(2)} (${modelsUsed()})`;
}

const CACHE_DIR = join(import.meta.dirname, "../data/cache/llm");

interface Attempt<T> {
  out: T | null;
  /** Why the output is unusable (schema mismatch, truncation), or undefined. */
  problem?: string;
}

/** Anthropic failures that mean "this account can't be used right now", not "this request was bad". */
function anthropicUnavailable(e: unknown): boolean {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return true;
  if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message)) return true;
  return e instanceof Error && /Could not resolve authentication method/.test(e.message);
}

export function createAsk({ useCache = true } = {}): Ask {
  let provider: Provider =
    config.provider ?? (process.env.ANTHROPIC_API_KEY || !process.env.GEMINI_API_KEY ? "anthropic" : "gemini");
  let anthropic: Anthropic | undefined;
  let gemini: GoogleGenAI | undefined;
  const modelFor = (p: Provider) => (p === "anthropic" ? config.model : config.geminiModel);

  async function callAnthropic<T>(opts: AskOptions<T>, prompt: string): Promise<Attempt<T>> {
    anthropic ??= new Anthropic({ timeout: 10 * 60 * 1000 });
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (opts.context) content.push({ type: "text", text: opts.context, cache_control: { type: "ephemeral" } });
    content.push({ type: "text", text: prompt });
    const res = await anthropic.beta.messages.parse({
      model: config.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: config.effort, format: betaZodOutputFormat(opts.schema) },
      system: opts.system,
      messages: [{ role: "user", content }],
    });
    const u = res.usage;
    record(config.model, u.input_tokens, u.output_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0);
    if (res.stop_reason === "refusal") throw new Error(`${opts.label}: model refused (${res.stop_details?.category})`);
    return res.parsed_output == null
      ? { out: null, problem: `output did not match the schema (stop_reason ${res.stop_reason})` }
      : { out: res.parsed_output };
  }

  async function callGemini<T>(opts: AskOptions<T>, prompt: string): Promise<Attempt<T>> {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
    gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const { $schema, ...jsonSchema } = z.toJSONSchema(opts.schema) as Record<string, unknown>;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await gemini.models.generateContent({
          model: config.geminiModel,
          contents: [{ role: "user", parts: [...(opts.context ? [{ text: opts.context }] : []), { text: prompt }] }],
          config: {
            systemInstruction: opts.system,
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchema,
            maxOutputTokens: 16000,
          },
        });
        const u = res.usageMetadata;
        record(config.geminiModel, u?.promptTokenCount ?? 0, (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0), u?.cachedContentTokenCount ?? 0, 0);
        let json: unknown;
        try {
          json = JSON.parse(res.text ?? "");
        } catch {
          return { out: null, problem: `response was not valid JSON (finish reason ${res.candidates?.[0]?.finishReason})` };
        }
        const parsed = opts.schema.safeParse(json);
        return parsed.success ? { out: parsed.data } : { out: null, problem: `output did not match the schema: ${parsed.error.issues[0]?.message}` };
      } catch (e) {
        // Free-tier rate limits are tight: back off and retry a few times.
        if (e instanceof ApiError && (e.status === 429 || e.status === 503) && attempt < 5) {
          const wait = 15 * attempt;
          console.warn(`${opts.label}: Gemini ${e.status}, retrying in ${wait}s`);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        throw e;
      }
    }
  }

  return async function ask<T>(opts: AskOptions<T>): Promise<T> {
    // Cache key uses the configured model of the provider that will answer, so providers never share answers.
    const cacheFile = () =>
      join(CACHE_DIR, `${createHash("sha256")
        .update(JSON.stringify([modelFor(provider), config.effort, opts.system, opts.context ?? "", opts.prompt]))
        .digest("hex")}.json`);
    if (useCache && existsSync(cacheFile())) {
      const cached = opts.schema.parse(JSON.parse(readFileSync(cacheFile(), "utf8")));
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
      let result: Attempt<T>;
      const used = provider; // parallel calls may switch `provider` while this one is in flight
      try {
        result = used === "anthropic" ? await callAnthropic(opts, prompt) : await callGemini(opts, prompt);
      } catch (e) {
        if (used === "anthropic" && process.env.GEMINI_API_KEY && anthropicUnavailable(e)) {
          if (provider === "anthropic") {
            console.warn(`Anthropic unavailable (${(e as Error).message.slice(0, 120)}); switching to Gemini ${config.geminiModel} for the rest of this run.`);
            provider = "gemini";
          }
          return ask(opts); // re-check the cache under the Gemini model
        }
        throw e;
      }
      const problem = result.problem ?? (result.out !== null ? opts.validate?.(result.out) : "no output");
      if (!problem) {
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(cacheFile(), JSON.stringify(result.out));
        return result.out!;
      }
      if (attempt >= config.maxRetries) throw new Error(`${opts.label}: ${problem}`);
      console.warn(`${opts.label}: retrying (${problem})`);
      prompt = `${opts.prompt}\n\nYour previous answer was rejected: ${problem}. Fix this.`;
    }
  };
}

function record(model: string, input: number, output: number, cacheRead: number, cacheWrite: number) {
  const [pin, pout, pread, pwrite] = PRICES[model] ?? [0, 0, 0, 0];
  usage.calls++;
  usage.models.add(model);
  usage.inputTokens += input;
  usage.outputTokens += output;
  usage.cacheReadTokens += cacheRead;
  usage.cacheWriteTokens += cacheWrite;
  usage.costUSD += (input * pin + output * pout + cacheRead * pread + cacheWrite * pwrite) / 1e6;
}
