import { describe, it, expect, vi } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";

// Mock the OpenAI model to avoid real rate limits and network calls
vi.mock("@langchain/openai", () => {
  return {
    ChatOpenAI: vi.fn().mockImplementation(() => {
      return {
        invoke: vi.fn().mockImplementation(async (messages: any[]) => {
          // Identify which node is invoking the LLM based on system message content
          const systemMsg = messages.find(m => m._getType() === "system" || m.constructor.name === "SystemMessage");
          const systemContent = systemMsg ? String(systemMsg.content) : "";

          if (systemContent.includes("routing Pinky's query")) {
            return {
              content: `The same thing we do every night, Pinky—try to take over the world! Let us consult the archives.`,
            };
          } else if (systemContent.includes("specialist agent available") || systemContent.includes("Explain your capabilities")) {
            return {
              content: `The same thing we do every night, Pinky—try to take over the world!\nI must inform you that no specialist agent is available for your specific query. However, my supreme intellect has developed four specialized areas of expertise:
- **aws-tutor**: AWS Certified Cloud Practitioner prep.
- **cellular-automata**: Conway's Game of Life.
- **english-certification-instructor**: IELTS, TOEFL, Cambridge coach.
- **job-technical-interviewer**: Frontend mock job interview simulator.`,
            };
          } else {
            // Specialist mock response
            return {
              content: `Here is the lesson overview.\nIt is a cellular automaton.`,
            };
          }
        }),
      };
    }),
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

// Import new agent logic
import { theBrainNode } from "../../agents/the-brain.js";
import { retrieveContext, cellularAutomataNode } from "../../agents/specialists.js";
import { AgentWorkspaceState } from "../../agents/types.js";

describe("The Brain & Specialist Agent Unit Tests", () => {
  it("should retrieve context correctly from the vector store for aws-tutor", () => {
    const results = retrieveContext("DynamoDB and IAM policies", "aws-tutor");
    expect(results).toBeDefined();
    expect(results.length).toBeGreaterThan(0);
  });

  it("should retrieve context correctly for job-technical-interviewer", () => {
    const results = retrieveContext("JavaScript closure and hooks", "job-technical-interviewer");
    expect(results).toBeDefined();
    expect(results.length).toBeGreaterThan(0);
  });

  it("should detect area correctly and route to specialist", async () => {
    const initialState: AgentWorkspaceState = {
      messages: [new HumanMessage("Explain Conway's Game of Life")],
      nextAgent: "the-brain",
    };

    const stateOutput = await theBrainNode(initialState);
    expect(stateOutput.nextAgent).toBe("cellular-automata");
    expect(stateOutput.brainIntroduction).toContain("The same thing we do every night");
  });

  it("should explain that no specialist is available when query does not match", async () => {
    const initialState: AgentWorkspaceState = {
      messages: [new HumanMessage("How do I bake bread?")],
      nextAgent: "the-brain",
    };

    const stateOutput = await theBrainNode(initialState);
    expect(stateOutput.messages).toBeDefined();
    const lastMsg = stateOutput.messages![stateOutput.messages!.length - 1];
    expect(typeof lastMsg.content).toBe("string");
    expect(lastMsg.content as string).toContain("no specialist agent is available");
    expect(lastMsg.content as string).toContain("aws-tutor");
    expect(lastMsg.content as string).toContain("cellular-automata");
    expect(stateOutput.nextAgent).toBe("end");
  });

  it("should run specialist node and combine introduction and answer", async () => {
    const state: AgentWorkspaceState = {
      messages: [new HumanMessage("Explain Conway's Game of Life")],
      nextAgent: "cellular-automata",
      brainIntroduction: "The same thing we do every night, Pinky—try to take over the world! Let us consult the cellular-automata archives."
    };

    const stateOutput = await cellularAutomataNode(state);
    expect(stateOutput.messages).toBeDefined();
    const lastMsg = stateOutput.messages![stateOutput.messages!.length - 1];
    const text = lastMsg.content as string;

    const lines = text.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    
    // First line is from theBrainIntroduction
    expect(lines[0]).toMatch(/(world|Pinky|domination)/i);
    // Third line (or after double line breaks) is the specialist professional answer
    expect(lines[2]).toMatch(/(lesson|overview|cellular)/i);
    expect(stateOutput.nextAgent).toBe("end");
  });
});
