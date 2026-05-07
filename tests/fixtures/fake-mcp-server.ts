import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

export function createFakeMcpServer(label: string): Server {
  const server = new Server({
    name: `fake-${label}-mcp-child`,
    version: "1.0.0"
  }, {
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { listChanged: true }
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: label === "http" ? "query" : "echo",
        description: "Allowed fake child MCP tool.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" }
          }
        }
      },
      {
        name: "hidden",
        description: "This tool should not be exposed by Relaybase.",
        inputSchema: { type: "object", properties: {} }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    structuredContent: {
      child: label,
      name: request.params.name,
      arguments: request.params.arguments ?? {}
    },
    content: [
      {
        type: "text",
        text: `${label}:${request.params.name}`
      }
    ]
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: label === "http" ? "docs://http-index" : "docs://index",
        name: "docs",
        mimeType: "text/plain"
      },
      {
        uri: "secret://hidden",
        name: "secret",
        mimeType: "text/plain"
      }
    ]
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [
      {
        uri: request.params.uri,
        mimeType: "text/plain",
        text: `${label} resource ${request.params.uri}`
      }
    ]
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "debug",
        description: "Allowed fake child MCP prompt."
      },
      {
        name: "hidden",
        description: "This prompt should not be exposed by Relaybase."
      }
    ]
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `${label} prompt ${request.params.name}`
        }
      }
    ]
  }));

  return server;
}
