/**
 * Architecture gate: every plugin content handler must enforce both the
 * permission grant AND the manifest's `contentAccess[]` allowlist.
 *
 * The shape we lock:
 *   - Every `handleContent*` function calls `assertHostPluginPermission` so
 *     the kernel-of-correctness permission check fires before any repo call.
 *   - Every per-table handler (anything that takes a `tableSlug` arg) also
 *     calls `assertContentTableAccess` for the targeted slug + mode.
 *
 * The matrix of (permission, mode) per handler is documented in the
 * handler header comment; this test enforces only the presence of the two
 * helper calls — finer-grained mode coverage is checked by the per-handler
 * unit tests.
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

/**
 * Extract every `export async function handleContent*` body from the
 * handler module. Returns `[name, bodyText]` pairs. Crude but adequate
 * for an architecture gate — the file is tightly structured and a
 * future refactor that splits one big switch into per-file handlers
 * would still surface the function-per-RPC pattern.
 */
function extractContentHandlers(source: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = []
  const re = /export async function (handleContent\w+)\([^)]*\)[^{]*\{([\s\S]*?)^\}/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    out.push({ name: m[1], body: m[2] })
  }
  return out
}

describe('plugin content handlers — access enforced', () => {
  it('every handleContent* function calls assertHostPluginPermission', async () => {
    const source = await read('server/plugins/host/handlers/content.ts')
    const handlers = extractContentHandlers(source)
    expect(handlers.length).toBeGreaterThan(15) // 20 RPCs, sanity
    for (const { name, body } of handlers) {
      expect(
        body.includes('assertHostPluginPermission('),
        `Handler "${name}" must call assertHostPluginPermission`,
      ).toBe(true)
    }
  })

  it('every per-table handler also calls assertContentTableAccess', async () => {
    const source = await read('server/plugins/host/handlers/content.ts')
    const handlers = extractContentHandlers(source)

    // Per-table handlers are everything whose first argv unpacks a
    // tableSlug or operates on entries / tree of a specific table.
    // Cross-table handlers (List on tables, search, republishAll) are
    // intentionally allowlisted — their authorization model differs.
    const crossTableAllowlist = new Set([
      'handleContentTablesList',     // intersects with allowlist itself
      'handleContentTablesCreate',   // gated by cms.content.tables.manage
      'handleContentRepublishAll',   // operates on all published pages
      'handleContentSearch',         // intersects with allowlist itself
      'handleContentSnapshot',       // looks up table from rowId, then asserts
      'handleContentTreeRead',       // looks up table from rowId, then asserts
      'handleContentTreeMutate',     // looks up table from rowId, then asserts
      'handleContentTreeReplace',    // looks up table from rowId, then asserts
    ])

    for (const { name, body } of handlers) {
      if (crossTableAllowlist.has(name)) continue
      expect(
        body.includes('assertContentTableAccess('),
        `Per-table handler "${name}" must call assertContentTableAccess`,
      ).toBe(true)
    }
  })
})
