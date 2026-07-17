# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-07-17

### Added
- **The Brain, rebuilt on Deep Agents**:
  - Single deep agent (`src/agents/agent.ts`) replacing the supervisor/specialist graph, with a persona (`persona.ts`), a guided journey and teaching loop (`prompts.ts`), and tools (`tools.ts`).
  - Guided flow: greet → choose a topic → choose a subtopic → learn about it or have an article written about it, then repeat.
  - Article tools writing markdown to `./articles/` (`save_article`, `update_article`, `read_article`); updates require explicit confirmation.
  - Teaching mode that decomposes a subtopic, tests understanding, and re-explains until an answer is genuinely correct.
- **Agent Flow documentation** (`docs/docs/developer/agent-flow.mdx`) with a mermaid flowchart of the user journey, plus `@docusaurus/theme-mermaid`, which had never been installed — existing mermaid blocks had been rendering as plain code.

### Changed
- **Anthropic Claude is the only LLM provider**: `createChatModel()` returns `ChatAnthropic` (default `claude-sonnet-5`, override with `ANTHROPIC_MODEL`) and sends no `temperature`, which Claude Sonnet 5 rejects.
- `runGraphWorkflow()` keeps its signature, so the CLI, REST, MCP, and ACP entrypoints are unchanged; the agent is now built lazily so importing the module does not require an API key.
- `instructorState.explanation` returns only the latest reply rather than the accumulated thread.
- The ECS task reads `anthropic_api_key` from SSM and injects `ANTHROPIC_API_KEY` (`terraform/main.tf`). **The `/<project>/<environment>/anthropic_api_key` parameter must exist before `terraform apply`.**
- Empty model completions are reported instead of surfacing as a blank reply.

### Removed
- Supervisor and specialist nodes (`src/agents/the-brain.ts`, `src/agents/specialists.ts`); `retrieveContext` moved into `tools.ts` unchanged.
- Gemini and OpenAI providers, along with `@langchain/google-genai` and `@langchain/openai`. `GOOGLE_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_MODEL` are no longer read, and a missing `ANTHROPIC_API_KEY` is now an error rather than a fallback.
- Mock-response fallbacks that returned placeholder lessons when no LLM key was configured.

## [0.2.0] - 2026-07-04

### Added
- **LangGraph.js Orchestration**:
  - Modular supervisor-specialist architecture (`src/agents/graph.ts`).
  - Supervisor routing node (`src/agents/the-brain.ts`) with area detection (AWS Tutor, Cellular Automata, English certification, mock job interview coaching) and character roleplay dialogs.
  - Specialists node (`src/agents/specialists.ts`) for RAG semantic search.
- **Durable Persistence**:
  - Custom SQLite Checkpointer (`src/storage/sqlite.ts`) using WAL mode, synchronous-off, and memory temp store.
  - S3 checkpointer wrapper (`src/storage/s3.ts`) with offline local fallback.
- **REST & SSE Server**:
  - Express server (`src/server.ts`) supporting HTTP endpoints for thread management, webhooks (Slack/Teams), and progressive message streaming via Server-Sent Events (SSE) (defaults to port `8080`).
- **Model Context Protocol**:
  - stdio-based MCP server (`src/mcp.ts`) exposing the agent to MCP clients.
- **Interactive REPL CLI**:
  - Console script (`src/cli.ts`) for rapid local testing.
- **Infrastructure & Deployment**:
  - Terraform script (`terraform/main.tf`) configuring AWS ECR, ECS Fargate cluster, and ECS Express Gateway Service.
  - CloudFront CDN distribution fronting the ECS service, with caching disabled and forward headers configured to allow real-time SSE streaming.
  - Multi-stage Docker packaging configuration (`Dockerfile`) and deploy automation script (`scripts/deploy.js`).

### Changed
- Refactored project config (`src/config.ts`) using Zod schemas for environmental validations and enabling overrides.
- Converted `SLACK_BOT_TOKEN` validation check to non-blocking warning log.

### Removed
- Removed old React/Ink terminal UI code (`App.tsx`, `ChatHistory.tsx`, `ChatInput.tsx`, etc.).
- Cleaned up obsolete diagnostic files from `scripts/archive/` (`diagnose-gemini.js`, `test-env.js`, `test-gemini.js`, and `acp-remote-bridge.js`).
