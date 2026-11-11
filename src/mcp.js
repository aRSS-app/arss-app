// stdio entry point (for Claude Desktop / Claude Code on the same machine)
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDb } from './db.js';
import { buildMcpServer } from './mcp-tools.js';

await buildMcpServer(openDb()).connect(new StdioServerTransport());
