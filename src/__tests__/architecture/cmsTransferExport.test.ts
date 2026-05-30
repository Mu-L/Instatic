/**
 * Architecture Gate — Site-transfer export filters
 *
 * Verifies that `handleExportRoute` correctly applies the `tables`, `rowIds`,
 * `includeMedia`, and `includeSite` filter options for both GET (query string)
 * and POST (JSON body) requests.
 *
 * Uses a real in-memory SQLite database with all migrations applied. Auth is
 * seeded directly via repositories (no HTTP round-trip to /setup).
 *
 * @see server/handlers/cms/export.ts
 * @see src/core/data/bundleSchema.ts
 * @see docs/plans/2026-05-19-site-transfer-ux.md
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { createSqliteClient } from '../../../server/db/sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { saveDraftSite } from '../../../server/repositories/site'
import { createUser } from '../../../server/repositories/users'
import { createSession } from '../../../server/auth/sessions'
import {
  createSessionToken,
  hashSessionToken,
  SESSION_COOKIE_NAME,
  sessionExpiry,
} from '../../../server/auth/tokens'
import { createDataTable } from '../../../server/repositories/data/tables'
import { createDataRow } from '../../../server/repositories/data/rows'
import { handleExportRoute } from '../../../server/handlers/cms/export'
import { parseValue } from '@core/utils/typeboxHelpers'
import { SiteBundleSchema } from '@core/data/bundleSchema'
import type { DbClient } from '../../../server/db/client'
import type { SiteShell } from '@core/page-tree'

// ---------------------------------------------------------------------------
// Minimal valid site shell for seeding
// ---------------------------------------------------------------------------

const TEST_SHELL: SiteShell = {
  id: 'default',
  name: 'Transfer Test Site',
  breakpoints: [],
  settings: { shortcuts: {} },
  styleRules: {},
  files: [],
  packageJson: { dependencies: {}, devDependencies: {} },
  runtime: {
    dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
    scripts: {},
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

// ---------------------------------------------------------------------------
// seedAuth — seeds site + owner user + session; returns the cookie string
// ---------------------------------------------------------------------------

async function seedAuth(db: DbClient): Promise<string> {
  await saveDraftSite(db, TEST_SHELL)
  await createUser(db, {
    id: 'test-owner',
    email: 'owner@export.test',
    displayName: 'Test Owner',
    passwordHash: 'placeholder-hash',
    roleId: 'owner',
    allowOwnerRole: true,
  })
  const token = createSessionToken()
  await createSession(db, {
    idHash: await hashSessionToken(token),
    userId: 'test-owner',
    expiresAt: sessionExpiry(),
    ipAddress: null,
    userAgent: null,
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGetRequest(path: string, cookie: string): Request {
  const req = new Request(`http://localhost${path}`, { method: 'GET' })
  // The `cookie` header is a forbidden header per WHATWG Fetch spec and is
  // stripped by Bun's Request constructor. Set it after construction instead.
  req.headers.set('cookie', cookie)
  return req
}

function makePostRequest(path: string, cookie: string, body: unknown): Request {
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  req.headers.set('cookie', cookie)
  return req
}

// ---------------------------------------------------------------------------
// Shared state set up in beforeAll
// ---------------------------------------------------------------------------

let db: DbClient
let cookie: string
let post1Id: string
let post2Id: string
let pageId: string
let customRowId: string
const CUSTOM_TABLE_ID = 'my-data-test'

beforeAll(async () => {
  db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  cookie = await seedAuth(db)

  // Create 1 custom table ("My Data")
  await createDataTable(db, {
    id: CUSTOM_TABLE_ID,
    name: 'My Data',
    slug: 'my-data-test',
    kind: 'data',
    singularLabel: 'My Item',
    pluralLabel: 'My Data',
  })

  // Seed 2 rows in posts
  const p1 = await createDataRow(db, {
    tableId: 'posts',
    cells: { title: 'Post One', slug: 'post-one' },
    slug: 'post-one',
  })
  const p2 = await createDataRow(db, {
    tableId: 'posts',
    cells: { title: 'Post Two', slug: 'post-two' },
    slug: 'post-two',
  })
  post1Id = p1.id
  post2Id = p2.id

  // Seed 1 row in pages
  const pg = await createDataRow(db, {
    tableId: 'pages',
    cells: { title: 'Home Page', slug: 'home', body: { nodes: {}, rootNodeId: 'root' } },
    slug: 'home',
  })
  pageId = pg.id

  // Seed 1 row in My Data
  const cr = await createDataRow(db, {
    tableId: CUSTOM_TABLE_ID,
    cells: { name: 'Custom Item One' },
    slug: '',
  })
  customRowId = cr.id
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleExportRoute — GET no filters', () => {
  test('returns all 4 rows across all tables', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)

    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.rows.length).toBe(4)
  })

  test('includes all tables (system + custom)', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    const tableIds = bundle.tables.map((t) => t.id)
    expect(tableIds).toContain('posts')
    expect(tableIds).toContain('pages')
    expect(tableIds).toContain('components')
    expect(tableIds).toContain(CUSTOM_TABLE_ID)
  })

  test('site shell is present by default', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.site).toBeDefined()
    expect(bundle.site!.name).toBe('Transfer Test Site')
  })

  test('sourceSiteName is set from the site shell name', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.sourceSiteName).toBe('Transfer Test Site')
  })

  test('media is absent (not requested)', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.media).toBeUndefined()
  })
})

describe('handleExportRoute — GET ?tables=posts', () => {
  test('returns only the posts table', async () => {
    const req = makeGetRequest('/admin/api/cms/export?tables=posts', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.tables.length).toBe(1)
    expect(bundle.tables[0].id).toBe('posts')
  })

  test('returns only the 2 posts rows', async () => {
    const req = makeGetRequest('/admin/api/cms/export?tables=posts', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.rows.length).toBe(2)
    expect(bundle.rows.every((r) => r.tableId === 'posts')).toBe(true)
  })

  test('site is still present when only tables are filtered', async () => {
    const req = makeGetRequest('/admin/api/cms/export?tables=posts', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.site).toBeDefined()
  })
})

describe('handleExportRoute — GET ?rowIds=<id1>,<id2>', () => {
  test('returns only the 2 specified rows', async () => {
    const req = makeGetRequest(
      `/admin/api/cms/export?rowIds=${post1Id},${post2Id}`,
      cookie,
    )
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    const returnedIds = bundle.rows.map((r) => r.id)
    expect(returnedIds).toContain(post1Id)
    expect(returnedIds).toContain(post2Id)
    expect(returnedIds).not.toContain(pageId)
    expect(returnedIds).not.toContain(customRowId)
    expect(bundle.rows.length).toBe(2)
  })

  test('tables are reconciled to only the rows\' parent tables', async () => {
    const req = makeGetRequest(
      `/admin/api/cms/export?rowIds=${post1Id},${post2Id}`,
      cookie,
    )
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    const tableIds = bundle.tables.map((t) => t.id)
    expect(tableIds).toContain('posts')
    expect(tableIds).not.toContain('pages')
    expect(tableIds).not.toContain(CUSTOM_TABLE_ID)
  })
})

describe('handleExportRoute — GET ?includeMedia=1', () => {
  test('media array is present (empty when no assets seeded and uploadsDir set)', async () => {
    const req = makeGetRequest('/admin/api/cms/export?includeMedia=1', cookie)
    // Pass a temp uploads dir so the handler enters the media-loading branch
    const res = await handleExportRoute(req, db, { uploadsDir: '/tmp/test-uploads-export' })
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    // No assets seeded → empty array, but the field must be present
    expect(Array.isArray(bundle.media)).toBe(true)
    expect(bundle.media!.length).toBe(0)
  })
})

describe('handleExportRoute — GET ?includeSite=0', () => {
  test('site shell is absent', async () => {
    const req = makeGetRequest('/admin/api/cms/export?includeSite=0', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.site).toBeUndefined()
  })

  test('sourceSiteName is still set even when includeSite=0', async () => {
    const req = makeGetRequest('/admin/api/cms/export?includeSite=0', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.sourceSiteName).toBe('Transfer Test Site')
  })
})

describe('handleExportRoute — POST { tables: ["pages"], includeSite: false }', () => {
  test('returns only the pages table', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: ['pages'],
      includeSite: false,
    })
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.tables.length).toBe(1)
    expect(bundle.tables[0].id).toBe('pages')
  })

  test('returns only the 1 pages row', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: ['pages'],
      includeSite: false,
    })
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.rows.length).toBe(1)
    expect(bundle.rows[0].tableId).toBe('pages')
    expect(bundle.rows[0].id).toBe(pageId)
  })

  test('site is absent when includeSite: false', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: ['pages'],
      includeSite: false,
    })
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.site).toBeUndefined()
  })
})

describe('handleExportRoute — POST { rowIds: [bogusId] }', () => {
  test('returns empty rows when bogus rowId does not match any row', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      rowIds: ['completely-bogus-row-id-that-does-not-exist'],
    })
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.rows.length).toBe(0)
  })

  test('returns empty tables when no rows matched (no orphan table entries)', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      rowIds: ['completely-bogus-row-id-that-does-not-exist'],
    })
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.tables.length).toBe(0)
  })
})

describe('handleExportRoute — auth', () => {
  test('returns 401 when no session cookie', async () => {
    // Deliberately no cookie set
    const req = new Request('http://localhost/admin/api/cms/export', { method: 'GET' })
    const res = await handleExportRoute(req, db)
    expect(res!.status).toBe(401)
  })
})
