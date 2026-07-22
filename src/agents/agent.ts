import { createDeepAgent } from "deepagents";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createChatModel } from "../utils/model.js";
import { SQLiteCheckpointer } from "../storage/sqlite.js";
import { BRAIN_SYSTEM_PROMPT } from "./prompts.js";
import { brainTools } from "./tools.js";
import { BrainAgent } from "./types.js";

/** Shared across runs so conversation threads survive between invocations. */
export const checkpointer = new SQLiteCheckpointer();

/**
 * Built-in Deep Agents tools this agent never uses.
 *
 * `task` delegates to a subagent with an isolated, single-shot context. Both of
 * this agent's modes — teaching and article writing — are multi-turn dialogues
 * with the user, so delegation cannot serve them.
 *
 * Removing it is also a hard requirement for Gemini: with `task` bound, Gemini
 * returns an empty completion (`finishReason: STOP`, zero output tokens) instead
 * of a reply. Dropping this one schema makes it answer normally.
 */
const DISABLED_BUILTIN_TOOLS = new Set(["task"]);

/**
 * `createDeepAgent` appends its built-in tools itself and offers no option to
 * opt out, so the filter is applied at the model boundary: every tool binding
 * passes through here on its way to the provider.
 */
function withoutDisabledTools(model: BaseChatModel): BaseChatModel {
  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop !== "bindTools") return Reflect.get(target, prop, receiver);
      return (tools: any[], kwargs?: unknown) =>
        (target as any).bindTools(
          tools.filter((t) => !DISABLED_BUILTIN_TOOLS.has(t?.name)),
          kwargs,
        );
    },
  });
}

/**
 * Builds The Brain: a deep agent that guides Pinky through topics, teaching or
 * writing articles.
 *
 * The built-in Deep Agents base prompt is removed (`base: null`) because it
 * instructs a task-executing coding agent; this agent is a persona-driven
 * conversational guide, and the two sets of instructions would fight for the
 * model's attention. The planning and virtual-filesystem tools remain available.
 */
export function createBrainAgent(): BrainAgent {
  return createDeepAgent({
    name: "the-brain",
    model: withoutDisabledTools(createChatModel()),
    tools: brainTools,
    systemPrompt: {
      prefix: BRAIN_SYSTEM_PROMPT,
      base: null,
    },
    checkpointer,
  }) as unknown as BrainAgent;
}
