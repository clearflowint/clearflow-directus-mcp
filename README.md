# ClearFlow Directus MCP Bridge

A remote, Streamable HTTP MCP bridge between ChatGPT-compatible MCP clients and a Directus REST API.

## Current scope

This initial version intentionally exposes **read-only** tools:

- Public `/mcp` endpoint: exposes only `bridge_ping`, a harmless connection test that does not access Directus data
- Protected `/secure-mcp` endpoint: exposes `directus_ping`, `list_collections`, `list_fields`, and `read_items` behind `MCP_BEARER_TOKEN`

Writes, deletes, schema mutations, and flow execution are intentionally not included in this first version. Add them only after secure deployment and read-only validation.

## Security

- Keep `DIRECTUS_TOKEN` and `MCP_BEARER_TOKEN` in Coolify environment variables only.
- Do not commit `.env` or real credentials.
- Use a dedicated Directus service user with the minimum necessary read-only permissions.
- The public `/mcp` endpoint intentionally exposes only a harmless `bridge_ping` tool. It does not read Directus data.
- `/secure-mcp` requires `Authorization: Bearer <MCP_BEARER_TOKEN>` and contains the Directus data tools.
- Do not move data tools onto the public endpoint or remove bearer authentication from `/secure-mcp`.
- Put the service behind HTTPS in Coolify and expose `/mcp` as the MCP endpoint. `/healthz` is a non-sensitive health check.
- Do not use the Directus administrator token.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DIRECTUS_URL` | Yes | Base URL, e.g. `https://clearflow-data.duckdns.org` |
| `DIRECTUS_TOKEN` | Yes | Directus API token for a dedicated read-only service user |
| `MCP_BEARER_TOKEN` | Yes | Long random secret sent by the MCP client as `Authorization: Bearer …` |
| `HOST` | No | Defaults to `0.0.0.0` |
| `PORT` | No | Defaults to `3000` |

## Deploy with Coolify

1. Create a new resource from this public Git repository.
2. Choose Dockerfile deployment.
3. Set the service domain and enable HTTPS.
4. Add the three required environment variables in Coolify; never add secrets to GitHub.
5. Deploy, then check `https://YOUR-MCP-DOMAIN/healthz`.
6. For a no-auth connectivity test, configure ChatGPT with `https://YOUR-MCP-DOMAIN/mcp`; it should expose only `bridge_ping`.
7. Directus data tools are on `https://YOUR-MCP-DOMAIN/secure-mcp` and require bearer authentication. If ChatGPT does not support bearer-token authentication in its UI, do not expose those tools without authentication.

## Important transport note

This bridge uses the MCP SDK Streamable HTTP transport. It has not yet been tested against the user's ChatGPT account or Coolify deployment. Treat it as a starter implementation, not a verified production service. Before production use, run a dependency/security review and end-to-end MCP handshake test, and consider adding session limits, rate limits, structured audit logging, and OAuth if required by the client.
