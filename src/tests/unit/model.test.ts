import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Model Factory", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should return ChatAnthropic when anthropicApiKey is configured", async () => {
    vi.doMock("../../config.js", () => ({
      config: {
        anthropicApiKey: "mock-anthropic-key",
        anthropicModel: "claude-sonnet-5",
        patbaApiKey: "brain-master-secure-key-1234",
      },
    }));

    const { createChatModel } = await import("../../utils/model.js");
    const { ChatAnthropic } = await import("@langchain/anthropic");

    const model = createChatModel();
    expect(model).toBeInstanceOf(ChatAnthropic);
  });

  it("should use the configured Anthropic model name", async () => {
    vi.doMock("../../config.js", () => ({
      config: {
        anthropicApiKey: "mock-anthropic-key",
        anthropicModel: "claude-opus-4-8",
        patbaApiKey: "brain-master-secure-key-1234",
      },
    }));

    const { createChatModel } = await import("../../utils/model.js");
    const model: any = createChatModel();
    expect(model.model).toBe("claude-opus-4-8");
  });

  it("should throw an error when the Anthropic key is missing", async () => {
    vi.doMock("../../config.js", () => ({
      config: {
        anthropicApiKey: "",
        anthropicModel: "claude-sonnet-5",
        patbaApiKey: "brain-master-secure-key-1234",
      },
    }));

    const { createChatModel } = await import("../../utils/model.js");

    // Anthropic is the only provider: a missing key is an error, never a
    // silent fallback to another provider.
    expect(() => createChatModel()).toThrow(/No Anthropic API key provided/);
  });
});
