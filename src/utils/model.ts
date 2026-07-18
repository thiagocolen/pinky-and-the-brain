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
  });
}
