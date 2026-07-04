import { StateGraph, Annotation } from "@langchain/langgraph";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { AgentWorkspaceState } from "./types.js";
import { theBrainNode } from "./the-brain.js";
import {
  awsTutorNode,
  cellularAutomataNode,
  englishCertificationInstructorNode,
  jobTechnicalInterviewerNode,
} from "./specialists.js";
import { SQLiteCheckpointer } from "../storage/sqlite.js";

export const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
    default: () => [],
  }),
  nextAgent: Annotation<
    | "the-brain"
    | "aws-tutor"
    | "cellular-automata"
    | "english-certification-instructor"
    | "job-technical-interviewer"
    | "end"
  >({
    reducer: (x, y) => y,
    default: () => "the-brain",
  }),
  routingStack: Annotation<string[]>({
    reducer: (x, y) => y,
    default: () => [],
  }),
  brainIntroduction: Annotation<string | undefined>({
    reducer: (x, y) => y,
    default: () => undefined,
  }),
  brainState: Annotation<AgentWorkspaceState["brainState"]>({
    reducer: (x, y) => (x && y ? { ...x, ...y } : (y ?? x)),
    default: () => undefined,
  }),
  instructorState: Annotation<any>({
    reducer: (x, y) => y,
    default: () => undefined,
  }),
});

const workflow = new StateGraph<AgentWorkspaceState>(StateAnnotation as any)
  .addNode("the-brain", theBrainNode)
  .addNode("aws-tutor", awsTutorNode)
  .addNode("cellular-automata", cellularAutomataNode)
  .addNode(
    "english-certification-instructor",
    englishCertificationInstructorNode,
  )
  .addNode("job-technical-interviewer", jobTechnicalInterviewerNode);

// Set entry point
workflow.setEntryPoint("the-brain");

// Conditional routing from the-brain to specialists or end
workflow.addConditionalEdges(
  "the-brain",
  (state: AgentWorkspaceState) => {
    if (state.nextAgent === "end" || !state.nextAgent) {
      return "__end__";
    }
    return state.nextAgent;
  },
  {
    "aws-tutor": "aws-tutor",
    "cellular-automata": "cellular-automata",
    "english-certification-instructor": "english-certification-instructor",
    "job-technical-interviewer": "job-technical-interviewer",
    __end__: "__end__",
  },
);

// All specialist nodes transition to the end
workflow.addEdge("aws-tutor", "__end__");
workflow.addEdge("cellular-automata", "__end__");
workflow.addEdge("english-certification-instructor", "__end__");
workflow.addEdge("job-technical-interviewer", "__end__");

export const checkpointer = new SQLiteCheckpointer();
export const graph = workflow.compile({
  checkpointer,
});

export async function runGraphWorkflow(
  agentName: string,
  prompt: string,
  threadId: string,
  progressCallback: (status: any) => void,
): Promise<any> {
  const initialState: Partial<AgentWorkspaceState> = {
    messages: [new HumanMessage(prompt)],
    nextAgent: "the-brain",
  };

  const config = {
    configurable: {
      thread_id: threadId,
    },
  };

  progressCallback({
    threadId,
    node: "the-brain",
    status: `Starting agent workflow for: ${agentName}`,
    timestamp: new Date().toISOString(),
  });

  const stateOutput = await graph.invoke(initialState, config);
  return stateOutput;
}
