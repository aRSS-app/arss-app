import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './mcp-tools.js';

const safeEq = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Stateless Streamable HTTP: a fresh server + transport per request.
export function mountMcp(app, db, token) {
  app.post('/mcp', async (req, res) => {
    if (token) {
      const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
      if (!m || !safeEq(m[1], token)) return res.status(401).json({ error: 'unauthorised' });
    }
    const server = buildMcpServer(db);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  const no = (_, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', no);
  app.delete('/mcp', no);
}
