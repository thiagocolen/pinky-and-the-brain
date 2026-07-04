import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Model Factory", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should return ChatGoogleGenerativeAI when googleApiKey is configured", async () => {
    vi.doMock("../../config.js", () => ({
      config: {
        googleApiKey: "mock-google-key",
        openaiApiKey: "",
        geminiModel: "gemini-2.5-flash",
        patbaApiKey: "brain-master-secure-key-1234",
      },
    }));

    const { createChatModel } = await import("../../utils/model.js");
    const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
    
    const model = createChatModel(0.3);
    expect(model).toBeInstanceOf(ChatGoogleGenerativeAI);
  });

  it("should return ChatOpenAI when only openaiApiKey is configured", async () => {
    vi.doMock("../../config.js", () => ({
      config: {
        googleApiKey: "",
        openaiApiKey: "mock-openai-key",
        geminiModel: "gemini-2.5-flash",
        patbaApiKey: "brain-master-secure-key-1234",
      },
    }));

    const { createChatModel } = await import("../../utils/model.js");
    const { ChatOpenAI } = await import("@langchain/openai");
    
    const model = createChatModel(0.3);
    expect(model).toBeInstanceOf(ChatOpenAI);
  });

  it("should throw an error when neither key is configured", async () => {
    vi.doMock("../../config.js", () => ({
      config: {
        googleApiKey: "",
        openaiApiKey: "",
        geminiModel: "gemini-2.5-flash",
        patbaApiKey: "brain-master-secure-key-1234",
      },
    }));

    const { createChatModel } = await import("../../utils/model.js");
    
    expect(() => createChatModel(0.3)).toThrow(/No LLM API keys provided/);
  });
});
