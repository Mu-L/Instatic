/**
 * Integration tests for Layer B caching in publicRouter.ts.
 *
 * Verifies that `renderPublicResolution` correctly uses the render cache:
 *   - First request renders and caches.
 *   - Second identical request is served from cache (no re-render).
 *   - After `bumpPublishVersion()`, the next request re-renders.
 *   - Redirect resolutions are NOT cached.
 *   - Not-found resolutions are NOT cached.
 *
 * Uses `getStats()` from renderCache to observe hit/miss counts without
 * requiring module-level spying on the renderer.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/db'
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'
import { renderPublicResolution } from '../../../server/publish/publicRouter'
import {
  bumpPublishVersion,
  getStats,
  resetForTests,
} from '../../../server/publish/renderCache'

// ---------------------------------------------------------------------------
// Minimal snapshot fixture
// ---------------------------------------------------------------------------

function makeSnapshot(): PublishedPageSnapshot {
  return {
    cmsSnapshotVersion: 1,
    pageRowId: 'page_test',
    site: {
      id: 'site_1',
      name: 'Test Site',
      pages: [
        {
          id: 'page_test',
          title: 'Test Page',
          slug: 'test',
          rootNodeId: 'root',
          nodes: {
            root: {
              id: 'root',
              moduleId: 'base.body',
              props: {},
              breakpointOverrides: {},
              children: [],
            },
          },
        },
      ],
      files: [],
      visualComponents: [],
      breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
      settings: { metaTitle: 'Test Site', shortcuts: {} },
      styleRules: {},
      createdAt: 1000,
      updatedAt: 2000,
    },
  }
}

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

/**
 * Minimal DbClient that handles queries made by resolvePublicRoute,
 * renderPublishedSnapshot, and applyPublishedHtmlPipeline.
 *
 * When `snapshot` is provided, the slug lookup returns it.
 * Everything else returns empty results (no plugins, no media, etc.).
 */
function makeFakeDb(snapshot: PublishedPageSnapshot | null): DbClient {
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    // getPublishedPageBySlug — queries data_row_versions.snapshot_json
    if (normalized.includes('select data_row_versions.snapshot_json')) {
      return {
        rows: snapshot ? [{ snapshot_json: snapshot } as Row] : [],
        rowCount: snapshot ? 1 : 0,
      }
    }

    // Anything else (plugins, media, loop data, etc.) → empty
    return { rows: [], rowCount: 0 }
  }

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return handle as DbClient
}

/** Fake DB that returns a redirect for any slug lookup. */
function makeRedirectDb(): DbClient {
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    // getPublishedPageBySlug → not found
    if (normalized.includes('select data_row_versions.snapshot_json')) {
      return { rows: [], rowCount: 0 }
    }
    // getPublishedDataRowByRoute → not found (no content row)
    if (normalized.includes('from data_rows') && normalized.includes('join data_tables')) {
      return { rows: [], rowCount: 0 }
    }
    // getDataRowRedirectByRoute → return a redirect
    if (normalized.includes('from data_row_redirects')) {
      return {
        rows: [
          {
            id: 'redirect_1',
            from_route_base: '/posts',
            from_slug: 'old-post',
            target_route_base: '/posts',
            target_slug: 'new-post',
          } as unknown as Row,
        ],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  }
  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)
  return handle as DbClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetForTests()
})

describe('Layer B render cache integration', () => {
  it('first request is a miss; second identical request is a cache hit', async () => {
    const snap = makeSnapshot()
    const db = makeFakeDb(snap)
    const url = new URL('http://localhost/test')

    const res1 = await renderPublicResolution(db, url)
    expect(res1?.status).toBe(200)
    expect(getStats()).toMatchObject({ hits: 0, misses: 1, size: 1 })

    const res2 = await renderPublicResolution(db, url)
    expect(res2?.status).toBe(200)
    expect(getStats()).toMatchObject({ hits: 1, misses: 1, size: 1 })
  })

  it('responses from cache and from renderer have the same body', async () => {
    const snap = makeSnapshot()
    const db = makeFakeDb(snap)
    const url = new URL('http://localhost/test')

    const res1 = await renderPublicResolution(db, url)
    const body1 = await res1!.text()

    const res2 = await renderPublicResolution(db, url)
    const body2 = await res2!.text()

    expect(body1).toBe(body2)
    expect(body1).toContain('<!DOCTYPE html>')
  })

  it('bumpPublishVersion causes the next request to re-render', async () => {
    const snap = makeSnapshot()
    const db = makeFakeDb(snap)
    const url = new URL('http://localhost/test')

    await renderPublicResolution(db, url)
    expect(getStats()).toMatchObject({ hits: 0, misses: 1 })

    bumpPublishVersion()

    await renderPublicResolution(db, url)
    expect(getStats()).toMatchObject({ hits: 0, misses: 2 })
  })

  it('after re-render following a bump, the subsequent request is a hit', async () => {
    const snap = makeSnapshot()
    const db = makeFakeDb(snap)
    const url = new URL('http://localhost/test')

    await renderPublicResolution(db, url)
    bumpPublishVersion()
    await renderPublicResolution(db, url) // re-render after bump
    await renderPublicResolution(db, url) // should be a hit
    expect(getStats()).toMatchObject({ hits: 1, misses: 2 })
  })

  it('different URL paths are distinct cache entries', async () => {
    const snap = makeSnapshot()
    const db = makeFakeDb(snap)

    await renderPublicResolution(db, new URL('http://localhost/test'))
    await renderPublicResolution(db, new URL('http://localhost/other'))
    expect(getStats().size).toBe(2)
    expect(getStats().misses).toBe(2)
  })

  it('same path with different query strings are distinct entries', async () => {
    const snap = makeSnapshot()
    const db = makeFakeDb(snap)

    await renderPublicResolution(db, new URL('http://localhost/test?page=1'))
    await renderPublicResolution(db, new URL('http://localhost/test?page=2'))
    expect(getStats().size).toBe(2)
    expect(getStats().misses).toBe(2)
  })

  it('redirect resolutions are NOT cached', async () => {
    const db = makeRedirectDb()
    // Redirect URL: /posts/old-post → resolved by getDataRowRedirectByRoute
    const url = new URL('http://localhost/posts/old-post')

    const res1 = await renderPublicResolution(db, url)
    expect(res1?.status).toBe(301)
    // Cache should be untouched — redirects bypass getOrRender.
    expect(getStats()).toMatchObject({ hits: 0, misses: 0, size: 0 })

    const res2 = await renderPublicResolution(db, url)
    expect(res2?.status).toBe(301)
    expect(getStats()).toMatchObject({ hits: 0, misses: 0, size: 0 })
  })

  it('not-found resolutions are NOT cached', async () => {
    const db = makeFakeDb(null) // no snapshot → not-found
    const url = new URL('http://localhost/nowhere')

    const res1 = await renderPublicResolution(db, url)
    expect(res1).toBeNull()
    expect(getStats()).toMatchObject({ hits: 0, misses: 0, size: 0 })

    const res2 = await renderPublicResolution(db, url)
    expect(res2).toBeNull()
    expect(getStats()).toMatchObject({ hits: 0, misses: 0, size: 0 })
  })
})
