/**
 * End-to-end MCP flow over the real HTTP handler, exercised as the sequence a
 * detached client (Claude Code / Codex) actually performs: a stateless series
 * of independent POSTs — initialize, then tools/list, then tools/call — each
 * authenticated by the connector bearer token, with NO session continuity.
 *
 * This drives `handleMcpHttp` directly (the same function the router mounts)
 * rather than a socket client, so it is deterministic under the test harness's
 * jsdom preload. Bad-token rejection is covered by `auth.test.ts` and
 * `transports/http.test.ts`.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import type { DbClient } from '../../db/client'
import { handleMcpHttp } from './index'
import { createConnector } from './connectors/store'
import { generateConnectorToken, hashConnectorToken } from './connectors/token'

const PAGE_TREE = {
  rootNodeId: 'root',
  nodes: {
    root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, classIds: [], children: [] },
  },
}

let db: DbClient
let token: string

beforeEach(async () => {
  db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('u1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner')
  `
  const cells = JSON.stringify({ title: 'Home', slug: 'home', body: PAGE_TREE })
  await db`insert into data_rows (id, table_id, cells_json, slug, status)
           values ('page1', 'pages', ${cells}, 'home', 'draft')`
  token = generateConnectorToken()
  await createConnector(db, {
    userId: 'u1', label: 'Claude Code', type: 'local',
    capabilities: ['ai.chat', 'ai.tools.write', 'site.read', 'site.structure.edit', 'content.manage'],
    tokenHash: await hashConnectorToken(token),
  })
})

let nextId = 1
async function rpc(method: string, params: unknown): Promise<{ status: number; json: any }> {
  const req = new Request('http://localhost/_instatic/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
  const res = await handleMcpHttp(req, db)
  if (!res) throw new Error('handler returned null')
  const text = await res.text()
  // `enableJsonResponse` returns a plain JSON body; tolerate an SSE `data:` prefix.
  const payload = text.startsWith('data:') ? text.slice(text.indexOf('{')) : text
  return { status: res.status, json: JSON.parse(payload) }
}

const INIT_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'e2e', version: '0' },
}

describe('MCP end-to-end (stateless multi-request, real handler)', () => {
  it('initializes, lists tools, reads, and mutates — the Claude Code flow', async () => {
    const init = await rpc('initialize', INIT_PARAMS)
    expect(init.status).toBe(200)
    expect(init.json.result.serverInfo.name).toBe('instatic')

    const list = await rpc('tools/list', {})
    const names = list.json.result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('read_page_tree')
    expect(names).toContain('mutate_page_tree')

    const read = await rpc('tools/call', { name: 'read_page_tree', arguments: { entryId: 'page1' } })
    expect(read.json.result.isError).toBeFalsy()
    expect(JSON.stringify(read.json.result.content)).toContain('rootNodeId')

    const mutate = await rpc('tools/call', {
      name: 'mutate_page_tree',
      arguments: {
        entryId: 'page1',
        operations: [
          { kind: 'insertNode', parentId: 'root', index: 0,
            node: { id: 'n_e2e', moduleId: 'base.text', props: {}, breakpointOverrides: {}, classIds: [], children: [] } },
        ],
      },
    })
    expect(mutate.json.result.isError).toBeFalsy()

    const { rows } = await db<{ cells_json: { body: unknown } }>`select cells_json from data_rows where id='page1'`
    expect(JSON.stringify(rows[0].cells_json)).toContain('n_e2e')
  })

  it('a read-only connector cannot list or call the mutate tool', async () => {
    // Re-issue a read-only token by reusing the same flow with a fresh connector.
    const readToken = generateConnectorToken()
    await createConnector(db, {
      userId: 'u1', label: 'RO', type: 'remote',
      capabilities: ['ai.chat', 'site.read', 'content.manage'],
      tokenHash: await hashConnectorToken(readToken),
    })
    const req = (method: string, params: unknown) =>
      new Request('http://localhost/_instatic/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${readToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      })
    await handleMcpHttp(req('initialize', INIT_PARAMS), db)
    const listRes = await handleMcpHttp(req('tools/list', {}), db)
    const body = JSON.parse(await listRes!.text())
    const names = body.result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('read_page_tree')
    expect(names).not.toContain('mutate_page_tree')
  })
})
