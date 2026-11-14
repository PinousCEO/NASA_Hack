/**
 * Language-model access. Everything a model returns is `model_judgment` evidence:
 * callers must never treat it as validated without a deterministic or independent check.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
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
