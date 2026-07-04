import { z } from "zod";

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.any().optional(),
});

export const InitializeParamsSchema = z.object({
  protocolVersion: z.union([z.string(), z.number()]),
  capabilities: z.record(z.any()).optional().default({}),
  clientInfo: z.object({
    name: z.string(),
    version: z.string().optional(),
  }).optional(),
});

export const RunAgentParamsSchema = z.object({
  agentName: z.enum(["the-brain", "brain", "supervisor", "developer", "writer", "instructor", "specialist", "publisher"]),
  prompt: z.string(),
  threadId: z.string(),
});

export const SessionNewParamsSchema = z.object({
  cwd: z.string(),
  mcpServers: z.array(z.any()).optional().default([]),
  additionalDirectories: z.array(z.string()).optional(),
});

export const SessionPromptParamsSchema = z.object({
  sessionId: z.string(),
  prompt: z.union([
    z.string(),
    z.array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
      })
    ),
  ]),
});

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type InitializeParams = z.infer<typeof InitializeParamsSchema>;
export type RunAgentParams = z.infer<typeof RunAgentParamsSchema>;
export type SessionNewParams = z.infer<typeof SessionNewParamsSchema>;
export type SessionPromptParams = z.infer<typeof SessionPromptParamsSchema>;
