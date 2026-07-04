import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runGraphWorkflow } from "./agents/graph.js";
import { isAIMessage, getMessageContent } from "./utils/messages.js";
import { logger } from "./utils/logger.js";
import { validateConfig } from "./config.js";

try {
  validateConfig();
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
        description: "Executes the multi-agent graph supervisor workflow with a specific prompt. Returns the final generated output.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The instruction or query for the agent workspace (e.g., 'Write an article about CDNs' or 'Explain CDNs').",
            },
            agentName: {
              type: "string",
              description: "The agent node to invoke. Defaults to 'the-brain'. Can also be 'brain' or 'supervisor' for compatibility.",
              enum: ["the-brain", "brain", "supervisor", "developer", "writer", "instructor", "specialist", "publisher"],
            },
            threadId: {
              type: "string",
              description: "Optional persistent thread ID to isolate states across runs. If not provided, a random one will be generated.",
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
  const threadId = args.threadId || `mcp-session-${Math.random().toString(36).substring(7)}`;

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
