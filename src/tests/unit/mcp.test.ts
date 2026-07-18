import { describe, it, expect, vi } from "vitest";

// `src/mcp.ts` cannot be imported here — it calls validateConfig() and opens a
// stdio transport at module load. The thread logic lives in its own module for
// exactly that reason.
import { MCP_SESSION_THREAD_ID, resolveThreadId } from "../../utils/session.js";

describe("MCP_SESSION_THREAD_ID", () => {
  it("follows the entrypoint's thread-naming convention", () => {
    expect(MCP_SESSION_THREAD_ID).toMatch(/^mcp-session-/);
  });

  it("is long enough not to collide between concurrent server processes", () => {
    // All entrypoints share one state.db keyed only by thread id, so a short
    // id would let two servers land in each other's conversation.
    expect(MCP_SESSION_THREAD_ID.replace("mcp-session-", "").length).toBeGreaterThanOrEqual(32);
  });
});

describe("validateConfig — PATBA_API_KEY requirement", () => {
  /**
   * Loads config.js against a controlled environment. dotenv is stubbed out so
   * the developer's real .env cannot leak keys into these assertions.
   */
  const loadConfig = async (env: Record<string, string | undefined>) => {
    vi.resetModules();
    vi.doMock("dotenv", () => ({ default: { config: () => ({ parsed: {} }) } }));
    const saved = { ...process.env };
    for (const key of ["ANTHROPIC_API_KEY", "PATBA_API_KEY", "API_KEY", "AWS_APP_API_KEY"]) {
      delete process.env[key];
    }
    Object.assign(process.env, env);
    try {
      return await import("../../config.js");
    } finally {
      process.env = saved;
      vi.doUnmock("dotenv");
    }
  };

  it("still requires the key by default, for the REST entrypoint", async () => {
    const { validateConfig } = await loadConfig({ ANTHROPIC_API_KEY: "sk-test" });
    expect(() => validateConfig()).toThrow(/PATBA_API_KEY/);
  });

  it("does not require it when the caller opts out", async () => {
    // The MCP entrypoint serves no HTTP surface, so the key is dead weight —
    // and MCP clients spawn servers with a filtered environment that would
    // drop it anyway.
    const { validateConfig } = await loadConfig({ ANTHROPIC_API_KEY: "sk-test" });
    expect(() => validateConfig({ requirePatbaApiKey: false })).not.toThrow();
  });

  it("still requires ANTHROPIC_API_KEY when opted out", async () => {
    const { validateConfig } = await loadConfig({ PATBA_API_KEY: "secret" });
    expect(() => validateConfig({ requirePatbaApiKey: false })).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("resolveThreadId", () => {
  it("returns the same thread across calls so the journey advances", () => {
    // The regression this guards: a per-call random id stranded every MCP
    // conversation on step one of the journey.
    expect(resolveThreadId()).toBe(resolveThreadId());
    expect(resolveThreadId()).toBe(MCP_SESSION_THREAD_ID);
  });

  it("lets an explicit id branch into a separate conversation", () => {
    expect(resolveThreadId("article-drafting")).toBe("article-drafting");
  });

  it("trims a padded id rather than treating it as a distinct thread", () => {
    expect(resolveThreadId("  article-drafting  ")).toBe("article-drafting");
  });

  it("falls back to the process thread for blank input", () => {
    for (const blank of [undefined, "", "   ", "\n\t"]) {
      expect(resolveThreadId(blank), `blank input ${JSON.stringify(blank)}`).toBe(
        MCP_SESSION_THREAD_ID,
      );
    }
  });
});
