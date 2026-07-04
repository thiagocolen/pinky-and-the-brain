import { 
  JsonRpcRequestSchema, 
  InitializeParamsSchema, 
  RunAgentParamsSchema, 
  SessionNewParamsSchema,
  SessionPromptParamsSchema,
  JsonRpcRequest 
} from "./messages.js";
import { runGraphWorkflow } from "../agents/graph.js";
import { logger } from "../utils/logger.js";
import { isAIMessage, getMessageContent } from "../utils/messages.js";

export class AcpServer {
  private isInitialized = false;
  private sessions = new Map<string, { cwd: string }>();

  public async handleInput(rawData: string): Promise<string> {
    try {
      logger.info(`Incoming RPC request: ${rawData.trim()}`);
      const parsed = JSON.parse(rawData);
      const request = JsonRpcRequestSchema.parse(parsed);

      let response = "";
      switch (request.method) {
        case "initialize":
          response = this.handleInitialize(request);
          break;
        case "session/new":
          response = this.handleSessionNew(request);
          break;
        case "session/prompt":
          response = await this.handleSessionPrompt(request);
          break;
        case "agents/list":
          response = this.handleListAgents(request);
          break;
        case "agents/run":
          response = await this.handleRunAgent(request);
          break;
        default:
          response = this.formatError(request.id ?? null, -32601, `Method not found: ${request.method}`);
      }
      logger.info(`Outgoing RPC response: ${response.trim()}`);
      return response;
    } catch (err: any) {
      const errorResponse = this.formatError(null, -32700, `Parse error or Invalid Request: ${err.message}`);
      logger.error(`RPC error: ${err.message}. Response: ${errorResponse}`);
      return errorResponse;
    }
  }

  private handleInitialize(req: JsonRpcRequest): string {
    try {
      const params = InitializeParamsSchema.parse(req.params);
      this.isInitialized = true;
      return this.formatResult(req.id ?? null, {
        protocolVersion: params.protocolVersion,
        serverInfo: {
          name: "pinky-and-the-brain-agents",
          version: "1.0.0",
        },
        capabilities: {
          agents: true,
        },
      });
    } catch (err: any) {
      return this.formatError(req.id ?? null, -32602, `Invalid params: ${err.message}`);
    }
  }

  private handleSessionNew(req: JsonRpcRequest): string {
    if (!this.isInitialized) {
      return this.formatError(req.id ?? null, -32002, "Server not initialized.");
    }
    try {
      const params = SessionNewParamsSchema.parse(req.params);
      const sessionId = `session_${Math.random().toString(36).substring(2, 15)}`;
      this.sessions.set(sessionId, { cwd: params.cwd });
      return this.formatResult(req.id ?? null, { sessionId });
    } catch (err: any) {
      return this.formatError(req.id ?? null, -32602, `Invalid params: ${err.message}`);
    }
  }

  private async handleSessionPrompt(req: JsonRpcRequest): Promise<string> {
    if (!this.isInitialized) {
      return this.formatError(req.id ?? null, -32002, "Server not initialized.");
    }
    try {
      const params = SessionPromptParamsSchema.parse(req.params);
      const session = this.sessions.get(params.sessionId);
      if (!session) {
        return this.formatError(req.id ?? null, -32602, `Session not found: ${params.sessionId}`);
      }

      let promptText = "";
      if (typeof params.prompt === "string") {
        promptText = params.prompt;
      } else if (Array.isArray(params.prompt)) {
        promptText = params.prompt
          .filter((block: any) => block.type === "text" && typeof block.text === "string")
          .map((block: any) => block.text)
          .join("\n");
      }

      // Default to the-brain agent orchestrator
      const threadId = params.sessionId;
      const agentName = "the-brain";

      const result = await runGraphWorkflow(agentName, promptText, threadId, (progress) => {
        // Stream progress updates to standard out as session/update notifications
        const progressMessage = `[${progress.node}] ${progress.status}`;
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: `progress_${progress.node}_${Date.now()}`,
              content: {
                type: "text",
                text: `${progressMessage}\n`
              }
            }
          }
        }));
      });

      // Construct output from the final workflow state
      let responseText = "";
      if (result.instructorState?.explanation) {
        responseText = result.instructorState.explanation;
      } else {
        const aiMsgs = (result.messages || [])
          .filter(isAIMessage)
          .map(getMessageContent);
        if (aiMsgs.length > 0) {
          responseText = aiMsgs.join("\n\n");
        } else {
          responseText = "Workflow execution complete, but no output content was returned.";
        }
      }

      logger.info(`[ACP-SESSION] Agent Response for session ${params.sessionId}:\n${responseText}`);

      // Stream the final response to standard out
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: `result_${Date.now()}`,
            content: {
              type: "text",
              text: responseText
            }
          }
        }
      }));

      return this.formatResult(req.id ?? null, {
        stopReason: "end_turn"
      });
    } catch (err: any) {
      return this.formatError(req.id ?? null, -32603, `Execution error: ${err.message}`);
    }
  }

  private handleListAgents(req: JsonRpcRequest): string {
    if (!this.isInitialized) {
      return this.formatError(req.id ?? null, -32002, "Server not initialized.");
    }
    return this.formatResult(req.id ?? null, {
      agents: [
        { name: "the-brain", description: "Speaks as The Brain, an instructor on technical domains and world domination." },
        { name: "supervisor", description: "Speaks as The Brain (Backward compatibility route)." },
      ],
    });
  }

  private async handleRunAgent(req: JsonRpcRequest): Promise<string> {
    if (!this.isInitialized) {
      return this.formatError(req.id ?? null, -32002, "Server not initialized.");
    }
    try {
      const params = RunAgentParamsSchema.parse(req.params);
      
      const result = await runGraphWorkflow(params.agentName, params.prompt, params.threadId, (progress) => {
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          method: "agents/progress",
          params: progress
        }));
      });

      let responseText = "";
      if (result.instructorState?.explanation) {
        responseText = result.instructorState.explanation;
      } else {
        const aiMsgs = (result.messages || [])
          .filter(isAIMessage)
          .map(getMessageContent);
        responseText = aiMsgs.length > 0 ? aiMsgs.join("\n\n") : "Workflow completed.";
      }
      logger.info(`[ACP-AGENT] Agent Response for run "${params.agentName}" (thread: ${params.threadId}):\n${responseText}`);

      return this.formatResult(req.id ?? null, { result });
    } catch (err: any) {
      return this.formatError(req.id ?? null, -32603, `Execution error: ${err.message}`);
    }
  }

  private formatResult(id: string | number | null, result: any): string {
    return JSON.stringify({ jsonrpc: "2.0", id, result });
  }

  private formatError(id: string | number | null, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  }
}
