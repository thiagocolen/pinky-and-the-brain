import { describe, it, expect, vi, afterAll } from "vitest";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";

/**
 * A scripted stand-in for a tool-calling chat model: each call returns the next
 * queued AIMessage, so a run can be driven through tool calls to a final reply
 * without any network access.
 */
class ScriptedChatModel extends BaseChatModel {
  script: AIMessage[];
  seen: BaseMessage[][] = [];

  constructor(script: AIMessage[]) {
    super({});
    this.script = script;
  }

  _llmType(): string {
    return "scripted-test-model";
  }

  bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const message = this.script.shift() ?? new AIMessage("Script exhausted, Pinky.");
    return {
      generations: [{ text: String(message.content ?? ""), message }],
      llmOutput: {},
    };
  }
}

const scripted = vi.hoisted(() => ({ model: undefined as any }));

/**
 * The agent builds its model once and holds it, so the test model must be
 * swappable behind a stable instance: this delegates each call to whichever
 * script the current test installed.
 */
class DelegatingChatModel extends BaseChatModel {
  _llmType(): string {
    return "delegating-test-model";
  }

  bindTools(tools: any[]): this {
    boundToolNames = tools.map((t) => t.name);
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    return scripted.model._generate(messages);
  }
}

/** Tool names the agent last bound to the model. */
let boundToolNames: string[] = [];

vi.mock("../../utils/model.js", () => ({
  createChatModel: () => new DelegatingChatModel({}),
}));

vi.mock("../../config.js", () => ({
  config: {
    anthropicApiKey: "mock-key-for-testing",
    anthropicModel: "claude-sonnet-5",
    patbaApiKey: "mock-key-for-testing",
  },
  projectRoot: process.cwd(),
}));

import { runGraphWorkflow, checkpointer } from "../../agents/graph.js";

/** Message content may be a plain string or an array of content blocks. */
function textOf(message: any): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block: any) => (typeof block === "string" ? block : block?.text ?? "")).join("\n");
  }
  return "";
}

describe("The Brain deep agent integration", () => {
  afterAll(async () => {
    await checkpointer.close();
  });

  const runId = Math.random().toString(36).substring(7);

  it("greets Pinky, consults the topic tool, and returns only the latest reply", async () => {
    scripted.model = new ScriptedChatModel([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call_1", name: "list_topics", args: {} }],
      }),
      new AIMessage(
        "Ah, Pinky! Behold my topics of expertise:\n1. AWS Cloud Practitioner Certification",
      ),
    ]);

    const progress: any[] = [];
    const result = await runGraphWorkflow(
      "the-brain",
      "hello",
      `test-greeting-${runId}`,
      (p) => progress.push(p),
    );

    const reply = result.instructorState?.explanation ?? "";
    expect(reply).toContain("Pinky");
    expect(reply).toContain("topics of expertise");
    // The reply must be the final message only, not a replay of the thread.
    expect(reply).not.toContain("Script exhausted");
    expect(progress.length).toBeGreaterThan(0);

    // The tool actually ran: its result is in the thread.
    const toolMessages = result.messages.filter((m: any) => m._getType?.() === "tool");
    expect(toolMessages.length).toBe(1);
    expect(String(toolMessages[0].content)).toContain("AWS Cloud Practitioner Certification");
  });

  it("receives the persona and journey instructions in its system prompt", async () => {
    const model = new ScriptedChatModel([new AIMessage("Narf-free response, Pinky.")]);
    scripted.model = model;

    await runGraphWorkflow("the-brain", "hello", `test-prompt-${runId}`, () => {});

    const systemText = model.seen[0]
      .filter((m: any) => m._getType() === "system")
      .map(textOf)
      .join("\n");

    expect(systemText).toContain("The Brain");
    expect(systemText).toContain("The user IS Pinky");
    expect(systemText).toContain("Step 1 — Greeting");
  });

  it("binds its own tools but never the subagent `task` tool", async () => {
    scripted.model = new ScriptedChatModel([new AIMessage("Behold, Pinky.")]);
    await runGraphWorkflow("the-brain", "hello", `test-tools-${runId}`, () => {});

    expect(boundToolNames).toContain("list_topics");
    expect(boundToolNames).toContain("save_article");
    // `task` delegates to a single-shot subagent this agent never uses, and
    // binding it makes Gemini return an empty completion.
    expect(boundToolNames).not.toContain("task");
  });

  it("reports an empty completion instead of returning a blank reply", async () => {
    // Reproduces the real Gemini failure: content [] with no tool calls.
    scripted.model = new ScriptedChatModel([new AIMessage({ content: [] })]);

    const result = await runGraphWorkflow("the-brain", "hello", `test-empty-${runId}`, () => {});

    const reply = result.instructorState?.explanation ?? "";
    expect(reply).not.toBe("");
    expect(reply).toMatch(/empty response/i);
  });

  it("keeps conversation history across turns on the same thread", async () => {
    const threadId = `test-memory-${runId}`;

    scripted.model = new ScriptedChatModel([new AIMessage("First, Pinky.")]);
    await runGraphWorkflow("the-brain", "hello", threadId, () => {});

    const second = new ScriptedChatModel([new AIMessage("Second, Pinky.")]);
    scripted.model = second;
    const result = await runGraphWorkflow("the-brain", "the first one", threadId, () => {});

    expect(result.instructorState?.explanation).toBe("Second, Pinky.");

    // The second turn saw the first turn's exchange.
    const humanTexts = second.seen[0]
      .filter((m: any) => m._getType() === "human")
      .map(textOf);
    expect(humanTexts).toContain("hello");
    expect(humanTexts).toContain("the first one");
  });
});
