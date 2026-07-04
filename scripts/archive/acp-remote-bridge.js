import https from "https";
import readline from "readline";

const remoteHost = "pi-33c16f8ab4d94539858b798564ce9617.ecs.us-east-1.on.aws";
const apiKey = process.env.PATBA_API_KEY;
if (!apiKey) {
  console.error("Error: PATBA_API_KEY environment variable is not set.");
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

let isInitialized = false;
const sessions = new Map(); // local sessionId -> AWS threadId

rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);

    switch (request.method) {
      case "initialize":
        isInitialized = true;
        console.log(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: request.params.protocolVersion,
              serverInfo: {
                name: "pinky-and-the-brain-remote-bridge",
                version: "1.0.0",
              },
              capabilities: { agents: true },
            },
          }),
        );
        break;

      case "session/new":
        if (!isInitialized) {
          sendError(request.id, -32002, "Server not initialized.");
          break;
        }
        // Create thread on AWS
        createAWSThread((err, threadId) => {
          if (err) {
            sendError(
              request.id,
              -32603,
              `AWS creation failed: ${err.message}`,
            );
          } else {
            const localSessionId = `session_${Math.random().toString(36).substring(2, 15)}`;
            sessions.set(localSessionId, threadId);
            console.log(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: { sessionId: localSessionId },
              }),
            );
          }
        });
        break;

      case "session/prompt":
        if (!isInitialized) {
          sendError(request.id, -32002, "Server not initialized.");
          break;
        }
        const session = sessions.get(request.params.sessionId);
        if (!session) {
          sendError(
            request.id,
            -32602,
            `Session not found: ${request.params.sessionId}`,
          );
          break;
        }

        let promptText = "";
        if (typeof request.params.prompt === "string") {
          promptText = request.params.prompt;
        } else if (Array.isArray(request.params.prompt)) {
          promptText = request.params.prompt
            .filter(
              (block) =>
                block.type === "text" && typeof block.text === "string",
            )
            .map((block) => block.text)
            .join("\n");
        }

        // Trigger run on AWS
        triggerAWSRun(session, promptText, (err, runId) => {
          if (err) {
            sendError(
              request.id,
              -32603,
              `Failed to trigger AWS run: ${err.message}`,
            );
          } else {
            // Listen to SSE updates
            connectAWSStream(
              session,
              runId,
              request.params.sessionId,
              request.id,
            );
          }
        });
        break;

      case "agents/list":
        console.log(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              agents: [
                {
                  name: "the-brain",
                  description:
                    "Speaks as The Brain, an instructor on technical domains and world domination.",
                },
              ],
            },
          }),
        );
        break;

      default:
        sendError(request.id, -32601, `Method not found: ${request.method}`);
    }
  } catch (err) {
    sendError(null, -32700, `Parse error: ${err.message}`);
  }
});

function sendError(id, code, message) {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

function createAWSThread(callback) {
  const options = {
    hostname: remoteHost,
    path: "/threads",
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
  };

  const req = https.request(options, (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (parsed.thread_id) {
          callback(null, parsed.thread_id);
        } else {
          callback(new Error(body || "No thread ID returned"));
        }
      } catch (e) {
        callback(e);
      }
    });
  });

  req.on("error", callback);
  req.end();
}

function triggerAWSRun(threadId, prompt, callback) {
  const options = {
    hostname: remoteHost,
    path: `/threads/${threadId}/runs`,
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
  };

  const req = https.request(options, (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (parsed.run_id) {
          callback(null, parsed.run_id);
        } else {
          callback(new Error(body || "No run ID returned"));
        }
      } catch (e) {
        callback(e);
      }
    });
  });

  req.on("error", callback);
  req.write(JSON.stringify({ agentName: "the-brain", prompt, wait: false }));
  req.end();
}

function connectAWSStream(threadId, runId, localSessionId, requestId) {
  const options = {
    hostname: remoteHost,
    path: `/threads/${threadId}/runs/${runId}/stream`,
    method: "GET",
    headers: {
      "X-API-Key": apiKey,
      Accept: "text/event-stream",
    },
  };

  const req = https.request(options, (res) => {
    let buffer = "";

    res.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep last incomplete line

      let currentEvent = "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.substring(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.substring(5).trim();
          try {
            const parsed = JSON.parse(data);
            if (parsed.event === "progress") {
              const progressMessage = `🔄 [${parsed.progress.node}] ${parsed.progress.status}`;
              console.log(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: localSessionId,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      messageId: `progress_${parsed.progress.node}_${Date.now()}`,
                      content: { type: "text", text: `${progressMessage}\n` },
                    },
                  },
                }),
              );
            } else if (parsed.event === "complete") {
              let responseText = "";
              if (
                parsed.data?.result?.writerState?.draftArticle &&
                !parsed.data.result.writerState.isSaved
              ) {
                responseText = parsed.data.result.writerState.draftArticle;
              } else if (parsed.data?.result?.instructorState?.explanation) {
                responseText = parsed.data.result.instructorState.explanation;
              } else if (parsed.data?.result?.developerState?.testResults) {
                const res = parsed.data.result.developerState.testResults;
                responseText = `## Developer Workflow Execution\n\npassed: ${res.passed}, exitCode: ${res.exitCode}`;
              } else if (parsed.data?.result?.messages) {
                // Try parsing standard messages
                const aiMsgs = (parsed.data.result.messages || [])
                  .filter(
                    (m) => m.type === "ai" || m.lc === 1 || m.kwargs?.content,
                  )
                  .map((m) => m.kwargs?.content || "");
                responseText =
                  aiMsgs.length > 0
                    ? aiMsgs.join("\n\n")
                    : "Workflow completed.";
              } else if (parsed.data?.error) {
                responseText = `Error: ${parsed.data.error}`;
              } else {
                responseText = "Workflow completed successfully.";
              }

              // Send final response text chunk
              console.log(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: localSessionId,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      messageId: `result_${Date.now()}`,
                      content: { type: "text", text: responseText },
                    },
                  },
                }),
              );

              // End turn
              console.log(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: requestId,
                  result: { stopReason: "end_turn" },
                }),
              );
            }
          } catch (e) {
            // ignore JSON parse errors of non-JSON stream parts
          }
        }
      }
    });
  });

  req.on("error", (e) => {
    sendError(requestId, -32603, `Stream connection error: ${e.message}`);
  });

  req.end();
}
