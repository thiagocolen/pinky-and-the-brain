import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { config } from "../config.js";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";

/**
 * Creates the appropriate Chat Model based on available configuration.
 * Prefers Google Generative AI (Gemini) if GOOGLE_API_KEY is configured,
 * otherwise falls back to OpenAI if OPENAI_API_KEY is configured.
 */
export function createChatModel(temperature: number): BaseChatModel {
  if (config.googleApiKey) {
    return new ChatGoogleGenerativeAI({
      apiKey: config.googleApiKey,
      model: config.geminiModel,
      temperature,
    });
  }

  if (config.openaiApiKey) {
    return new ChatOpenAI({
      openAIApiKey: config.openaiApiKey,
      modelName: "gpt-4-turbo",
      temperature,
    });
  }

  throw new Error("No LLM API keys provided. Please set OPENAI_API_KEY or GOOGLE_API_KEY.");
}
