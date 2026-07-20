import { describe, it, expect, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

vi.mock("../../config.js", () => ({
  config: {
    anthropicApiKey: "mock-key-for-testing",
    anthropicModel: "claude-sonnet-5",
    patbaApiKey: "mock-key-for-testing",
    blogRepoPath: "/nonexistent/blog-checkout",
    geminiApiKey: "",
    geminiImageModel: "gemini-3.1-flash-lite-image",
  },
  projectRoot: process.cwd(),
}));

import { extractTurnReply } from "../../agents/graph.js";

/**
 * The regression this file exists for.
 *
 * A model may speak *and* call a tool in the same message. The journey does
 * exactly that at the end of a publish: it reports the pull request and, per
 * Step 5, calls `list_topics` to re-present the menu — so the sentence naming
 * the pull request sits in a message followed by a tool call and a final menu
 * message. Returning only the last message with text meant a published article
 * came back to the caller as a bare topic menu: no PR number, no branch, no
 * link, and no sign anything had happened at all.
 *
 * The message sequence below is taken from the checkpoint of the run that
 * produced pull request #49.
 */
const publishTurn = () => [
  new HumanMessage("Confirmed. Push the branch and open the pull request as a draft post."),
  new AIMessage({
    content: "",
    tool_calls: [{ id: "1", name: "publish_article", args: { filename: "ai-tooling.md" } }],
  }),
  new ToolMessage({
    tool_call_id: "1",
    content: "Published to thiagocolen.github.io: https://github.com/thiagocolen/thiagocolen.github.io/pull/49",
  }),
  new AIMessage({
    content:
      "Behold, Pinky — the pull request stands ready: https://github.com/thiagocolen/thiagocolen.github.io/pull/49. It is a draft, awaiting review. Now, let me summon the topics once more.",
    tool_calls: [{ id: "2", name: "list_topics", args: {} }],
  }),
  new ToolMessage({ tool_call_id: "2", content: '[{"id":"aws"}]' }),
  new AIMessage("Here stand our pillars of erudition once again, Pinky: 1. AWS…"),
];

describe("extractTurnReply", () => {
  it("keeps a delivery report that shares its message with a tool call", () => {
    const reply = extractTurnReply(publishTurn());
    expect(reply).toContain("/pull/49");
    expect(reply).toContain("awaiting review");
  });

  it("still returns the closing menu alongside it", () => {
    expect(extractTurnReply(publishTurn())).toContain("pillars of erudition");
  });

  it("does not re-send replies from earlier turns", () => {
    const messages = [
      new HumanMessage("hello"),
      new AIMessage("An earlier reply Pinky has already read."),
      new HumanMessage("go on"),
      new AIMessage("The current reply."),
    ];
    const reply = extractTurnReply(messages);
    expect(reply).toBe("The current reply.");
    expect(reply).not.toContain("earlier reply");
  });

  it("ignores messages with no text of their own", () => {
    const messages = [
      new HumanMessage("publish it"),
      new AIMessage({ content: "", tool_calls: [{ id: "1", name: "publish_article", args: {} }] }),
      new ToolMessage({ tool_call_id: "1", content: "done" }),
      new AIMessage("Done, Pinky."),
    ];
    expect(extractTurnReply(messages)).toBe("Done, Pinky.");
  });

  it("reads content blocks, not just plain strings", () => {
    const messages = [
      new HumanMessage("go"),
      new AIMessage({ content: [{ type: "text", text: "Block content." }] as any }),
    ];
    expect(extractTurnReply(messages)).toBe("Block content.");
  });

  it("returns nothing when the model genuinely said nothing", () => {
    const messages = [
      new HumanMessage("go"),
      new AIMessage({ content: "", tool_calls: [{ id: "1", name: "list_topics", args: {} }] }),
    ];
    expect(extractTurnReply(messages)).toBe("");
  });
});
