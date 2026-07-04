# Changelog

All notable changes to this project will be documented in this file.

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
