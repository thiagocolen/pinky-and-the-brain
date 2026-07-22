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

import { extractTurnReply, wasTruncated } from "../../agents/graph.js";

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

/**
 * A reply cut off at the output limit still arrives, still reads like prose,
 * and still ends on what looks like a sentence — so a caller cannot tell it
 * apart from a finished one. `stop_reason` is the only signal that it was
 * severed, which is how an MCP consumer came to report truncated responses.
 */
describe("wasTruncated", () => {
  const cutOff = (text: string) =>
    new AIMessage({ content: text, response_metadata: { stop_reason: "max_tokens" } });

  it("spots a reply the model stopped at max_tokens", () => {
    const messages = [
      new HumanMessage("write the article"),
      cutOff("…this matrix need not be symmetrical"),
    ];
    expect(wasTruncated(messages)).toBe(true);
  });

  it("leaves a reply that finished on its own alone", () => {
    const messages = [
      new HumanMessage("write the article"),
      new AIMessage({
        content: "There, Pinky. The manuscript is complete.",
        response_metadata: { stop_reason: "end_turn" },
      }),
    ];
    expect(wasTruncated(messages)).toBe(false);
  });

  it("ignores a truncation from an earlier turn", () => {
    const messages = [
      new HumanMessage("write the article"),
      cutOff("…severed mid-thought, but Pinky has already moved on"),
      new HumanMessage("never mind, list the topics"),
      new AIMessage({
        content: "Here stand our pillars of erudition, Pinky.",
        response_metadata: { stop_reason: "end_turn" },
      }),
    ];
    expect(wasTruncated(messages)).toBe(false);
  });

  it("spots a truncation in a message followed by a tool call", () => {
    const messages = [
      new HumanMessage("write the article"),
      cutOff("…the sentence that never ended"),
      new ToolMessage({ tool_call_id: "1", content: "saved" }),
      new AIMessage({ content: "Saved.", response_metadata: { stop_reason: "end_turn" } }),
    ];
    expect(wasTruncated(messages)).toBe(true);
  });

  it("copes with messages carrying no metadata at all", () => {
    expect(wasTruncated([new HumanMessage("go"), new AIMessage("A plain reply.")])).toBe(false);
  });
});
