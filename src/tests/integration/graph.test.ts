import { describe, it, expect, vi, afterAll } from "vitest";
import { HumanMessage } from "@langchain/core/messages";

// Mock ChatOpenAI to prevent real LLM network requests and simulate responses
vi.mock("@langchain/openai", () => {
  return {
    ChatOpenAI: vi.fn().mockImplementation(() => {
      return {
        invoke: vi.fn().mockImplementation(async (messages: any[]) => {
          const systemMsg = messages.find(m => m._getType() === "system" || m.constructor.name === "SystemMessage");
          const systemContent = systemMsg ? String(systemMsg.content) : "";
          
          if (systemContent.includes("routing Pinky's query")) {
            return {
              content: `The same thing we do every night, Pinky—try to take over the world! Let us consult the archives.`,
            };
          } else if (systemContent.includes("specialist agent available") || systemContent.includes("Explain your capabilities")) {
            return {
              content: `The same thing we do every night, Pinky—try to take over the world!
I must inform you that no specialist agent is available for your specific query. However, my supreme intellect has developed four specialized areas of expertise:
- **aws-tutor**: AWS Certified Cloud Practitioner prep.
- **cellular-automata**: Conway's Game of Life.
- **english-certification-instructor**: IELTS, TOEFL, Cambridge coach.
- **job-technical-interviewer**: Frontend mock job interview simulator.`,
            };
          } else {
            // Specialist lesson response
            return {
              content: `Here is the lesson for the requested topic. Let's start with a quick introduction.`,
            };
          }
        })
      };
    })
  };
});

// Mock config to ensure openaiApiKey is set so mocks trigger instead of raw code mock fallback
vi.mock("../../config.js", () => {
  return {
    config: {
      openaiApiKey: "mock-key-for-testing",
      patbaApiKey: "mock-key-for-testing",
    },
    projectRoot: process.cwd(),
  };
});

// Import graph after mocking modules
import { graph, checkpointer } from "../../agents/graph.js";

describe("LangGraph Agent Workflow Integration", () => {
  afterAll(async () => {
    await checkpointer.close();
  });
  const runId = Math.random().toString(36).substring(7);

  it("should compile and invoke the graph successfully", async () => {
    const config = {
      configurable: {
        thread_id: `test-thread-id-1-${runId}`,
      },
    };

    const stateOutput = await graph.invoke({
      messages: [new HumanMessage("Explain Conway's Game of Life")],
      nextAgent: "the-brain",
    }, config);

    expect(stateOutput.messages).toBeDefined();
    expect(stateOutput.messages.length).toBe(2);
    const lastMsg = stateOutput.messages[stateOutput.messages.length - 1];
    expect(lastMsg.content).toContain("The same thing we do every night");
    expect(lastMsg.content).toContain("lesson for the requested topic");
  });

  it("should explain capabilities when the user asks for help", async () => {
    const config = {
      configurable: {
        thread_id: `test-help-thread-1-${runId}`,
      },
    };

    const stateOutput = await graph.invoke({
      messages: [new HumanMessage("Explain your capabilities")],
      nextAgent: "the-brain",
    }, config);

    expect(stateOutput.messages).toBeDefined();
    expect(stateOutput.messages.length).toBe(2);
    const lastMsg = stateOutput.messages[stateOutput.messages.length - 1];
    expect(lastMsg.content).toContain("The same thing we do every night");
    expect(lastMsg.content).toContain("aws-tutor");
    expect(lastMsg.content).toContain("cellular-automata");
    expect(lastMsg.content).toContain("english-certification-instructor");
    expect(lastMsg.content).toContain("job-technical-interviewer");
  });
});
