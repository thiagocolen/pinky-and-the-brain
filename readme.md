# Pinky and the Brain Agents Service

A production-ready, cloud-native agent service deployed on AWS, built with [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview) on LangGraph.js, and exposed as a service through the Agent Client Protocol (ACP) standard for IDE integration (like Zed IDE) or REST/WebSocket clients.

---

## Project Overview

The service is a single agent — **The Brain** — that guides you (as Pinky) through a topic and then either teaches it or writes an article about it.

### Key Characteristics:
- **Cloud Architecture**: Deployed on AWS ECS / App Runner via Terraform, packaged inside Docker containers.
- **Deep Agent**: One `createDeepAgent` agent with a persona, custom tools, and a guided conversation flow.
- **Anthropic Claude**: The only supported LLM provider (`ANTHROPIC_API_KEY`, default `claude-sonnet-5`, `ANTHROPIC_MAX_TOKENS` output tokens per reply, default 16000).
- **Local SQLite Checkpointing**: Thread states and checkpoints are saved locally via a custom SQLite checkpointer optimized for performance (using WAL mode).
- **Grounded Retrieval**: Explanations and articles are drawn from a pre-compiled store of curated knowledge (~1.7MB).
- **Multiple Entrypoints**: Exposes Stdin/Stdout ACP, a REPL CLI, an Express REST API with Server-Sent Events (SSE) streaming support, and a Model Context Protocol (MCP) server.

---

## Core Architecture

### 1. The Brain (`src/agents/`)

One Deep Agent, assembled in `agent.ts` from a model, tools, and a system prompt. The division of labour is deliberate: **the model owns the conversation, the tools own the truth** — topics, subtopics, and source material are always read from the knowledge store, never invented.

*   **Persona (`persona.ts`)**: The Brain's voice — eloquent, imperious, addressing the user as Pinky. The persona never overrides technical accuracy.
*   **Journey (`prompts.ts`)**: The conversation flow (greet → topic → subtopic → learn or write an article → repeat) and the teaching loop (decompose → explain → test → re-explain until understood).
*   **Writing standard (`prompts.ts`)**: `ARTICLE_CRAFT_PROMPT` — the rules every article is written to, distilled from five sources on article craft, plus the layout marks that give a post its shape. See the [Article Writing Guide](https://thiagocolen.github.io/pinky-and-the-brain/docs/developer/article-writing-guide).
*   **Layout (`layout.ts`)**: turns an article's own marks — an `###` deck, `:::note|tip|warn` callouts, `![alt](image: prompt)` figures — into the blog's MDX. Pure transforms, no I/O.
*   **Tools (`tools.ts`)**: `list_topics`, `list_subtopics`, `retrieve_content`, `save_article`, `update_article`, `read_article`, `publish_article`, `export_article`.
*   **Compatibility (`graph.ts`)**: `runGraphWorkflow()` — the single function every entrypoint calls.

Topics of expertise, read from the knowledge store:

*   **AWS Cloud Practitioner Certification**: Prep materials for the CLF-C02 exam.
*   **Cellular Automata**: Conway's Game of Life, Wolfram's elementary automata, Lenia, particle life.
*   **English for Certifications**: Coaching for IELTS, TOEFL, and Cambridge exams.
*   **Technical Interview Preparation**: Role-based roadmaps for frontend/backend software engineering roles.

Articles are written to `./articles/` as markdown — carrying their own layout, so what you review is the shape the post will have — and published to the blog through the `articles` MCP server that ships inside [thiagocolen.github.io](https://github.com/thiagocolen/thiagocolen.github.io). Publishing renders that layout, generates a cover image and one illustration per figure, and files the result as a draft. The blog owns its own post format, so this agent is a client of it rather than a second opinion about it. See [Agent Flow](https://thiagocolen.github.io/pinky-and-the-brain/docs/developer/agent-flow) for the full journey diagram and design rationale.

### 2. State & Storage Persistence
*   **SQLite Checkpointer (`src/storage/sqlite.ts`)**: Extends LangGraph's `BaseCheckpointSaver` to persist thread history locally inside `state.db`. Optimized using SQL PRAGMAs (`WAL`, `synchronous=OFF`, `temp_store=MEMORY`).
*   **AWS S3 Storage (`src/storage/s3.ts`)**: Used to persist state in cloud environments, with an automatic local in-memory fallback for offline/local development.
*   **Knowledge Store (`src/storage/vector-store.json`)**: Pre-compiled, paragraph-level chunks of curated source documents, tagged by area and rebuilt with `npm run ingest`. Despite the filename it holds no embeddings — retrieval is keyword overlap.

---

## Directory Structure

```
pinky-and-the-brain/
├── docs/                               # Architecture and Specifications records
├── terraform/                          # AWS Cloud IaC Configurations
│   ├── main.tf                         # ECR, ECS Cluster, ECS Express Gateway Service, DynamoDB, S3, IAM
│   ├── variables.tf                    # Deployment settings & regional variables
│   └── outputs.tf                      # AWS CloudRunner service endpoints
├── src/
│   ├── index.ts                        # Main readline CLI (ACP Stdin/Stdout Entrypoint)
│   ├── cli.ts                          # Standalone interactive REPL CLI for local testing
│   ├── server.ts                       # Express REST API (HTTP, SSE Streaming, Slack/Teams webhooks)
│   ├── mcp.ts                          # Model Context Protocol (MCP) server
│   ├── graph-sdk.ts                    # SDK exports for modular reuse of the graph engine
│   ├── config.ts                       # Configuration parser & Zod schema validator
│   ├── agents/                         # The Brain (deep agent)
│   │   ├── types.ts                    # Run state, progress & BrainAgent interface
│   │   ├── agent.ts                    # createDeepAgent assembly (model + tools + prompt)
│   │   ├── graph.ts                    # runGraphWorkflow compatibility layer
│   │   ├── persona.ts                  # The Brain's voice & catchphrases
│   │   ├── prompts.ts                  # Journey state machine & teaching loop
│   │   ├── layout.ts                   # Article layout → the blog's MDX
│   │   └── tools.ts                    # Topics, subtopics, retrieval, article files
│   ├── protocol/                       # ACP JSON-RPC standard parsing
│   │   ├── acp-server.ts               # ACP Protocol handler
│   │   └── messages.ts                 # Validation schemas (Zod)
│   ├── storage/                        # State persistence
│   │   ├── sqlite.ts                   # SQLiteCheckpointer extending LangGraph's BaseCheckpointSaver
│   │   ├── s3.ts                       # S3 Storage client wrapper (with offline local fallback)
│   │   └── vector-store.json           # Pre-compiled vector database
│   └── utils/                          # Shared utilities
│       ├── logger.ts                   # Centralized console and file logger (agent.log & stderr)
│       ├── messages.ts                 # Message helper functions
│       └── model.ts                    # LLM factory (Anthropic Claude only)
├── scripts/                            # Deploy & operations scripts
│   ├── deploy.js                       # Deploy orchestration script (Docker build, ECR push, Terraform run)
│   ├── report-infra.ps1                # PowerShell script for AWS infrastructure status audits
│   ├── tail-logs.js                    # Script to stream cloud container logs
│   └── test-tracing.js                 # Script to verify LangSmith tracing connection
├── package.json                        # Scripts & dependencies
├── tsconfig.json                       # TS compilation config
└── vitest.config.ts                    # Test runner config
```

---

## Getting Started

### Prerequisites

- **Node.js**: `v20.x` or higher
- **npm**: `v10.x` or higher

### Setup & Installation

1. Clone the repository and navigate into the project directory:
   ```bash
   cd pinky-and-the-brain
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory:
   ```env
   # LLM API Key (Required - Anthropic is the only supported provider)
   ANTHROPIC_API_KEY=your_anthropic_api_key_here
   # ANTHROPIC_MODEL=claude-sonnet-5

   # API Gateway security key (Required for server and clients)
   PATBA_API_KEY=your_secret_api_key_here

   # Local Storage
   SQLITE_DB_PATH=state.db
   PORT=8080

   # AWS Configuration (Optional, falls back to local sqlite/memory offline)
   AWS_REGION=sa-east-1
   S3_BUCKET_NAME=pinky-and-the-brain-agents-state-store

   # Optional integrations
   SLACK_BOT_TOKEN=your_slack_bot_token_here
   ```

### Building the Project

Compile TypeScript into JavaScript:
```bash
npm run build
```

---

## Running the Service Locally

You can execute the service locally under different operational interfaces:

### 1. Standalone Interactive REPL CLI
Run the local agent directly in your command line:
```bash
npm run cli
```

Say hello and The Brain takes it from there:

```
You: hello
Brain: Behold, Pinky, the four pillars of tonight's potential enlightenment:
       1. AWS Cloud Practitioner Certification — ...
       2. Cellular Automata — ...
       ...
You: 2
Brain: [summary of the topic, then its subtopics]
You: An Introduction to Conway's The Game of Life
Brain: What is your desire? 1. Learn about it  2. Write an article about it
You: write an article about it
Brain: Do you have any instructions for this article?
You: three paragraphs
Brain: The deed is done, Pinky! The article resides at:
       .../articles/conways-game-of-life.md
       Now, where shall it go? 1. Publish it to the blog
       2. Save it to a folder  3. Neither
You: 1
Brain: [publishes as a draft, then reports the branch, the commit and the review URL]
```

### 2. HTTP & SSE REST Server
Start the Express API gateway to listen for HTTP requests and stream progress via Server-Sent Events (SSE) (defaults to port `8080`):
```bash
npm run server
```

### 3. Model Context Protocol (MCP) Server
Run the stdio-based MCP server to expose the agent to MCP clients (like Claude Desktop):
```bash
npm run mcp
```

### 4. Stdin/Stdout ACP Server
Run the raw Agent Client Protocol (ACP) JSON-RPC stdin/stdout server:
```bash
npm run start
```
To initialize a handshake, write this payload to `stdin`:
```json
{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2026-06-24", "capabilities": {}, "clientInfo": {"name": "test"}}}
```

---

## Running Tests

Run the test suite using Vitest:

```bash
# Run unit tests
npm run test:unit

# Run integration tests
npm run test:integration
```

---

## The CLI Tool Project (`patb-cli`)

For production setups or when you want to connect to a remote server without running the full agent orchestrator locally, you should use the **Pinky and the Brain CLI (`patb-cli`)**.

`patb-cli` acts as a lightweight wrapper client and gateway that communicates with the cloud-hosted AWS agent service (located at `d33ib4uu7f4xpi.cloudfront.net` or any custom local/remote URL).

```mermaid
graph TD
    A[User / Zed Editor] -->|Interactive Prompt or ACP RPC| B(patb-cli)
    B -->|1. Create Thread| C[Remote Service]
    B -->|2. Trigger Run| C
    C -->|3. Event Stream| B
    B -->|4. Format Output / Progress| A
```

### 1. Installation

#### Via NPM (Recommended)
You can run it directly using `npx` or install it globally:
```bash
npm install -g @thiagocolen/patb-cli
```

#### From Local Source
Navigate to the `patb-cli` project directory and build it:
```bash
cd D:/_code-projects/patb-cli
npm install
npm run build
npm link # optional, links 'patb-cli' command globally
```

### 2. Configuration (API Key)

The CLI requires `PATBA_API_KEY` to authenticate requests with the remote service. Configure this key using one of the following methods:

*   **Local `.env` File**: Create a `.env` file in the folder where you run the CLI:
    ```env
    PATBA_API_KEY=your_secret_api_key_here
    ```
*   **Environment Variables**:
    *   *Windows (PowerShell)*: `$env:PATBA_API_KEY="your_secret_api_key_here"`
    *   *macOS/Linux*: `export PATBA_API_KEY="your_secret_api_key_here"`

### 3. CLI Usage

*   **Interactive REPL Mode (default)**: Starts a chat session with the remote agent.
    ```bash
    patb-cli
    # or if running from local source folder
    node dist/index.js
    ```
*   **Zed ACP Bridge Mode**: Starts the server in bridge mode, speaking JSON-RPC over `stdin`/`stdout`.
    ```bash
    patb-cli --bridge
    # or
    node dist/index.js --bridge
    ```

---

## Integrating with Zed Editor

You can configure Zed to use `patb-cli` as an external agent server.

### Method 1: Using `npx` (Recommended - Zero Installation)
This is the cleanest approach because you do not need to install the package globally or clone/compile any files locally. Zed will fetch and execute the package on demand.

1. Open your Zed configuration file (`Ctrl+Shift+P` or `Cmd+Shift+P` -> `zed: open settings`).
2. Add the custom agent server under the `agent_servers` block:

```json
{
  "agent_servers": {
    "patb-agent": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@thiagocolen/patb-cli", "--bridge"],
      "env": {
        "PATBA_API_KEY": "your_secret_api_key_here"
      }
    }
  }
}
```

### Method 2: Using the Local Source Build
If you prefer to compile the CLI codebase locally:

1. Open your Zed configuration file.
2. Register the path to your compiled `dist/index.js` file:

```json
{
  "agent_servers": {
    "patb-agent": {
      "type": "custom",
      "command": "node",
      "args": [
        "D:/_code-projects/patb-cli/dist/index.js",
        "--bridge"
      ],
      "env": {
        "PATBA_API_KEY": "your_secret_api_key_here"
      }
    }
  }
}
```
*(Make sure to use absolute paths with forward slashes `/`, even on Windows)*.

### Step 3: Trigger the Agent in Zed
1. Open the **Agent Panel** in Zed (using the ✨ icon or shortcut `Cmd+?` / `Ctrl+?`).
2. Open the thread settings dropdown.
3. Select `patb-agent` as your active agent.
4. Prompt the agent (e.g., `"Design a layout for a RAG search service"`) and watch the streaming progress updates and responses!
