import { ChatAnthropic } from "@langchain/anthropic";
import { config } from "../config.js";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";

/**
 * Creates the Chat Model used by every agent.
 *
 * Anthropic is the only supported provider: `ANTHROPIC_API_KEY` is required,
 * and its absence is an error rather than a reason to fall back to another
 * provider.
 *
 * No `temperature` is sent. Claude Sonnet 5 rejects the parameter outright
 * (`temperature is deprecated for this model`), so the model's own default is
 * used.
 *
 * `maxTokens` is the opposite case — it must be stated, because the default
 * cannot be trusted. `@langchain/anthropic` derives one from a table of known
 * model-name prefixes, and `claude-sonnet-5` is not in it, so it falls through
 * to a 4096 fallback: a small fraction of the model's 128K ceiling. Sonnet 5
 * also thinks adaptively by default and thinking tokens come out of this same
 * budget, so an article-length turn stopped mid-sentence at `max_tokens`.
 *
 * It cannot simply be set to the model's ceiling, either: see
 * `anthropicMaxTokens` in the config for the non-streaming limit that bounds it.
 */
export function createChatModel(): BaseChatModel {
  if (!config.anthropicApiKey) {
    throw new Error(
      "No Anthropic API key provided. Please set ANTHROPIC_API_KEY to use the agent.",
    );
  }

  return new ChatAnthropic({
    apiKey: config.anthropicApiKey,
    model: config.anthropicModel,
    maxTokens: config.anthropicMaxTokens,
  });
}
