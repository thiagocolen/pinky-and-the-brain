import { describe, it, expect, afterAll } from "vitest";
import { AcpServer } from "../../protocol/acp-server.js";
import { checkpointer } from "../../agents/graph.js";

describe("ACP Server JSON-RPC Protocol", () => {
  afterAll(async () => {
    await checkpointer.close();
  });
  it("should handle initialize request correctly", async () => {
    const server = new AcpServer();
    const initializeRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "initialize",
      params: {
        protocolVersion: "2026-06-24",
        capabilities: {},
        clientInfo: {
          name: "test-client",
          version: "1.0.0",
        },
      },
    });

    const rawResponse = await server.handleInput(initializeRequest);
    const response = JSON.parse(rawResponse);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe("1");
    expect(response.result).toBeDefined();
    expect(response.result.protocolVersion).toBe("2026-06-24");
    expect(response.result.serverInfo.name).toBe("pinky-and-the-brain-agents");
  });

  it("should return error if not initialized when calling agents/list", async () => {
    const server = new AcpServer();
    const listRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: "2",
      method: "agents/list",
      params: {},
    });

    const rawResponse = await server.handleInput(listRequest);
    const response = JSON.parse(rawResponse);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe("2");
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32002);
  });

  it("should list agents successfully after initialization", async () => {
    const server = new AcpServer();
    
    const initRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "initialize",
      params: {
        protocolVersion: "2026-06-24",
        capabilities: {},
        clientInfo: { name: "test" },
      },
    });
    await server.handleInput(initRequest);

    const listRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: "2",
      method: "agents/list",
      params: {},
    });

    const rawResponse = await server.handleInput(listRequest);
    const response = JSON.parse(rawResponse);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe("2");
    expect(response.result).toBeDefined();
    expect(response.result.agents).toHaveLength(2);
    expect(response.result.agents[0].name).toBe("the-brain");
  });
});
