/**
 * Language-model access. Everything a model returns is `model_judgment` evidence:
 * callers must never treat it as validated without a deterministic or independent check.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import OpenAI from "openai";
import { z } from "zod";
import { CapabilityError } from "../core/types.js";

export interface LlmService {
  readonly modelId: string;
  status(): { available: boolean; reason?: string };
  /** One request whose response is constrained to `schema`. */
  structured<S extends z.ZodType>(args: { system: string; prompt: string; schema: S; signal?: AbortSignal }): Promise<z.infer<S>>;
}

export class AnthropicLlm implements LlmService {
  readonly modelId: string;
  private client: Anthropic | null = null;

  constructor(modelId = process.env.MISSION_AI_MODEL ?? "claude-opus-5-5") {
    this.modelId = modelId;
  }

  status(): { available: boolean; reason?: string } {
    // The SDK resolves credentials from the environment or an `ant auth login` profile.
    const hasEnv = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    const hasProfile = existsSync(path.join(os.homedir(), ".config", "anthropic"));
    return hasEnv || hasProfile
      ? { available: true }
      : { available: false, reason: "No Anthropic credentials configured (set ANTHROPIC_API_KEY or run `ant auth login`)" };
  }

  async structured<S extends z.ZodType>(args: { system: string; prompt: string; schema: S; signal?: AbortSignal }): Promise<z.infer<S>> {
    const status = this.status();
    if (!status.available) throw new CapabilityError(status.reason!, { code: "llm_unavailable" });
    this.client ??= new Anthropic();
    try {
      const response = await this.client.beta.messages.parse(
        {
          model: this.modelId,
          max_tokens: 16000,
          // If the model declines for policy reasons, retry server-side on its default fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: args.system,
          messages: [{ role: "user", content: args.prompt }],
          output_config: { effort: "high", format: betaZodOutputFormat(args.schema) },
        },
        args.signal ? { signal: args.signal } : undefined,
      );
      if (response.stop_reason === "refusal") {
        throw new CapabilityError(`Model declined the request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}`, { code: "llm_refusal" });
      }
      if (response.stop_reason === "max_tokens") {
        throw new CapabilityError("Model output was truncated at max_tokens", { code: "llm_truncated" });
      }
      if (response.parsed_output === null || response.parsed_output === undefined) {
        throw new CapabilityError("Model returned output that does not match the requested schema", { code: "llm_invalid_output", retryable: true });
      }
      return response.parsed_output as z.infer<S>;
    } catch (err) {
      if (err instanceof CapabilityError) throw err;
      if (err instanceof Anthropic.AuthenticationError) {
        throw new CapabilityError("Anthropic credentials were rejected", { code: "llm_auth" });
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new CapabilityError("Anthropic API rate limit reached", { code: "llm_rate_limit", retryable: true });
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new CapabilityError(`Could not reach the Anthropic API: ${err.message}`, { code: "llm_network", retryable: true });
      }
      if (err instanceof Anthropic.APIError) {
        const status = typeof err.status === "number" ? err.status : 0;
        throw new CapabilityError(`Anthropic API error ${status}: ${err.message}`, { code: "llm_api", retryable: status >= 500 });
      }
      throw err;
    }
  }
}

/**
 * OpenAI provider. Uses Chat Completions with a JSON-schema response format; the reply is
 * validated against the zod schema here (one repair attempt), so a malformed reply can
 * never reach the pipeline as if it were structured data.
 */
export class OpenAiLlm implements LlmService {
  readonly modelId: string;
  private client: OpenAI | null = null;

  constructor(modelId = process.env.OPENAI_MODEL ?? "gpt-5.5", private readonly options: { fetch?: typeof fetch; apiKey?: string } = {}) {
    this.modelId = modelId;
  }

  status(): { available: boolean; reason?: string } {
    return this.options.apiKey || process.env.OPENAI_API_KEY
      ? { available: true }
      : { available: false, reason: "No OpenAI credentials configured (set OPENAI_API_KEY)" };
  }

  async structured<S extends z.ZodType>(args: { system: string; prompt: string; schema: S; signal?: AbortSignal }): Promise<z.infer<S>> {
    const status = this.status();
    if (!status.available) throw new CapabilityError(status.reason!, { code: "llm_unavailable" });
    this.client ??= new OpenAI({
      apiKey: this.options.apiKey ?? process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch as never } : {}),
    });
    const jsonSchema = z.toJSONSchema(args.schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: `${args.system}\n\nReply with a single JSON object that conforms to the provided JSON schema. No prose outside the JSON.` },
      { role: "user", content: args.prompt },
    ];
    try {
      let lastProblem = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await this.client.chat.completions.create(
          {
            model: this.modelId,
            messages,
            max_completion_tokens: 16000,
            response_format: { type: "json_schema", json_schema: { name: "result", schema: jsonSchema, strict: false } },
          },
          args.signal ? { signal: args.signal } : undefined,
        );
        const choice = response.choices[0];
        if (!choice) throw new CapabilityError("OpenAI returned no choices", { code: "llm_invalid_output", retryable: true });
        if (choice.message.refusal) throw new CapabilityError(`Model declined the request: ${choice.message.refusal.slice(0, 200)}`, { code: "llm_refusal" });
        if (choice.finish_reason === "length") throw new CapabilityError("Model output was truncated at the token limit", { code: "llm_truncated" });
        if (choice.finish_reason === "content_filter") throw new CapabilityError("Model output was blocked by the provider's content filter", { code: "llm_refusal" });
        const text = choice.message.content ?? "";
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          lastProblem = "the reply was not valid JSON";
          data = undefined;
        }
        if (data !== undefined) {
          const parsed = args.schema.safeParse(data);
          if (parsed.success) return parsed.data as z.infer<S>;
          lastProblem = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        }
        messages.push({ role: "assistant", content: text.slice(0, 20000) }, { role: "user", content: `That reply did not match the schema (${lastProblem}). Send the corrected JSON object only.` });
      }
      throw new CapabilityError(`Model returned output that does not match the requested schema: ${lastProblem}`, { code: "llm_invalid_output", retryable: true });
    } catch (err) {
      if (err instanceof CapabilityError) throw err;
      if (err instanceof OpenAI.AuthenticationError) throw new CapabilityError("OpenAI credentials were rejected", { code: "llm_auth" });
      if (err instanceof OpenAI.RateLimitError) throw new CapabilityError("OpenAI API rate limit or quota reached", { code: "llm_rate_limit", retryable: true });
      if (err instanceof OpenAI.APIConnectionError) throw new CapabilityError(`Could not reach the OpenAI API: ${err.message}`, { code: "llm_network", retryable: true });
      if (err instanceof OpenAI.APIError) {
        const code = typeof err.status === "number" ? err.status : 0;
        throw new CapabilityError(`OpenAI API error ${code}: ${err.message}`, { code: "llm_api", retryable: code >= 500 });
      }
      throw err;
    }
  }
}

/**
 * Pick the provider from the environment. `LLM_PROVIDER=openai|anthropic` forces one;
 * otherwise OpenAI is used when OPENAI_API_KEY is set, then Anthropic.
 */
export function createLlm(): LlmService {
  const forced = (process.env.LLM_PROVIDER ?? "").toLowerCase();
  if (forced === "openai") return new OpenAiLlm();
  if (forced === "anthropic") return new AnthropicLlm();
  if (process.env.OPENAI_API_KEY) return new OpenAiLlm();
  const anthropic = new AnthropicLlm();
  if (anthropic.status().available) return anthropic;
  return {
    modelId: "none",
    status: () => ({ available: false, reason: "No language-model credentials configured (set OPENAI_API_KEY or ANTHROPIC_API_KEY)" }),
    structured: () => Promise.reject(new CapabilityError("No language-model credentials configured (set OPENAI_API_KEY or ANTHROPIC_API_KEY)", { code: "llm_unavailable" })),
  };
}
