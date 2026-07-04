import { createChatModel } from "../utils/model.js";
import { SystemMessage, AIMessage } from "@langchain/core/messages";
import { AgentWorkspaceState } from "./types.js";
import { config } from "../config.js";
import { isHumanMessage } from "../utils/messages.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface DbChunk {
  content: string;
  area: string;
}

let dbCache: DbChunk[] = [];
let isDbLoaded = false;

function loadVectorStore(): DbChunk[] {
  if (isDbLoaded) return dbCache;
  const possiblePaths = [
    path.resolve(__dirname, "../storage/vector-store.json"),
    path.resolve(__dirname, "../../src/storage/vector-store.json"),
    path.resolve(__dirname, "../../../src/storage/vector-store.json"),
  ];
  for (const storePath of possiblePaths) {
    if (fs.existsSync(storePath)) {
      try {
        dbCache = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        isDbLoaded = true;
        logger.info(`[Specialists] Loaded ${dbCache.length} chunks from ${storePath}`);
        break;
      } catch (e: any) {
        logger.error("Failed to parse vector store: " + e.message);
      }
    }
  }
  return dbCache;
}

export function retrieveContext(query: string, area: string): string[] {
  const store = loadVectorStore();
  if (store.length === 0) return [];
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  
  let targetArea = area;
  if (area === "job-technical-interviewer") {
    targetArea = "job-techinical-interview";
  }

  const areaStore = store.filter(chunk => chunk.area === targetArea);
  if (areaStore.length === 0) return [];
  
  const scored = areaStore.map(chunk => {
    let score = 0;
    const contentLower = chunk.content.toLowerCase();
    for (const term of queryTerms) {
      if (contentLower.includes(term)) {
        score++;
      }
    }
    return { chunk, score };
  });
  
  return scored
    .filter(item => item.score > 0 || queryTerms.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(item => item.chunk.content);
}

export async function runSpecialistNode(
  state: AgentWorkspaceState,
  area: string
): Promise<Partial<AgentWorkspaceState>> {
  const lastHuman = [...state.messages].reverse().find(isHumanMessage);
  const questionStr = lastHuman ? (typeof lastHuman.content === "string" ? lastHuman.content : "") : "";
  
  const contextList = retrieveContext(questionStr, area);
  const context = contextList.join("\n\n");
  
  const systemPrompt = `You are a professional assistant specialized in: ${area}.
Your job is to answer the user's question using the provided context.

Context:
${context}

Guidelines:
- Provide clear, educational summaries with markdown headers, checklists, and syntax highlighted code.
- Keep the response professional, detailed, direct, structured, and completely unaffected by any roleplay/persona.
`;

  let answer = "";
  if (!config.openaiApiKey && !config.googleApiKey) {
    answer = `Here is the mock lesson for ${area}. Let's start with a quick introduction.
Context length processed: ${context.length} characters.

#### Quiz
1. What is the goal of our study? (a) World domination (b) Sleeping
Answer: (a)`;
  } else {
    const model = createChatModel(0.3);
    const response = await model.invoke([
      new SystemMessage(systemPrompt),
      ...state.messages
    ]);
    answer = typeof response.content === "string" ? response.content : "";
  }

  // Combine intro + answer
  const intro = state.brainIntroduction || "The same thing we do every night, Pinky—try to take over the world!";
  const finalResponse = `${intro}\n\n${answer}`;

  // Prepare compatibility instructorState
  const instructorState = {
    userQuestion: questionStr,
    explanation: finalResponse,
    suggestedTopics: ["Topic Overview", "Advanced Concept", "Mock Practice"],
  };

  return {
    nextAgent: "end",
    instructorState,
    messages: [
      new AIMessage(finalResponse)
    ]
  };
}

export async function awsTutorNode(state: AgentWorkspaceState) {
  logger.info("[Specialists] Running aws-tutor specialist");
  return runSpecialistNode(state, "aws-tutor");
}

export async function cellularAutomataNode(state: AgentWorkspaceState) {
  logger.info("[Specialists] Running cellular-automata specialist");
  return runSpecialistNode(state, "cellular-automata");
}

export async function englishCertificationInstructorNode(state: AgentWorkspaceState) {
  logger.info("[Specialists] Running english-certification-instructor specialist");
  return runSpecialistNode(state, "english-certification-instructor");
}

export async function jobTechnicalInterviewerNode(state: AgentWorkspaceState) {
  logger.info("[Specialists] Running job-technical-interviewer specialist");
  return runSpecialistNode(state, "job-technical-interviewer");
}
