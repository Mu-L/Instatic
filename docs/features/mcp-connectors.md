# MCP Connectors

MCP connectors let **external AI clients drive this Instatic instance** over the [Model Context Protocol](https://modelcontextprotocol.io). Instatic acts as an **MCP server**: a local client (Claude Code, Codex, Cursor) or a remote agent connects, lists the available tools, and operates the CMS — reading the site, editing page structure, and managing content — exactly the way the built-in AI panel does.

This is the mirror image of the **Providers** tab (`server/ai/credentials/`), which points Instatic's *own* agent outward at LLM providers. MCP connectors point inward: they let outside agents reach in.

The server is implemented with the official `@modelcontextprotocol/sdk`. That package is banned everywhere else in the tree (the AI drivers hand-roll provider REST); it is allowed **only under `server/ai/mcp/`**, scoped by `ai-driver-isolation.test.ts`.

---

## TL;DR

- **Instatic is an MCP server.** One Streamable-HTTP endpoint at `/_instatic/mcp` serves both local and remote clients (local is just `localhost`).
- **Thin adapter over the existing tool engine.** No tool logic is duplicated. MCP is a new *caller* alongside the built-in agent and the plugin host; tool dispatch reuses `executeAiTool`.
- **Tool surface = the full catalog.** Server-resolved tools (content reads, `read_page_tree`, `mutate_page_tree`) run headless — no editor needed. Every browser-execution tool the agent panel has (insert HTML, apply CSS, assign classes, set design tokens, manage pages, content CRUD, code assets, live-DOM reads) is exposed too, **relayed to an open editor via the live editor bridge**. If the connector owner has no editor open, those tools return a clear "open the editor" error; the headless tools still work.
- **Bearer-token auth, one secret per connector.** The token is shown once on creation and stored only as a SHA-256 hash. Revocable.
- **Capability-gated.** A connector carries a granted capability subset; the same gate the built-in agent uses (`toolAllowedForCapabilities`) filters the toolset. An MCP caller can never invoke a tool the granting capabilities couldn't authorize over HTTP.
- **Privilege floor.** An admin can only grant capabilities they themselves hold.
- **Managed from the admin UI:** AI workspace → **MCP** tab.

---

## Architecture

```
MCP client (Claude Code / Codex / remote agent)
        │  JSON-RPC over Streamable HTTP
        ▼
server/router.ts  →  /_instatic/mcp   (tryServeMcp)
        │
server/ai/mcp/transports/http.ts      WebStandardStreamableHTTPServerTransport (Web Request/Response)
        │
server/ai/mcp/auth.ts                 Bearer token → connector → capability set (401 + WWW-Authenticate otherwise)
        │
server/ai/mcp/server.ts               low-level SDK Server; tools filtered by capabilities
        │
server/ai/mcp/registry.ts             AiTool registry → MCP tools (TypeBox inputSchema sent verbatim as JSON Schema)
        │
executeAiTool(...) / treeService      in-process, ctx { db, userId, capabilities }
        ▼
repositories (data_rows, media) + applyTreeOperation + saveDataRowDraft
```

### Module layout — `server/ai/mcp/`

| File | Responsibility |
|---|---|
| `transports/http.ts` | Mounts the SDK's Web-standard Streamable-HTTP transport; stateless per request (`enableJsonResponse`). |
| `auth.ts` | Bearer resolution → `{ connectorId, userId, capabilities }`; spec-correct 401 with an RFC 9728 `resource_metadata` pointer. |
| `server.ts` | Builds a capability-scoped low-level `Server` (`ListTools` / `CallTool` handlers). Uses the low-level `Server`, not `McpServer.registerTool`, because the latter needs Zod (banned) — this lets the TypeBox `inputSchema` pass through verbatim. |
| `registry.ts` | The exposable toolset = full catalog (content + site + page-tree), deduped by name, filtered by `toolAllowedForCapabilities`. |
| `tools/pageTreeTools.ts` | `read_page_tree` / `mutate_page_tree`, backed by the shared `treeService`. |
| `editorBridge.ts` | Per-user live editor bridge registry + `createEditorBridgeStream`; `getEditorBridgeForUser` routes browser tools to the owner's open editor. |
| `handlers/editorBridge.ts` | `GET /admin/api/ai/editor-bridge` — the NDJSON stream the editor holds open. |
| `connectors/` | `types.ts` (server-only record), `token.ts` (generate + SHA-256 hash), `store.ts` (CRUD + `toConnectorView`). |
| `handlers/connectors.ts` | `/admin/api/ai/mcp/connectors` CRUD, gated by `ai.providers.manage`. |

The headless page-tree path (load → `applyTreeOperation` → persist) lives in `server/ai/content/treeService.ts` and is shared with the plugin RPC `cms.content.tree.mutate` — neither caller duplicates the engine. Gated by `plugin-content-tree-via-engine.test.ts`.

---

## Tool surface

MCP exposes the **full tool catalog** (deduped by name), capability-filtered. Tools fall in two execution classes:

**Headless (server-resolved) — work with no editor open:**
- Content reads — list/read collections, entries, data rows, media.
- `read_styles({ className?, includeTokens? })` — the design system as a **CSS stylesheet**: design tokens (CSS custom properties) + every class/ambient rule, read straight from the DB via the publisher's emitters. Symmetric with reading pages as HTML / writing CSS via `applyCss`. Replaces the old snapshot-dependent `list_tokens` (which returned nothing over MCP).
- `read_page_tree({ entryId, fieldId? })` — the full `NodeTree` (structure as JSON), by entry id.
- `mutate_page_tree({ entryId, fieldId?, operations[] })` — the 11 canonical tree operations (insert / delete / move / duplicate / wrap / rename / updateProps / setBreakpointOverride / clearBreakpointOverride / toggleNodeLocked / toggleNodeHidden) via `applyTreeOperation`, persisted as a draft. `fieldId` defaults to `body`.

**Browser-relayed (via the live editor bridge) — require an open editor:**
- HTML/CSS authoring (`insertHtml`, `replaceNodeHtml`, `applyCss`, `assignClass`, `removeClass`), node ops, page lifecycle (`addPage`, …), design tokens (`set_color_tokens`, …), content CRUD (`create_document`, `set_document_field`, …), code assets, and live-DOM reads (`render_snapshot`, `getNodeHtml`).
- These have no server implementation — their logic runs in the editor app. The MCP server relays the call to the connector owner's open editor and awaits the result (see "Live editor bridge"). No editor connected → a clear error asking the operator to open it.

## Live editor bridge

`server/ai/mcp/editorBridge.ts` keeps one bridge per user (newest open editor wins), keyed by `userId` so a connector can only reach **its own owner's** editor.

```
MCP browser-tool call            Editor (open in a browser)
   │ executeAiTool(browser)         │ useEditorMcpBridge() holds the stream open
   ▼                                ▼
buildMcpServer → getEditorBridgeForUser(userId)
   │ bridge.callBrowser(tool, input) → emits toolRequest ─────────────▶ executeAgentTool(tool, input)
   │                                                                        │ (live store)
   ◀───────────── POST /admin/api/ai/tool-result ◀── postToolResult ◀───────┘
```

- Editor side: `useEditorMcpBridge` (mounted in `SitePage`) opens `GET /admin/api/ai/editor-bridge` (NDJSON, admin-session auth), runs each `toolRequest` through the SAME `executeAgentTool` the agent panel uses, and POSTs the result back. Reconnects with backoff. After a tool that leaves unsaved changes, it **flushes the draft save** (`flushEditorSave`) so a follow-up headless read (`read_page_tree` / `read_styles` / content reads) sees the change immediately instead of waiting for the 30 s autosave.
- Server side: reuses the chat bridge machinery wholesale — `createBridge` issues the `AiBrowserBridge`, `resolveBridgeToolResult` settles it from the existing `/admin/api/ai/tool-result` endpoint.

This is why an open editor (yours, or one the agent opens) unlocks the full editing surface without reimplementing any tool.

---

## Authentication

**Phase 1 — bearer token (current).** Each connector has a long-lived secret (`imcp_…`). The client sends `Authorization: Bearer <token>`. The server hashes the presented token and looks up a non-revoked connector, yielding its capability set. Missing/invalid tokens get a `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.

Works today with Claude Code, Cursor, Claude.ai custom connectors, and custom remote agents.

**Phase 2 — OAuth 2.1 (designed, not built).** ChatGPT and Gemini's *managed* connector UIs refuse static API keys and require an OAuth 2.1 flow conforming to the MCP authorization spec (RFC 9728 Protected Resource Metadata). The `auth_mode` column and the 401's `resource_metadata` pointer are already in place so this layers in without a migration rewrite.

---

## Connecting a client

Create a connector in **AI → MCP**, choose its type and capabilities, then copy the token (shown once).

**Local (Claude Code / Codex / Cursor):**

```sh
claude mcp add instatic --transport http http://localhost:3000/_instatic/mcp \
  --header "Authorization: Bearer imcp_…"
```

**Remote:** point the client at `https://<your-host>/_instatic/mcp` and send the token as an `Authorization: Bearer` header.

---

## Data model

`ai_mcp_connectors` (migration `018`, PG + SQLite parity):

| column | notes |
|---|---|
| `id`, `user_id`, `label` | owner + display name |
| `type` | `local` \| `remote` |
| `auth_mode` | `bearer` now; `oauth` reserved for phase 2 |
| `token_hash` | SHA-256 of the secret; never the plaintext. Unique. |
| `capabilities_json` | granted capability subset |
| `created_at`, `last_used_at`, `revoked_at` | lifecycle; revoked tokens fail auth |

The wire-safe `McpConnectorView` (the only HTTP-returned shape) never includes the hash — gated by `ai-mcp-connectors-never-leak.test.ts`. Create and revoke are audited (`ai.mcp_connector.created` / `ai.mcp_connector.revoked`).

---

## Capabilities

Connector management is gated by `ai.providers.manage` (the AI-integrations admin surface). A connector's granted capabilities flow straight into the existing tool gate:

- mutating tools require `ai.tools.write`;
- page-tree edits require any of `site.structure.edit` / `site.content.edit` / `site.style.edit` / `pages.edit`;
- reads require any site/content read grant.

An admin cannot grant a capability they do not hold (enforced in `handlers/connectors.ts`).

---

## Tests

- `server/ai/mcp/connectors/{token,store}.test.ts` — token hashing + store CRUD.
- `server/ai/content/treeService.test.ts` — headless load/mutate/persist.
- `server/ai/mcp/{registry,auth,server,transports/http}.test.ts` — capability filtering, bearer auth + 401, full MCP round-trip (list/read/mutate), HTTP handshake.
- `src/__tests__/ai/mcpConnectorsHandler.test.ts` — CRUD, privilege floor, capability gating.
- `src/__tests__/architecture/ai-mcp-connectors-never-leak.test.ts` — token never serialized.
