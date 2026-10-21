import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const directusUrl = requiredUrl('DIRECTUS_URL');
const directusToken = requiredEnv('DIRECTUS_TOKEN');
const bearerToken = requiredEnv('MCP_BEARER_TOKEN');
const port = parsePort(process.env.PORT ?? '3000');
const host = process.env.HOST ?? '0.0.0.0';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
function requiredUrl(name: string): URL {
  const raw = requiredEnv(name);
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`${name} must use HTTPS outside local development`);
  }
  return url;
}
function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  return n;
}

const apiBase = directusUrl.toString().replace(/\/$/, '');
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

function isAuthorized(header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(bearerToken);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

async function directusFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const url = new URL(path.replace(/^\//, ''), `${apiBase}/`);
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${directusToken}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Directus request failed with HTTP ${response.status}`);
  if (!body) return {};
  try { return JSON.parse(body) as unknown; } catch { throw new Error('Directus returned an unexpected response format'); }
}

function createMcpServer() {
  const server = new McpServer({ name: 'ClearFlow Directus MCP', version: '0.1.0' });
  server.registerTool('directus_ping', {
    title: 'Test Directus connection',
    description: 'Verify the configured Directus API is reachable and the supplied API token is accepted.',
    inputSchema: {},
  }, async () => {
    const result = await directusFetch('/users/me?fields=id,role,status');
    return { content: [{ type: 'text', text: JSON.stringify({ connected: true, user: result }) }] };
  });
  server.registerTool('list_collections', {
    title: 'List Directus collections',
    description: 'List collection names and metadata visible to the configured Directus token.',
    inputSchema: {},
  }, async () => {
    const result = await directusFetch('/collections');
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.registerTool('list_fields', {
    title: 'List fields for a collection',
    description: 'Inspect fields for a collection visible to the configured Directus token.',
    inputSchema: { collection: z.string().min(1).max(128).regex(/^[A-Za-z0-9_]+$/) },
  }, async ({ collection }) => {
    const result = await directusFetch(`/fields/${encodeURIComponent(collection)}`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.registerTool('read_items', {
    title: 'Read Directus records',
    description: 'Read a bounded page of records from one collection. Directus permissions still apply.',
    inputSchema: {
      collection: z.string().min(1).max(128).regex(/^[A-Za-z0-9_]+$/),
      limit: z.number().int().min(1).max(50).default(10),
      offset: z.number().int().min(0).max(10000).default(0),
    },
  }, async ({ collection, limit, offset }) => {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const result = await directusFetch(`/items/${encodeURIComponent(collection)}?${query}`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  return server;
}

const transports = new Map<string, StreamableHTTPServerTransport>();
app.all('/mcp', async (req, res) => {
  if (!isAuthorized(req.header('authorization'))) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    let transport: StreamableHTTPServerTransport;
    const sessionId = req.header('mcp-session-id');
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      let createdTransport!: StreamableHTTPServerTransport;
      createdTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports.set(id, createdTransport); },
      });
      transport = createdTransport;
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) transports.delete(id);
      };
      const server = createMcpServer();
      await server.connect(transport);
    } else {
      res.status(400).json({ error: 'Invalid MCP session or initialize request' });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error instanceof Error ? error.message : 'unknown error');
    if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
  }
});

app.listen(port, host, () => {
  console.log(`ClearFlow Directus MCP listening on ${host}:${port}`);
});
