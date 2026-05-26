/**
 * Architecture gate: every publish/unpublish entry point in
 * `server/repositories/` calls `bumpPublishVersion()` and imports it from
 * the render cache module.
 *
 * Covered files:
 *   - server/repositories/publish.ts            (publishDraftSite)
 *   - server/repositories/data/publish.ts       (publishDataRow)
 *   - server/repositories/data/rows.ts          (updateDataRowStatus — unpublish)
 *
 * A simple text scan is sufficient — no AST parsing needed. The check matches
 * the pattern used by other architecture tests in this directory.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../../..')

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf-8')
}

/**
 * The relative import path from `file` to the renderCache module.
 * Asserted so that moving the cache module would break this gate.
 */
const EXPECTED_IMPORT_PATHS: Record<string, string> = {
  'server/repositories/publish.ts': "'../publish/renderCache'",
  'server/repositories/data/publish.ts': "'../../publish/renderCache'",
  'server/repositories/data/rows.ts': "'../../publish/renderCache'",
}

const FILES_UNDER_TEST = Object.keys(EXPECTED_IMPORT_PATHS)

describe('publish-bumps-cache-version', () => {
  for (const file of FILES_UNDER_TEST) {
    it(`${file} calls bumpPublishVersion()`, () => {
      const src = read(file)
      expect(src).toContain('bumpPublishVersion()')
    })

    it(`${file} imports bumpPublishVersion from the render cache module`, () => {
      const src = read(file)
      const expectedPath = EXPECTED_IMPORT_PATHS[file]
      // The import must name renderCache as the source and include bumpPublishVersion.
      const hasImport =
        src.includes(`from ${expectedPath}`) &&
        src.includes('bumpPublishVersion')
      expect(hasImport).toBe(true)
    })
  }
})
