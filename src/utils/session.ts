import { randomUUID } from "crypto";

/**
 * Thread identity for the MCP entrypoint.
 *
 * Every entrypoint keys LangGraph checkpoints by `thread_id`, so the thread is
 * what makes The Brain's journey (greet → topic → subtopic → action) advance
 * instead of restarting. MCP has no session handshake of its own — unlike ACP,
 * which gets a `sessionId` from `session/new` — so the server process itself is
 * the session boundary: one running MCP server, one journey.
 */

/** One thread per MCP server process, so a client session is one journey. */
export const MCP_SESSION_THREAD_ID = `mcp-session-${randomUUID()}`;

/**
 * Resolves the thread a tool call runs on.
 *
 * An explicit id wins, so a caller can deliberately branch into a separate
 * journey. Anything blank falls back to this process's thread — never to a
 * fresh one, which would strand the conversation on step one forever.
 */
export function resolveThreadId(explicit?: string): string {
  const trimmed = explicit?.trim();
  return trimmed ? trimmed : MCP_SESSION_THREAD_ID;
}
