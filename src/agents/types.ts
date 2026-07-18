import { BaseMessage } from "@langchain/core/messages";

/**
 * The state returned by a run of The Brain.
 *
 * `instructorState` is retained for compatibility: every entry point (CLI,
 * REST, MCP, ACP) reads `instructorState.explanation` to render the reply.
 */
export interface AgentWorkspaceState {
  messages: BaseMessage[];
  todos?: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
  files?: Record<string, unknown>;

  instructorState?: {
    userQuestion: string;
    explanation?: string;
  };
}

/**
 * The slice of the compiled deep agent this project uses.
 *
 * Deliberately narrow: `createDeepAgent`'s inferred return type references
 * zod types nested inside `deepagents/node_modules`, which TypeScript cannot
 * name from here (TS2742). Annotating with this interface keeps the public
 * surface portable.
 */
export interface BrainAgent {
  invoke(input: any, config?: any): Promise<any>;
  stream(input: any, config?: any): Promise<any>;
  streamEvents(input: any, config: any, ...rest: any[]): any;
}

/** Progress event passed to `runGraphWorkflow`'s callback. */
export interface AgentProgress {
  threadId: string;
  node: string;
  status: string;
  timestamp: string;
}
