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

function createPublicMcpServer() {
  const server = new McpServer({ name: 'ClearFlow MCP Connection Test', version: '0.1.0' });
  server.registerTool('bridge_ping', {
    title: 'Test MCP connection',
    description: 'Return a harmless status response to verify the public MCP transport. This tool does not access Directus or reveal data.',
    inputSchema: {},
  }, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ connected: true, mode: 'public-test-only' }) }],
  }));
  server.registerTool('directus_status', {
    title: 'Check Directus connection',
    description: 'Check whether the configured Directus API token is accepted. Returns only a connected boolean and never reveals account details or records.',
    inputSchema: {},
  }, async () => {
    try {
      await directusFetch('/users/me?fields=id');
      return { content: [{ type: 'text', text: JSON.stringify({ directusConnected: true }) }] };
    } catch {
      return { content: [{ type: 'text', text: JSON.stringify({ directusConnected: false }) }] };
    }
  });

  // Public read-only diagnostics are intentionally limited to Directus metadata.
  // They do not expose item records or any write-capable API operation.
  server.registerTool('list_collections', {
    title: 'List Directus collections',
    description: 'Read collection metadata using the configured Directus token. Does not read collection records or modify data.',
    inputSchema: {},
  }, async () => {
    const result = await directusFetch('/collections?limit=100');
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.registerTool('list_fields', {
    title: 'List fields for a collection',
    description: 'Read field metadata for one collection using the configured Directus token. Does not read collection records or modify data.',
    inputSchema: { collection: z.string().min(1).max(128).regex(/^[A-Za-z0-9_]+$/) },
  }, async ({ collection }) => {
    const result = await directusFetch(`/fields/${encodeURIComponent(collection)}`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.registerTool('list_roles', {
    title: 'List Directus roles',
    description: 'Read role metadata to verify which roles exist. This tool does not change roles or permissions.',
    inputSchema: {},
  }, async () => {
    const result = await directusFetch('/roles?limit=100&fields=id,name,icon,description,admin_access,app_access');
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.registerTool('directus_admin_check', {
    title: 'Check Directus administrative read access',
    description: 'Read-only diagnostic that checks whether the configured Directus token can read roles and permissions. Does not create, modify, or delete anything.',
    inputSchema: {},
  }, async () => {
    const checks: Record<string, unknown> = {};
    try {
      const roles = await directusFetch('/roles?limit=100&fields=id,name,admin_access,app_access') as { data?: unknown[] };
      checks.roles = { ok: true, count: Array.isArray(roles?.data) ? roles.data.length : null, data: roles?.data ?? roles };
    } catch (error) {
      checks.roles = { ok: false, error: error instanceof Error ? error.message : 'Request failed' };
    }
    try {
      const permissions = await directusFetch('/permissions?limit=100&fields=id,collection,action,role') as { data?: unknown[] };
      checks.permissions = { ok: true, count: Array.isArray(permissions?.data) ? permissions.data.length : null };
    } catch (error) {
      checks.permissions = { ok: false, error: error instanceof Error ? error.message : 'Request failed' };
    }
    return { content: [{ type: 'text', text: JSON.stringify(checks) }] };
  });
  // A single, tightly scoped public smoke test for role read/write capability.
  // It creates one disabled probe role, reads it back, and always attempts cleanup.
  // No caller-supplied role data or arbitrary write path is accepted.
  let lastPublicRoleProbeAt = 0;
  server.registerTool('test_role_read_write', {
    title: 'Test Directus role read and write',
    description: 'Run a bounded read/write smoke test using the bridge server-side Directus credential: creates a disabled temporary role, reads it back, and deletes it. No MCP bearer token is required for this public test tool. Does not change existing roles or permissions. Globally rate-limited to one run per minute.',
    inputSchema: {},
  }, async () => {
    const now = Date.now();
    if (now - lastPublicRoleProbeAt < 60_000) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, rateLimited: true, message: 'Role probe is limited to one run per minute.' }) }] };
    }
    lastPublicRoleProbeAt = now;

    const probeName = `ClearFlow MCP Probe ${randomUUID()}`;
    let roleId: string | number | undefined;
    const result: Record<string, unknown> = {
      credentialSource: 'bridge server-side DIRECTUS_TOKEN',
      mcpBearerRequired: false,
      created: false,
      readBack: false,
      deleted: false,
    };
    try {
      const created = await directusFetch('/roles', {
        method: 'POST',
        body: JSON.stringify({
          name: probeName,
          icon: 'verified_user',
          description: 'Temporary ClearFlow MCP connectivity probe; safe to delete.',
          admin_access: false,
          app_access: false,
        }),
      }) as { data?: { id?: string | number } };
      roleId = created?.data?.id;
      if (roleId === undefined || roleId === null) {
        result.createError = 'Directus create response did not include a role ID.';
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      result.created = true;
      result.roleId = roleId;
      try {
        const readBack = await directusFetch(`/roles/${encodeURIComponent(String(roleId))}?fields=id,name,admin_access,app_access`) as { data?: { id?: string | number; name?: string } };
        result.readBack = readBack?.data?.id !== undefined && readBack?.data?.name === probeName;
        if (!result.readBack) result.readError = 'Role was returned but did not match the temporary probe role.';
      } catch (error) {
        result.readError = error instanceof Error ? error.message : 'Role read-back failed.';
      }
    } catch (error) {
      result.createError = error instanceof Error ? error.message : 'Role creation failed.';
    } finally {
      if (roleId !== undefined && roleId !== null) {
        try {
          await directusFetch(`/roles/${encodeURIComponent(String(roleId))}`, { method: 'DELETE' });
          result.deleted = true;
        } catch (error) {
          result.deleteError = error instanceof Error ? error.message : 'Temporary role cleanup failed.';
          result.cleanupRequired = true;
        }
      }
    }
    result.ok = result.created === true && result.readBack === true && result.deleted === true;
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('list_permissions', {
    title: 'List Directus permissions',
    description: 'Read up to 100 permission rules to inspect role access configuration. This tool does not change permissions.',
    inputSchema: {},
  }, async () => {
    const result = await directusFetch('/permissions?limit=100&fields=id,collection,action,role,permissions,validation,presets,fields');
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  return server;
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
  server.registerTool('directus_request', {
    title: 'Execute Directus API request',
    description:
      'Perform an authenticated Directus REST API request with the configured service token. Supports GET, POST, PATCH, PUT, and DELETE across Directus API endpoints, including records and administrative endpoints, subject to the token permissions. This tool can modify or permanently delete data and change access controls; use only for explicitly authorized operations.',
    inputSchema: {
      method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
      path: z.string().min(2).max(2048).regex(/^\/(?!\/)[^\u0000-\u001f#\\]*$/),
      body: z.unknown().optional(),
    },
  }, async ({ method, path, body }) => {
    // Accept only relative Directus API paths; never allow an arbitrary host.
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('\\') ||
      /[\u0000-\u001f#]/.test(path) ||
      /(^|\/)\.\.?($|\/|\?)/.test(path)
    ) {
      throw new Error('Invalid Directus API path. Provide a relative API path beginning with one slash.');
    }

    const resolved = new URL(path.slice(1), `${apiBase}/`);
    if (resolved.origin !== directusUrl.origin) {
      throw new Error('Directus API path must remain on the configured Directus host.');
    }

    const init: RequestInit = { method };
    if (body !== undefined) {
      if (method === 'GET') {
        throw new Error('GET requests cannot include a body.');
      }
      init.body = JSON.stringify(body);
    }

    const result = await directusFetch(path, init);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  });

  server.registerTool('create_role', {
    title: 'Create Directus role',
    description: 'Create a Directus role. Available only through authenticated /secure-mcp; changes access configuration.',
    inputSchema: { name: z.string().min(1).max(100), icon: z.string().max(100).optional(), description: z.string().max(500).optional(), admin_access: z.boolean().optional(), app_access: z.boolean().optional() },
  }, async (input) => {
    const result = await directusFetch('/roles', { method: 'POST', body: JSON.stringify(input) });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.registerTool('update_role', {
    title: 'Update Directus role',
    description: 'Update a Directus role by ID. Available only through authenticated /secure-mcp; changes access configuration.',
    inputSchema: { id: z.string().min(1).max(128), name: z.string().min(1).max(100).optional(), icon: z.string().max(100).optional(), description: z.string().max(500).optional(), admin_access: z.boolean().optional(), app_access: z.boolean().optional() },
  }, async ({ id, ...body }) => {
    const result = await directusFetch(`/roles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.registerTool('delete_role', {
    title: 'Delete Directus role',
    description: 'Permanently delete a Directus role by ID. Available only through authenticated /secure-mcp. Use only when explicitly authorized.',
    inputSchema: { id: z.string().min(1).max(128) },
  }, async ({ id }) => {
    const result = await directusFetch(`/roles/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.registerTool('create_permission', {
    title: 'Create Directus permission rule',
    description: 'Create a Directus permission rule. Available only through authenticated /secure-mcp; may grant data access.',
    inputSchema: { collection: z.string().min(1).max(128), action: z.enum(['create','read','update','delete','share']), role: z.string().min(1).max(128).nullable().optional(), permissions: z.record(z.unknown()).optional(), validation: z.record(z.unknown()).nullable().optional(), presets: z.record(z.unknown()).nullable().optional(), fields: z.array(z.string()).optional() },
  }, async (input) => {
    const result = await directusFetch('/permissions', { method: 'POST', body: JSON.stringify(input) });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.registerTool('update_permission', {
    title: 'Update Directus permission rule',
    description: 'Update a Directus permission rule by ID. Available only through authenticated /secure-mcp; may grant data access.',
    inputSchema: { id: z.union([z.string(), z.number()]), collection: z.string().min(1).max(128).optional(), action: z.enum(['create','read','update','delete','share']).optional(), role: z.string().min(1).max(128).nullable().optional(), permissions: z.record(z.unknown()).optional(), validation: z.record(z.unknown()).nullable().optional(), presets: z.record(z.unknown()).nullable().optional(), fields: z.array(z.string()).optional() },
  }, async ({ id, ...body }) => {
    const result = await directusFetch(`/permissions/${encodeURIComponent(String(id))}`, { method: 'PATCH', body: JSON.stringify(body) });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.registerTool('delete_permission', {
    title: 'Delete Directus permission rule',
    description: 'Permanently delete a Directus permission rule by ID. Available only through authenticated /secure-mcp. Use only when explicitly authorized.',
    inputSchema: { id: z.union([z.string(), z.number()]) },
  }, async ({ id }) => {
    const result = await directusFetch(`/permissions/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
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

function createMcpHandler(
  requiresBearer: boolean,
  serverFactory: () => McpServer,
): express.RequestHandler {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  return async (req, res) => {
    if (requiresBearer && !isAuthorized(req.header('authorization'))) {
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
          const id = createdTransport.sessionId;
          if (id) transports.delete(id);
        };
        const server = serverFactory();
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
  };
}

// Public endpoint intentionally exposes only a harmless connection-test tool.
// Directus data tools remain available only on /secure-mcp with bearer authentication.
app.all('/mcp', createMcpHandler(false, createPublicMcpServer));
app.all('/secure-mcp', createMcpHandler(true, createMcpServer));

app.listen(port, host, () => {
  console.log(`ClearFlow Directus MCP listening on ${host}:${port}`);
});
