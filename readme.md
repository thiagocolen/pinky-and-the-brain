# Pinky and the Brain Agents Service

A serverless, pay-as-you-go multi-agent application hosted on AWS, orchestrated via LangGraph.js, and exposed as a service through the Agent Client Protocol (ACP) standard for IDE integration (like Zed IDE) or other client interfaces.

## Project Overview

The `pinky-and-the-brain-agent` service automates complex workflows by coordinating specialized agents in a cyclic LangGraph.js state graph:

1. **Supervisor**: Analyzes inputs and routes tasks to the appropriate specialist worker agent.
2. **Specialist (RAG)**: Scrapes context (e.g., Datacamp's AI Engineering Interview Questions) and matches topic concepts to create reference datasets.
3. **Writer**: Uses specialist reference material to compose comprehensive technical articles.
4. **Instructor**: Prepares detailed Q&A walkthroughs, system design guidelines, and interactive quizzes.
5. **Developer**: Manages repository checkout/branching, writes automated edits, and executes tests in a Docker sandbox before submitting Pull Requests.
6. **Publisher**: Automatically publishes drafts to platform APIs (Dev.to, Medium, Hashnode).

---

## Directory Structure

```
pinky-and-the-brain-agent/
├── docs/                               # Architecture and Specifications records
├── terraform/                          # AWS Cloud IaC Configurations
│   ├── main.tf                         # ECS/App Runner, DynamoDB, S3, IAM
│   ├── variables.tf                    # Deployment settings & regional variables
│   └── outputs.tf                      # App Runner service URL output
├── src/
│   ├── index.ts                        # Stdin/Stdout readline CLI (ACP Stdin Entrypoint)
│   ├── config.ts                       # Configuration parser & validator
│   ├── agents/                         # Agent Graph & Definitions
│   │   ├── types.ts                    # Graph workspace shared state
│   │   ├── graph.ts                    # LangGraph orchestration compilation
│   │   ├── supervisor.ts               # Supervisor Router Node
│   │   ├── developer.ts                # Developer node
│   │   ├── writer.ts                   # Writer node
│   │   ├── instructor.ts               # Instructor node
│   │   ├── specialist.ts               # Specialist node
│   │   └── publisher.ts                # Publisher node
│   ├── protocol/                       # ACP JSON-RPC standard parsing
│   │   ├── acp-server.ts               # ACP Protocol handler
│   │   └── messages.ts                 # Validation schemas (Zod)
│   ├── storage/                        # State persistence
│   │   ├── checkpointer.ts             # Custom DynamoDB/S3 checkpointer (with Memory fallback)
│   │   └── s3.ts                       # S3 Client Wrapper
│   └── tools/                          # External utility APIs
│       ├── github-tool.ts              # Git and GitHub PR creation tool
│       └── terminal-tool.ts            # Sandboxed command terminal
├── package.json                        # Scripts & dependencies
├── tsconfig.json                       # TS compilation config
└── vitest.config.ts                    # Test runner config
```

---

## Getting Started

### Prerequisites

- **Node.js**: `v20.x` or higher
- **npm**: `v10.x` or higher
- **Docker** (Optional, used for sandboxed command execution by the Developer agent)

### Setup & Installation

1. Clone the repository and navigate into the project directory:
   ```bash
   cd pinky-and-the-brain-agent
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory to configure the environment variables:
   ```env
   # API Keys
   OPENAI_API_KEY=your_openai_api_key_here
   GITHUB_ACCESS_TOKEN=your_github_token_here
   DEV_TO_API_KEY=your_dev_to_api_key_here

   # AWS Persistency Configuration (Optional)
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=your_aws_access_key
   AWS_SECRET_ACCESS_KEY=your_aws_secret_key
   DYNAMODB_TABLE_NAME=pinky-and-the-brain-agent-checkpoints-dev
   S3_BUCKET_NAME=pinky-and-the-brain-state-store-dev
   ```
   > **Note:** If no AWS credentials are provided, the service will gracefully fallback to **local in-memory checkpointing** so you can develop and run tests entirely offline!

### Building the Project

Compile TypeScript into JavaScript:
```bash
npm run build
```

---

## How to Run & Verify Locally

You can run the ACP server locally and interact with it using JSON-RPC standard input/output.

1. **Start the server**:
   ```bash
   node dist/index.js
   ```

2. **Initialize Server Connection**:
   Send the initialization payload into stdin:
   ```json
   {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2026-06-24", "capabilities": {}, "clientInfo": {"name": "test-cli"}}}
   ```
   *Expected Response:*
   ```json
   {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2026-06-24","serverInfo":{"name":"pinky-and-the-brain-agent","version":"1.0.0"},"capabilities":{"agents":true}}}
   ```

3. **Request Available Agents**:
   ```json
   {"jsonrpc": "2.0", "id": 2, "method": "agents/list", "params": {}}
   ```
   *Expected Response:*
   ```json
   {"jsonrpc":"2.0","id":2,"result":{"agents":[{"name":"supervisor","description":"Orchestrates multi-agent pipelines."},{"name":"developer","description":"Clones repos, executes tests, writes code, and opens PRs."},{"name":"writer","description":"Writes high-fidelity tech articles based on specialist context."},{"name":"instructor","description":"Acts as an interactive Q&A tutor on technical topics."},{"name":"specialist","description":"Gathers context from specialized vector stores."},{"name":"publisher","description":"Publishes articles to Medium, Dev.to, or Hashnode."}]}}
   ```

4. **Run a Multi-Agent Thread**:
   ```json
   {"jsonrpc":"2.0","id":3,"method":"agents/run","params":{"agentName":"supervisor","prompt":"Write an article about AI Engineers and publish it to dev.to","threadId":"test-thread-123"}}
   ```

---

## Consuming the Agent Service through ACP

The Agent Client Protocol (ACP) standard uses JSON-RPC 2.0. The standard interface lifecycle is as follows:

1. **Client Handshake**: Client sends `initialize` payload. Until the server handles this method, all other requests return a `-32002` (Server not initialized) error.
2. **Polling capability / listing**: Client calls `agents/list` to query available agent configurations and metadata.
3. **Trigger run task**: Client calls `agents/run` passing the target `agentName`, the user instruction `prompt`, and a session coordinate `threadId`.
4. **Asynchronous Progress Updates**: While executing, the server outputs `agents/progress` notifications to stdin/stdout (or streams via Server-Sent Events (SSE) on AWS):
   ```json
   {"jsonrpc":"2.0","method":"agents/progress","params":{"threadId":"test-thread-123","node":"specialist","status":"Retrieving context details...","timestamp":"2026-06-24T18:00:00Z"}}
   ```

---

## Consuming the Agent Service from Zed IDE

Zed editor supports running external agents using the ACP protocol. You can configure the `pinky-and-the-brain-agent` service in Zed so it is accessible inside your editor's AI Agent Panel.

### Step 1: Register in `settings.json`

Open your Zed settings (Command Palette `Ctrl+Shift+P` / `Cmd+Shift+P` -> `agent: open settings`) and add the server registration under the `agent_servers` block:

```json
{
  "agent_servers": {
    "pinky-and-the-brain-agent": {
      "type": "custom",
      "command": "node",
      "args": [
        "/absolute/path/to/pinky-and-the-brain-agent/dist/index.js"
      ],
      "env": {
        "OPENAI_API_KEY": "your_openai_api_key_here",
        "GITHUB_ACCESS_TOKEN": "your_github_token_here",
        "DEV_TO_API_KEY": "your_dev_to_api_key_here"
      }
    }
  }
}
```

> **Note:** Ensure you replace `/absolute/path/to/pinky-and-the-brain-agent/` with the exact absolute path to where you compiled the codebase on your machine.

### Step 2: Use the Agent in Zed

1. Open the **Agent Panel** in Zed (using the ✨ icon or shortcut `Cmd+?` / `Ctrl+?`).
2. Open the thread dropdown/settings.
3. Select `pinky-and-the-brain-agent` as your active agent.
4. Input your prompt (e.g., `"Write a study guide about system-design CDN load balancing"` or `"Clone this repository and verify its linting errors"`).
5. Watch progress updates streamed directly into the Zed agent interface.

---

## Running Tests

Run the test suite using Vitest:

```bash
# Run unit tests
npm run test:unit

# Run integration tests
npm run test:integration
```
