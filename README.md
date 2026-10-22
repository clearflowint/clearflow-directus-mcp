# ClearFlow Directus MCP Bridge

A remote, Streamable HTTP MCP bridge between ChatGPT-compatible MCP clients and a Directus REST API.

## Endpoints and tools

### Public `/mcp`

Intentionally limited to harmless connection checks:
- `bridge_ping` — confirms MCP transport connectivity only.
- `directus_status` — checks whether the configured Directus token is accepted and returns only a boolean.

This endpoint does not expose records or administrative operations.

### Protected `/secure-mcp`

Requires `Authorization: Bearer <MCP_BEARER_TOKEN>`. Exposes:
- `directus_ping`
- `list_collections`
- `list_fields`
- `read_items`
- `directus_request` — authenticated Directus REST requests using `GET`, `POST`, `PATCH`, `PUT`, or `DELETE`, across Directus API endpoints. This includes data and administrative endpoints such as roles, permissions, users, collections, and fields, subject to the configured Directus token's permissions.

**Warning:** `directus_request` is a privileged administrative tool. It can change access controls, modify records and schema, and permanently delete data. Use it only for operations explicitly authorized by the owner. Verify the method, endpoint, target IDs, and payload before each write. Keep it on `/secure-mcp`; never expose it on public `/mcp`.

## Security requirements

- Keep `DIRECTUS_TOKEN` and `MCP_BEARER_TOKEN` in Coolify environment variables only. Never commit credentials or paste them into chat.
- Use a dedicated Directus service account for the bridge, not a personal administrator token.
- If full role/schema administration is required, grant that dedicated account the minimum Directus administrative access that supports the required tasks. A read-only token cannot perform writes.
- Choose a long, random `MCP_BEARER_TOKEN`; configure the MCP client to send it as an Authorization Bearer token.
- Expose the service over HTTPS in Coolify.
- Do not move data/admin tools onto the public endpoint or remove bearer authentication from `/secure-mcp`.
- Review Directus audit logs and restrict access to the MCP endpoint to trusted clients.
- This tool uses the Directus permissions associated with `DIRECTUS_TOKEN`; it does not bypass Directus authorization.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DIRECTUS_URL` | Yes | Directus base URL, e.g. `https://clearflow-data.duckdns.org` |
| `DIRECTUS_TOKEN` | Yes | API token for the dedicated Directus service account |
| `MCP_BEARER_TOKEN` | Yes | Long random secret required by `/secure-mcp` |
| `HOST` | No | Defaults to `0.0.0.0` |
| `PORT` | No | Defaults to `3000` |

## Deploy with Coolify

1. Create or update the resource from this Git repository.
2. Choose Dockerfile deployment.
3. Configure the HTTPS service domain.
4. Add the environment variables in Coolify; never add secrets to Git.
5. Deploy and check `https://YOUR-MCP-DOMAIN/healthz`.
6. Configure the public test endpoint at `https://YOUR-MCP-DOMAIN/mcp` if only testing transport.
7. Configure the protected endpoint at `https://YOUR-MCP-DOMAIN/secure-mcp` with bearer authentication to access Directus tools.
8. Verify the protected MCP handshake and call `directus_ping` before attempting any write.
9. Test a harmless read, then a narrowly scoped authorized write. Do not test with destructive requests against production data.

## Implementation status

The bridge uses the MCP SDK Streamable HTTP transport. The protected `directus_request` tool enables broad Directus API access only to an authenticated MCP caller and only within the configured token's Directus permissions. The repository change itself does not configure Coolify, create a Directus service account, or prove that the deployed endpoint is connected. Perform an end-to-end handshake and permission test after deployment.
