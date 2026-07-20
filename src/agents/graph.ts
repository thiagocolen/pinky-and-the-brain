import { HumanMessage } from "@langchain/core/messages";
import { createBrainAgent, checkpointer } from "./agent.js";
import { AgentWorkspaceState, AgentProgress, BrainAgent } from "./types.js";
import { isAIMessage, isHumanMessage, getMessageContent } from "../utils/messages.js";
import { logger } from "../utils/logger.js";

export { checkpointer };

let agentInstance: BrainAgent | undefined;

/**
 * The agent is built on first use rather than at import time: constructing it
 * requires an LLM API key, and importing this module must not throw for
 * consumers that only need the types or the checkpointer.
 */
export function getGraph(): BrainAgent {
  if (!agentInstance) {
    agentInstance = createBrainAgent();
  }
  return agentInstance;
}

/**
 * The compiled agent, for LangGraph Studio (`langgraph.json`) and the SDK
 * re-exports. Proxied so that construction stays lazy while `import { graph }`
 * keeps working.
 */
export const graph: BrainAgent = new Proxy({} as BrainAgent, {
  get: (_target, prop, receiver) => Reflect.get(getGraph(), prop, receiver),
  has: (_target, prop) => Reflect.has(getGraph(), prop),
});

/**
 * Message content may be a plain string or an array of content blocks,
 * depending on the provider.
 */
function textOf(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => (typeof block === "string" ? block : (block?.text ?? "")))
      .join("")
      .trim();
  }
  return getMessageContent(message);
}

/**
 * Returns everything the assistant said during the turn that is now finishing.
 *
 * Not just the final message: a model may speak *and* call a tool in the same
 * message, and when it does, the text and the tool call travel together. The
 * journey ends an article delivery by reporting the pull request and then, per
 * Step 5, calling `list_topics` to re-present the menu — so the sentence naming
 * the pull request lives in a message that is followed by a tool call and a
 * final menu message. Returning only the last message with text silently
 * discarded the delivery report, which is exactly how a published article came
 * back to the caller as a bare topic menu with no PR number, branch or link.
 *
 * Scanning back to the last human message bounds this to the current turn, so
 * earlier replies in the thread are never re-sent.
 */
export function extractTurnReply(messages: any[]): string {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isHumanMessage(messages[i])) {
      start = i + 1;
      break;
    }
  }

  const spoken: string[] = [];
  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (!isAIMessage(message)) continue;
    const content = textOf(message).trim();
    if (content) spoken.push(content);
  }

  return spoken.join("\n\n");
}

/**
 * Runs one turn of the conversation.
 *
 * Signature and return shape are unchanged from the previous LangGraph
 * implementation, so the CLI, REST, MCP and ACP entry points are unaffected.
 * `agentName` is accepted for compatibility; there is a single agent now.
 */
export async function runGraphWorkflow(
  agentName: string,
  prompt: string,
  threadId: string,
  progressCallback: (status: AgentProgress) => void,
): Promise<AgentWorkspaceState> {
  const config = { configurable: { thread_id: threadId } };

  progressCallback({
    threadId,
    node: "the-brain",
    status: `Starting agent workflow for: ${agentName}`,
    timestamp: new Date().toISOString(),
  });

  const result = await getGraph().invoke(
    { messages: [new HumanMessage(prompt)] },
    config,
  );

  const messages = (result as any).messages ?? [];
  let explanation = extractTurnReply(messages);

  if (!explanation) {
    // Returning "" here would surface as a blank reply, which reads like a
    // hang. Say so instead: an empty completion is a model-side failure the
    // user can act on (usually by retrying or switching provider).
    logger.warn("[Brain] Run produced no assistant text; the model returned an empty completion.");
    explanation =
      "Pinky, my cortex returned nothing at all — the model produced an empty response. Try again, or check the LLM provider configuration.";
  }

  progressCallback({
    threadId,
    node: "the-brain",
    status: "Run complete",
    timestamp: new Date().toISOString(),
  });

  return {
    ...(result as object),
    messages,
    // Only the latest reply: the thread's full history lives in `messages`, and
    // callers render `explanation` directly.
    instructorState: {
      userQuestion: prompt,
      explanation,
    },
  } as AgentWorkspaceState;
}
