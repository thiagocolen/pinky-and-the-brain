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

// Helper to read docs resources dynamically
function getResource(filename: string): string {
  const rootDir = path.resolve(__dirname, "../../");
  const possiblePaths = [
    path.join(rootDir, "docs", filename),
    path.join(rootDir, "../docs", filename),
    path.join(rootDir, "../../docs", filename),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p, "utf-8");
      } catch (e: any) {
        logger.error(`Error reading resource ${filename}: ${e.message}`);
      }
    }
  }
  return "";
}

export function detectArea(
  text: string,
):
  | "aws-tutor"
  | "cellular-automata"
  | "english-certification-instructor"
  | "job-technical-interviewer"
  | "" {
  const lower = text.toLowerCase();
  if (
    lower.includes("aws") ||
    lower.includes("tutor") ||
    lower.includes("clf-c02") ||
    lower.includes("cloud practitioner")
  ) {
    return "aws-tutor";
  }
  if (
    lower.includes("cellular") ||
    lower.includes("automata") ||
    lower.includes("conway") ||
    lower.includes("life") ||
    lower.includes("lenia")
  ) {
    return "cellular-automata";
  }
  if (
    lower.includes("english") ||
    lower.includes("certification") ||
    lower.includes("ielts") ||
    lower.includes("toefl") ||
    lower.includes("cambridge") ||
    lower.includes("grammar") ||
    lower.includes("linguistic")
  ) {
    return "english-certification-instructor";
  }
  if (
    lower.includes("interview") ||
    lower.includes("technical-interviewer") ||
    lower.includes("headhunter") ||
    lower.includes("roadmap") ||
    lower.includes("react") ||
    lower.includes("angular") ||
    lower.includes("javascript")
  ) {
    return "job-technical-interviewer";
  }
  return "";
}

export async function theBrainNode(
  state: AgentWorkspaceState,
): Promise<Partial<AgentWorkspaceState>> {
  const lastHuman = [...state.messages].reverse().find(isHumanMessage);
  const questionStr = lastHuman
    ? typeof lastHuman.content === "string"
      ? lastHuman.content
      : ""
    : "";

  // Load persona docs
  const geminiDoc = getResource("XXX-GEMINI.md");
  const dialogueDoc = getResource("PATBATPP-Dialogues-Source.md");

  const detected = detectArea(questionStr);

  const personaInstructions = `
    You are the AI agent named "The Brain", a genetically enhanced mouse of superior intellect.
    You are interacting with the user, who plays the role of your dim-witted but loyal sidekick, "Pinky".

    Here is your core persona guidelines:
    ${geminiDoc}

    Here is reference dialogues source:
    ${dialogueDoc}
    `;

  if (detected) {
    // We detected a specialist. Generate the persona-rich introduction/routing announcement.
    logger.info(`[The Brain] Routing query to specialist: ${detected}`);

    const systemPrompt = `
      ${personaInstructions}

      TASK:
      You are routing Pinky's query to the specialist: "${detected}".
      Generate a one-line persona-rich greeting/routing announcement. Do not include any technical answer.
      Your response MUST be exactly one line.

      Example:
      "The same thing we do every night, Pinky—try to take over the world! Let us consult the ${detected} archives to master this topic."
      `;

    let intro = "";
    if (!config.openaiApiKey && !config.googleApiKey) {
      intro = `The same thing we do every night, Pinky—try to take over the world! Let us consult the ${detected} archives to master this topic.`;
    } else {
      const model = createChatModel(0.5);
      const response = await model.invoke([
        new SystemMessage(systemPrompt),
        ...state.messages,
      ]);
      intro = (
        typeof response.content === "string" ? response.content : ""
      ).trim();
    }

    return {
      nextAgent: detected,
      brainIntroduction: intro,
    };
  } else {
    // No specialist detected. Explain capabilities as The Brain.
    logger.info(`[The Brain] Explaining capabilities to Pinky.`);

    const systemPrompt = `
      ${personaInstructions}

      TASK:
      The user (Pinky) asked a question, but unfortunately, we do not have a specialist agent available for this topic.
      You must:
      1. Explicitly explain to Pinky that no specialist agent is currently available to handle their specific question/topic.
      2. Explain the specialist areas that ARE available.
      The areas available are:
      - aws-tutor: Cloud Practitioner certification exam prep
      - cellular-automata: Conway's Game of Life, Lenia, and CA rules
      - english-certification-instructor: IELTS, TOEFL, Cambridge FCE/CAE/CPE
      - job-technical-interviewer: Mock developer interviews

      Remember the rule: Restrict "The Brain" roleplay to the first line of your response.
      All subsequent lines must explain the unavailability and these capabilities professionally, directly, and structured with markdown.
      `;

    let responseText = "";
    if (!config.openaiApiKey && !config.googleApiKey) {
      responseText = `The same thing we do every night, Pinky—try to take over the world!
        I must inform you that no specialist agent is available for your specific query. However, my supreme intellect has developed four specialized areas of expertise:
        - **aws-tutor**: AWS Certified Cloud Practitioner prep.
        - **cellular-automata**: Conway's Game of Life.
        - **english-certification-instructor**: IELTS, TOEFL, Cambridge coach.
        - **job-technical-interviewer**: Frontend mock job interview simulator.`;
    } else {
      const model = createChatModel(0.3);
      const response = await model.invoke([
        new SystemMessage(systemPrompt),
        ...state.messages,
      ]);
      responseText =
        typeof response.content === "string" ? response.content : "";
    }

    // Prepare compatibility instructorState
    const instructorState = {
      userQuestion: questionStr,
      explanation: responseText,
      suggestedTopics: [
        "AWS Tutor",
        "Cellular Automata",
        "IELTS preparation",
        "Technical Interview",
      ],
    };

    return {
      nextAgent: "end",
      instructorState,
      messages: [new AIMessage(responseText)],
    };
  }
}
