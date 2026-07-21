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

  /**
   * The regression this covers.
   *
   * Left unset, `@langchain/anthropic` picks `maxTokens` from a table of known
   * model-name prefixes. `claude-sonnet-5` is not in that table, so it fell
   * through to a 4096 fallback — a fraction of the model's 128K ceiling — and
   * article-length replies came back cut off mid-sentence at `max_tokens`.
   */
  it("should send the configured output limit rather than leaving it to the default", async () => {
    vi.doMock("../../config.js", () => ({
      config: {
        anthropicApiKey: "mock-anthropic-key",
        anthropicModel: "claude-sonnet-5",
        anthropicMaxTokens: 16000,
        patbaApiKey: "brain-master-secure-key-1234",
      },
    }));

    const { createChatModel } = await import("../../utils/model.js");
    const model: any = createChatModel();
    expect(model.maxTokens).toBe(16000);
  });

  it("should honour an overridden output limit", async () => {
    vi.doMock("../../config.js", () => ({
      config: {
        anthropicApiKey: "mock-anthropic-key",
        anthropicModel: "claude-sonnet-5",
        anthropicMaxTokens: 8000,
        patbaApiKey: "brain-master-secure-key-1234",
      },
    }));

    const { createChatModel } = await import("../../utils/model.js");
    const model: any = createChatModel();
    expect(model.maxTokens).toBe(8000);
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
