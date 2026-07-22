# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- **Retrieval is a real RAG pipeline.** `retrieve_content` scored a chunk by counting how many whitespace-split query terms appeared inside it as substrings, and every part of that sentence was a defect. Punctuation was never stripped, so `work?` could never match `work`. The two-character cutoff discarded `S3` and `AI` while keeping `the`, `how` and `does` — for *"How does the Game of Life work?"* only two of six terms carried signal, and eleven of the 68 cellular-automata chunks contained all three stopwords regardless of subject. `String.includes` scored `cell` inside `excellent`. Nothing stemmed, so `automaton` missed `automata` — the plural naming an entire topic area. Every match counted once, so a passage *about* a subject tied with one mentioning it in passing, and a long chunk beat a short one by offering more surface to hit. Ties broke on position in the file: that query produced 6 chunks tied at one score and 9 at the next against a limit of 10, so five of nine equally-ranked chunks were dropped by the order they were written to disk.

  Retrieval now fuses **BM25** with **vector similarity**. `src/utils/retrieval.ts` tokenises on non-alphanumerics, drops a deliberately short stopword list (aggressive lists eat `state`, `set` and `type`, which are domain vocabulary here), folds plurals, and scores with term-frequency saturation, IDF and length normalisation. `src/utils/embeddings.ts` adds one quantised 256-dimension `gemini-embedding-001` vector per chunk, and the two rankings are combined by reciprocal rank fusion — which reads only rank, because a BM25 score and a cosine similarity are not in the same units and cannot be added without inventing a conversion.

  Measured on twenty hand-labelled queries (`npm run eval:retrieval`): **recall@10 0.597 → 0.900, MRR 0.499 → 0.899, nDCG@10 0.461 → 0.847**. The figure that mattered most is the last one: **four of twenty questions previously returned ten passages containing nothing relevant**, and the agent had no way to know — it would write an article from them. That is now zero.

  Every path degrades to BM25 alone: no `GEMINI_API_KEY`, no embeddings file, a dimension mismatch, or a failed embedding call. Lexical retrieval is a complete retriever, so the vectors improve an answer rather than gate one.
- **Chunks have identities and provenance.** Each carries a content-addressed `id` (`sha256(content)` truncated), the `source` file it came from and the nearest `heading`. Positional identity was untenable once anything depended on it: an array index changes the moment a paragraph is added earlier in the corpus, which would silently invalidate both the evaluation fixture and every stored embedding. Content addressing also makes re-ingestion incremental — only text that actually changed is re-embedded. `retrieve_content` prints the source above each passage, so an article can attribute a claim rather than merely assert one.
- **`vector-store.json` is now `knowledge-store.json`.** It never held vectors, and the documentation apologised for the name in two separate places. The vectors live beside it in `embeddings.bin`, after which both names are honest.
- **`npm run ingest` works on more than one machine.** The corpus location was three hard-coded paths, the last an absolute Windows one, which is what it actually resolved by. It is now `CURATED_CONTENT_PATH`, with those paths kept as fallbacks. Ingestion also collapses duplicate paragraphs by id — 7,059 chunks became 5,166, of which 1,893 were exact duplicates being retrieved and shown to the model as though they were distinct sources.

### Added
- **[Retrieval (RAG) guide](docs/docs/developer/retrieval.mdx)** — what the retriever does, what it replaced and why each rule exists, how BM25 and embeddings are fused, how chunk identity works, the measurements, and where to change any of it.
- `npm run eval:retrieval` (`scripts/eval-retrieval.js`) — scores the legacy, lexical and hybrid retrievers against `src/tests/fixtures/retrieval-eval.json`, twenty queries labelled by hand. The legacy retriever is reproduced inside that script rather than kept alive in `src/`: a baseline has to stay runnable to remain a baseline, but nothing should be able to select it by accident.
- `RETRIEVAL_MODE` (default `hybrid`), `GEMINI_EMBEDDING_MODEL` (default `gemini-embedding-001`), `GEMINI_EMBEDDING_DIM` (default `256`), `CURATED_CONTENT_PATH`.

### Fixed
- **Long replies are no longer cut off at 4096 tokens.** `createChatModel()` left `maxTokens` unset, so `@langchain/anthropic` derived one from a table of known model-name prefixes — a table with no entry for `claude-sonnet-5`, which fell through to a 4096 fallback, a fraction of the model's 128K ceiling. Sonnet 5 also thinks adaptively by default and thinking tokens come out of that same budget, so an article-length turn stopped mid-sentence with `stop_reason: "max_tokens"` and the severed text was returned as though it were the whole reply. The limit is now stated explicitly (`ANTHROPIC_MAX_TOKENS`, default 16000), and a turn that still hits it says so instead of pretending it finished. 16000 rather than the model's full ceiling because the Anthropic SDK refuses a non-streaming request whose estimated duration passes ten minutes — anything over ~21333 output tokens throws before it is sent, and every entrypoint here runs through the non-streaming `invoke()`.
- **A deck under the title no longer ships as a stray heading.** `preparePost` lifted only the H1, so an article whose second line was a `###` subtitle — the shape The Brain had already been writing — published with that line rendered as an `<h3>` at the top of the body while the post's `headline` frontmatter stayed empty. The deck is now lifted into `headline`, where the blog renders it under the title.
- **Article delivery reports no longer vanish.** A model may speak *and* call a tool in the same message, and the journey does exactly that when it finishes a publish: it reports the pull request, then calls `list_topics` to re-present the menu. `runGraphWorkflow()` returned only the *last* assistant message with text, so the sentence naming the pull request was discarded and a successful publish came back to the caller as a bare topic menu — no PR number, no branch, no link, and no sign anything had happened. It now returns everything the assistant said during the turn (`extractTurnReply`, bounded by the last human message so earlier replies are never re-sent).

### Changed
- **Articles are signed.** A post arrived on the blog with nothing on it to say what had written it or where that thing lived, which is a strange omission for a piece whose provenance is the most interesting fact about it. Every article now closes with a fixed credit naming The Brain and linking to this repository. It is written **into the article file**, not appended by `publish_article`, for the same reason the layout is: what Pinky reviews before publishing should be the finished article, and a finished article is a signed one. That choice costs the guarantee — nothing in code enforces it — so the wording is given verbatim in `ARTICLE_CRAFT_PROMPT` rather than described, and the tests render the signature *taken from that prompt* rather than a copy, so the instruction and `layout.ts` cannot drift apart. The blank line before the `---` is part of the rule and not typography: pressed against the last paragraph, three hyphens are setext underlining and the article ends on an `<h2>`.
- **Delivering an article costs four fewer turns.** Getting one written and published took eleven exchanges, four of which asked Pinky nothing they had not already answered: "shall I change anything?" after the save, "shall I propose a description and tags myself?" before publishing, and an "it's fine" / "yes, proceed" for each. The journey now reports the saved article *and* presents the delivery menu in a single turn — a revision request simply arrives in place of a destination — and choosing to publish is treated as the confirmation to publish, with The Brain writing the listing description and tags itself and reporting what it used. The gates that matter are untouched: `publish_article` is still only ever called because Pinky picked that destination, `update_article` still waits for an explicit confirmation of the change, and the post still lands as an `unpublished` draft on `new-articles`.
- **An article's illustrations now look like one set.** Every image — cover and figures alike — was built from a single global constant ("abstract geometric line drawing, flat vector art…"), which made each picture a coin flip within that description and made every article look like every other one. A style is now **fixed per article**: `styleFor` hashes the title to one of the ten entries in `src/utils/illustration-styles.ts`, and that style is handed to the cover and to every figure of that article. Deterministic rather than random or model-chosen, because republishing an article that is already under review must not quietly redraw it — and `buildFigurePrompt` takes the style as a required argument, since a figure has no identity of its own to derive one from. The composition changed with it: images are asked to bleed off all four edges rather than compose inside the frame, so the crop the blog applies is the normal case rather than a lucky one. Geometry moved too: covers are square (1:1) instead of 16:9 and figures wide (16:9) instead of 4:3, which is also what makes a cover larger than a figure — `imageSize` is one request-wide tier (`GEMINI_IMAGE_SIZE`, default `1K`) rather than one value per kind, because which tiers exist is a property of the model and the default one answers 400 for both `512` and `2K`. A refused size is retried once at `1K`, since with soft failures everywhere it would otherwise cost every image of every article in silence.
- **Articles are laid out, not just written.** An article was composed as unbroken prose and published as a wall of text with a cover image, even though the blog has always been able to render more. It is now written *with* its layout in the markdown file itself: an `###` deck under the title, `:::note|tip|warn` callouts, and `![alt](image: prompt)` figures. Putting the layout in the file rather than in publish-time tool arguments is the point — Pinky reviews and revises the real shape of the post before it is published, instead of approving a description of one. `publish_article` translates that layout into the blog's MDX (`<Callout>`, `<figure>`), generates one illustration per figure alongside the cover, and patches them in once the slug is known. Figure generation is soft-failing like the cover: a figure that cannot be generated has its marker dropped, and the article publishes regardless.
- **Publishing goes through the blog's own MCP server.** Finished articles are delivered by driving the `articles` server that ships inside thiagocolen.github.io (`create_draft` → `add_asset` → `update_post` → `stage_changes`) instead of cloning the repo and writing `.mdx` files here. The blog's frontmatter shape, slug rules, asset location and safe branch are now defined in exactly one place — `develop-tools/posts.js`, the same module the site's npm scripts use — so the two can no longer drift. The agent never calls `publish_post`: drafts stay `unpublished`, and no workflow builds `new-articles`, leaving both gates to the public site in human hands.
- **Article slugs are short.** The blog derives the slug from the title with no override, so the title itself is now capped at about six words; longer or wittier phrasing moves to the post's `headline` (the deck under the title), which never reaches the URL. `publish_article` takes `title` and `headline` separately, as the blog's tools describe them.
- **Articles are written to a published standard.** `ARTICLE_CRAFT_PROMPT` — topic/audience/purpose/stakes fixed before drafting, three-part structure, one idea per paragraph, varied sentences, supported claims — is now part of the system prompt, distilled from Cambridge International, Gotham Writers Workshop, BBC Bitesize and two practitioner guides.

### Added
- `src/utils/illustration-styles.ts` — the ten illustration styles and `styleFor`, the deterministic per-article pick. Agent Flow now documents **where image instructions belong**: what a picture shows is the model's to say, how the set looks is not.
- `src/agents/layout.ts` — the diagramation layer: lifts the deck, extracts figures, and renders callouts into the blog's MDX. Pure string transforms, no I/O, so the interesting cases are cheap to test.
- `generateBodyImage()` beside `generateCoverImage()` in `src/utils/image-gen.ts`, shaped for a column of prose rather than for a banner. Both share one soft-failure path.
- **[Article Writing Guide](docs/docs/developer/article-writing-guide.mdx)** — the long-form standard behind `ARTICLE_CRAFT_PROMPT`, with the reasoning and sources for each rule, including the layout marks and what each one is for.
- `BLOG_REPO_PATH` (default `../thiagocolen.github.io`), pointing at the checkout whose MCP server publishes articles.
- `GEMINI_IMAGE_SIZE` (default `1K`), the pixel tier every generated image is requested at.
- `ANTHROPIC_MAX_TOKENS` (default 16000) — the output limit per reply, and `wasTruncated()` beside `extractTurnReply()` to detect a turn that hit it.
- Agent Flow now documents **how an article gets written** and **where to add more detailed article instructions**.
- The documentation site's hero banner is the warm end of the brand — gold running to orange — instead of the navy it shared with every other surface, and it carries the site's name and tagline. Cream lettering could not come with it — it manages 1.6:1 on gold — so the banner carries a darkened navy ink measuring 7.2:1 against its darkest stop, and the call to action takes the navy the background gave up. The pinwheel weave over the top lightens only, never tints dark, so that measured floor is a floor and not an average.
- The home page no longer ships the Docusaurus template's placeholder meta description (`"Description will go into a meta tag in <head />"`) or a `<title>` reading "Hello from …"; both now come from the site's own title and tagline.
- `docs/developer/project-structure.mdx` had drifted: `agents/layout.ts` and four of the seven `utils/` modules — `blog-mcp.ts`, `image-gen.ts`, `illustration-styles.ts`, `session.ts` — existed in the tree but not in the document.

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
