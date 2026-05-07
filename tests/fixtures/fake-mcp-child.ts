import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFakeMcpServer } from "./fake-mcp-server.ts";

await createFakeMcpServer("stdio").connect(new StdioServerTransport());
