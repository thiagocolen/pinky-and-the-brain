# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- **A deck under the title no longer ships as a stray heading.** `preparePost` lifted only the H1, so an article whose second line was a `###` subtitle — the shape The Brain had already been writing — published with that line rendered as an `<h3>` at the top of the body while the post's `headline` frontmatter stayed empty. The deck is now lifted into `headline`, where the blog renders it under the title.
- **Article delivery reports no longer vanish.** A model may speak *and* call a tool in the same message, and the journey does exactly that when it finishes a publish: it reports the pull request, then calls `list_topics` to re-present the menu. `runGraphWorkflow()` returned only the *last* assistant message with text, so the sentence naming the pull request was discarded and a successful publish came back to the caller as a bare topic menu — no PR number, no branch, no link, and no sign anything had happened. It now returns everything the assistant said during the turn (`extractTurnReply`, bounded by the last human message so earlier replies are never re-sent).

### Changed
- **Articles are laid out, not just written.** An article was composed as unbroken prose and published as a wall of text with a cover image, even though the blog has always been able to render more. It is now written *with* its layout in the markdown file itself: an `###` deck under the title, `:::note|tip|warn` callouts, and `![alt](image: prompt)` figures. Putting the layout in the file rather than in publish-time tool arguments is the point — Pinky reviews and revises the real shape of the post before it is published, instead of approving a description of one. `publish_article` translates that layout into the blog's MDX (`<Callout>`, `<figure>`), generates one illustration per figure alongside the cover, and patches them in once the slug is known. Figure generation is soft-failing like the cover: a figure that cannot be generated has its marker dropped, and the article publishes regardless.
- **Publishing goes through the blog's own MCP server.** Finished articles are delivered by driving the `articles` server that ships inside thiagocolen.github.io (`create_draft` → `add_asset` → `update_post` → `stage_changes`) instead of cloning the repo and writing `.mdx` files here. The blog's frontmatter shape, slug rules, asset location and safe branch are now defined in exactly one place — `develop-tools/posts.js`, the same module the site's npm scripts use — so the two can no longer drift. The agent never calls `publish_post`: drafts stay `unpublished`, and no workflow builds `new-articles`, leaving both gates to the public site in human hands.
- **Article slugs are short.** The blog derives the slug from the title with no override, so the title itself is now capped at about six words; longer or wittier phrasing moves to the post's `headline` (the deck under the title), which never reaches the URL. `publish_article` takes `title` and `headline` separately, as the blog's tools describe them.
- **Articles are written to a published standard.** `ARTICLE_CRAFT_PROMPT` — topic/audience/purpose/stakes fixed before drafting, three-part structure, one idea per paragraph, varied sentences, supported claims — is now part of the system prompt, distilled from Cambridge International, Gotham Writers Workshop, BBC Bitesize and two practitioner guides.

### Added
- `src/agents/layout.ts` — the diagramation layer: lifts the deck, extracts figures, and renders callouts into the blog's MDX. Pure string transforms, no I/O, so the interesting cases are cheap to test.
- `generateBodyImage()` beside `generateCoverImage()` in `src/utils/image-gen.ts`, at 4:3 rather than 16:9 — a body figure is looked at, not cropped to a banner. Both share one soft-failure path.
- **[Article Writing Guide](docs/docs/developer/article-writing-guide.mdx)** — the long-form standard behind `ARTICLE_CRAFT_PROMPT`, with the reasoning and sources for each rule, including the layout marks and what each one is for.
- `BLOG_REPO_PATH` (default `../thiagocolen.github.io`), pointing at the checkout whose MCP server publishes articles.
- Agent Flow now documents **how an article gets written** and **where to add more detailed article instructions**.

### Removed
- `src/utils/blog-repo.ts` and the clone → commit → push → `gh pr create` publishing path it implemented, along with `BLOG_REPO_URL` and `BLOG_BASE_BRANCH`.

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
