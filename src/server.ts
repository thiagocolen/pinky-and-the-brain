import express from "express";
import { runGraphWorkflow } from "./agents/graph.js";
import { validateConfig, config, validateApiKey } from "./config.js";
import { isAIMessage, getMessageContent } from "./utils/messages.js";
import { logger } from "./utils/logger.js";
import { EventEmitter } from "events";
import axios from "axios";

try {
  validateConfig();
} catch (e: any) {
  logger.error("Configuration validation failed:", e.message);
  process.exit(1);
}

const app = express();
app.use(express.json());

// Health check endpoints (bypassing security middleware)
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// Security middleware checking request header X-API-Key
app.use((req, res, next) => {
  const apiKeyHeader = req.header("X-API-Key") || req.header("x-api-key");
  if (!apiKeyHeader || !validateApiKey(apiKeyHeader)) {
    logger.warn("[REST] Unauthorized access attempt: invalid or missing X-API-Key");
    res.status(401).json({ error: "401 Unauthorized" });
    return;
  }
  next();
});

const PORT = process.env.PORT || 8080;

// Global event emitter for active runs to support Server-Sent Events (SSE)
const runEvents = new EventEmitter();

// In-memory status store for runs
const activeRuns = new Map<string, { threadId: string; status: string; result?: any; error?: any }>();

// Simple thread ID generator
function generateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).substring(2, 15)}`;
}

// 1. POST /threads - Create a new unique state-persisted thread ID
app.post("/threads", (req, res) => {
  const threadId = generateId("thread");
  logger.info(`[REST] Thread created: ${threadId}`);
  res.status(201).json({ thread_id: threadId });
});

// 2. POST /threads/:thread_id/runs - Run the agent workflow
app.post("/threads/:thread_id/runs", async (req, res) => {
  const { thread_id } = req.params;
  const { agentName = "the-brain", prompt, wait = false } = req.body;

  if (!prompt) {
    res.status(400).json({ error: "Missing required parameter: prompt" });
    return;
  }

  const runId = generateId("run");
  logger.info(`[REST] Starting run ${runId} on thread ${thread_id} with agent ${agentName}`);

  // Initialize status
  activeRuns.set(runId, { threadId: thread_id, status: "running" });

  const runPromise = (async () => {
    try {
      const result = await runGraphWorkflow(agentName, prompt, thread_id, (progress) => {
        // Emit progress update to SSE listeners
        runEvents.emit(`progress:${runId}`, progress);
      });

      activeRuns.set(runId, { threadId: thread_id, status: "completed", result });
      logger.info(`[REST] Run ${runId} completed successfully`);
      runEvents.emit(`complete:${runId}`, { result });
      return result;
    } catch (err: any) {
      logger.error(`[REST] Run ${runId} failed: ${err.message}`);
      activeRuns.set(runId, { threadId: thread_id, status: "failed", error: err.message });
      runEvents.emit(`complete:${runId}`, { error: err.message });
      throw err;
    }
  })();

  if (wait) {
    try {
      const result = await runPromise;
      res.json({ run_id: runId, status: "completed", result });
    } catch (err: any) {
      res.status(500).json({ run_id: runId, status: "failed", error: err.message });
    }
  } else {
    // Return queued/running immediately
    res.status(202).json({ run_id: runId, status: "running" });
  }
});

// 3. GET /threads/:thread_id/runs/:run_id/stream - Server-Sent Events stream for execution progress
app.get("/threads/:thread_id/runs/:run_id/stream", (req, res) => {
  const { run_id } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  logger.info(`[REST] SSE Client connected to stream for run: ${run_id}`);

  // Send initial message
  res.write(`data: ${JSON.stringify({ event: "connected", run_id })}\n\n`);

  const onProgress = (progress: any) => {
    res.write(`data: ${JSON.stringify({ event: "progress", progress })}\n\n`);
  };

  const onComplete = (data: any) => {
    res.write(`data: ${JSON.stringify({ event: "complete", data })}\n\n`);
    cleanup();
    res.end();
  };

  const cleanup = () => {
    runEvents.off(`progress:${run_id}`, onProgress);
    runEvents.off(`complete:${run_id}`, onComplete);
    logger.info(`[REST] SSE Client disconnected/completed for run: ${run_id}`);
  };

  runEvents.on(`progress:${run_id}`, onProgress);
  runEvents.on(`complete:${run_id}`, onComplete);

  // If run is already completed when client connects
  const existing = activeRuns.get(run_id);
  if (existing && existing.status !== "running") {
    if (existing.status === "completed") {
      res.write(`data: ${JSON.stringify({ event: "complete", data: { result: existing.result } })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ event: "complete", data: { error: existing.error } })}\n\n`);
    }
    cleanup();
    res.end();
    return;
  }

  req.on("close", cleanup);
});

// 4. POST /webhooks/slack - Slack events webhook receiver
app.post("/webhooks/slack", async (req, res) => {
  // Handle Slack URL Verification Challenge
  if (req.body?.type === "url_verification") {
    logger.info("[WEBHOOK] Slack url_verification triggered");
    res.status(200).send(req.body.challenge);
    return;
  }

  // Handle actual events
  const payload = req.body;
  if (payload?.event && payload.event.type === "message" && !payload.event.bot_id) {
    const { text, channel, user } = payload.event;
    logger.info(`[WEBHOOK] Slack message received: "${text}" from user: ${user} in channel: ${channel}`);

    // Standard acknowledgement
    res.status(200).send("OK");

    // Process asynchronously in a dedicated channel thread
    const threadId = `slack-${channel}`;
    try {
      const result = await runGraphWorkflow("the-brain", text, threadId, (progress) => {
        logger.info(`[WEBHOOK-SLACK] Progress [${threadId}]: ${progress.status}`);
      });

      // Extract final message
      let responseText = "";
      if (result.instructorState?.explanation) {
        responseText = result.instructorState.explanation;
      } else {
        const aiMsgs = (result.messages || [])
          .filter(isAIMessage)
          .map(getMessageContent);
        responseText = aiMsgs.length > 0 ? aiMsgs.join("\n\n") : "Workflow completed.";
      }

      // Post back to Slack
      const token = process.env.SLACK_BOT_TOKEN;
      if (token) {
        await axios.post(
          "https://slack.com/api/chat.postMessage",
          { channel, text: responseText },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        logger.info(`[WEBHOOK-SLACK] Response sent successfully to channel: ${channel}`);
      } else {
        logger.warn("[WEBHOOK-SLACK] Cannot post response: SLACK_BOT_TOKEN environment variable not set.");
      }
    } catch (err: any) {
      logger.error(`[WEBHOOK-SLACK] Execution failed: ${err.message}`);
    }
    return;
  }

  res.status(200).send("Ignored");
});

// 5. POST /webhooks/teams - Microsoft Teams webhook receiver
app.post("/webhooks/teams", async (req, res) => {
  const payload = req.body;
  logger.info(`[WEBHOOK] Teams webhook received payload: ${JSON.stringify(payload)}`);

  // Microsoft Teams webhooks usually send a webhook activity card.
  // We acknowledge receipt and handle it asynchronously.
  res.status(200).json({ type: "message", text: "Processing your request..." });

  const text = payload?.text || "";
  const replyUrl = payload?.serviceUrl && payload?.conversation?.id
    ? `${payload.serviceUrl}/v3/conversations/${payload.conversation.id}/activities`
    : null;

  if (text) {
    const threadId = payload?.conversation?.id ? `teams-${payload.conversation.id}` : generateId("teams");
    try {
      const result = await runGraphWorkflow("the-brain", text, threadId, (progress) => {
        logger.info(`[WEBHOOK-TEAMS] Progress [${threadId}]: ${progress.status}`);
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

      if (replyUrl) {
        // Authenticating and replying to Microsoft Teams API usually requires bot framework credentials,
        // here we log it or perform a POST back to replyUrl if authorization can be constructed.
        logger.info(`[WEBHOOK-TEAMS] Would reply to ${replyUrl} with text: ${responseText}`);
      }
    } catch (err: any) {
      logger.error(`[WEBHOOK-TEAMS] Execution failed: ${err.message}`);
    }
  }
});

// Server startup
app.listen(PORT, () => {
  logger.info(`🚀 REST API Server running at http://localhost:${PORT}`);
  logger.info(`Exposing endpoints:`);
  logger.info(` - POST /threads`);
  logger.info(` - POST /threads/:thread_id/runs`);
  logger.info(` - GET  /threads/:thread_id/runs/:run_id/stream`);
  logger.info(` - POST /webhooks/slack`);
  logger.info(` - POST /webhooks/teams`);
});
