import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runGraphWorkflow } from "./agents/graph.js";
import { resolveThreadId } from "./utils/session.js";
import { isAIMessage, getMessageContent } from "./utils/messages.js";
import { logger } from "./utils/logger.js";
import { validateConfig } from "./config.js";

try {
  // PATBA_API_KEY guards the REST API, which this entrypoint does not serve.
  // MCP clients spawn servers with a filtered environment, so requiring an
  // unused secret here would fail startup for no security benefit.
  validateConfig({ requirePatbaApiKey: false });
} catch (e: any) {
  console.error("Configuration validation failed:", e.message);
  process.exit(1);
}

const server = new Server(
  {
    name: "pinky-and-the-brain-agents-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "run_agent",
        description:
          "Send one message to The Brain, a guided tutor that teaches technical topics and writes articles. " +
          "This is a MULTI-TURN conversation, not a one-shot query: The Brain leads a journey (choose a topic → " +
          "choose a subtopic → learn it or write an article about it) and ends every reply with a question. " +
          "Call this repeatedly, relaying the user's answer each time, to carry that conversation forward. " +
          "Start with a greeting such as 'hello' to receive the topic menu.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The next message for The Brain — a greeting, a menu choice ('2'), an answer to its question, or an instruction.",
            },
            agentName: {
              type: "string",
              description: "The agent to invoke. Defaults to 'the-brain'; 'brain' and 'supervisor' are accepted aliases.",
              enum: ["the-brain", "brain", "supervisor"],
            },
            threadId: {
              type: "string",
              description:
                "Optional. Omit this — by default all calls share one conversation, which is what lets the journey progress. " +
                "Pass an id only to deliberately start or resume a separate, isolated conversation.",
            },
          },
          required: ["prompt"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "run_agent") {
    throw new Error(`Tool not found: ${request.params.name}`);
  }

  const args = request.params.arguments as any;
  const prompt = args.prompt;
  const agentName = args.agentName || "the-brain";
  const threadId = resolveThreadId(args.threadId);

  try {
    const result = await runGraphWorkflow(agentName, prompt, threadId, (progress) => {
      // Progress update logged to stderr (MCP uses stdout for json-rpc, so stdout MUST not be polluted)
      process.stderr.write(`🔄 [${progress.node}] ${progress.status}\n`);
    });

    let responseText = "";
    if (result.instructorState?.explanation) {
      responseText = result.instructorState.explanation;
    } else {
      const aiMsgs = (result.messages || [])
        .filter(isAIMessage)
        .map(getMessageContent);
      responseText = aiMsgs.length > 0 ? aiMsgs.join("\n\n") : "Workflow completed successfully.";
    }

    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error invoking agent: ${err.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Run the MCP server over stdio
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server connected and running over stdio");
}

run().catch((error) => {
  logger.error("Failed to run MCP server:", error);
});
