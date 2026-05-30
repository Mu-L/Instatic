import { describe, expect, it } from 'bun:test'
import type { SiteShell } from '@core/page-tree'
import { SiteValidationError } from '@core/persistence/validate'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import type { DbResult } from '../../../server/db'
import {
  loadDraftSite,
  saveDraftSite,
} from '../../../server/repositories/site'
import { createFakeDb } from './dbTestFake'

function createSiteFakeDb() {
  const state = {
    site: null as Record<string, unknown> | null,
  }

  const db = createFakeDb(async (rawSql, params): Promise<DbResult> => {
    const sql = rawSql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (sql.startsWith('insert into site')) {
      state.site = {
        id: 'default',
        name: params[0],
        settings_json: params[1],
        created_at: new Date('2026-01-01').toISOString(),
        updated_at: new Date('2026-01-02').toISOString(),
      }
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('select id, name, settings_json')) {
      return {
        rows: state.site ? [state.site] : [],
        rowCount: state.site ? 1 : 0,
      }
    }
    throw new Error(`Unhandled SQL: ${rawSql}`)
  })

  return { state, db }
}

function validShell(overrides: Partial<SiteShell> = {}): SiteShell {
  return {
    id: 'project_1',
    name: 'Example Site',
    files: [],
    visualComponents: [],
    packageJson: {
      dependencies: {},
      devDependencies: {},
    },
    runtime: normalizeSiteRuntimeConfig(undefined),
    breakpoints: [
      { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
    ],
    settings: {
      metaTitle: 'Example',
      shortcuts: {},
    },
    styleRules: {
      class_1: {
        id: 'class_1',
        name: 'Hero',
        styles: { color: 'red' },
        breakpointStyles: {},
        createdAt: 1,
        updatedAt: 2,
      },
    },
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  }
}

describe('CMS draft site persistence', () => {
  it('saves the site shell and loads it back', async () => {
    const { state, db } = createSiteFakeDb()
    await saveDraftSite(db, validShell(), 'user_1')

    expect(state.site).toMatchObject({ name: 'Example Site' })
    expect(state.site?.settings_json).toMatchObject({
      cmsSiteSchemaVersion: 1,
      site: {
        id: 'project_1',
        settings: { metaTitle: 'Example' },
        styleRules: { class_1: { name: 'Hero' } },
      },
    })
  })

  it('loads a saved draft site without reading pages (shell-only)', async () => {
    const { db } = createSiteFakeDb()
    await saveDraftSite(db, validShell(), 'user_1')

    const loaded = await loadDraftSite(db)

    expect(loaded).toMatchObject({
      id: 'project_1',
      name: 'Example Site',
      settings: { metaTitle: 'Example' },
      styleRules: { class_1: { name: 'Hero' } },
    })
    // Shell does not include pages — pages live in data_rows
    expect((loaded as Record<string, unknown> | null)?.pages).toBeUndefined()
  })

  it('validates the stored shell and throws SiteValidationError on corrupt data', async () => {
    const { state, db } = createSiteFakeDb()
    await saveDraftSite(db, validShell(), 'user_1')

    // Corrupt a breakpoint: inject an invalid width type.
    // readStoredShell passes arrays through as-is, so this reaches validateSite
    // intact. parseSiteDocument then rejects it and throws SiteValidationError.
    const payload = state.site?.settings_json as Record<string, unknown>
    const site = payload.site as Record<string, unknown>
    site.breakpoints = [{ id: 'desktop', label: 'Desktop', width: 'not-a-number', icon: 'monitor' }]

    await expect(loadDraftSite(db)).rejects.toThrow(SiteValidationError)
  })

  it('round-trips site runtime settings in the site shell', async () => {
    const { db } = createSiteFakeDb()
    await saveDraftSite(db, validShell({
      runtime: normalizeSiteRuntimeConfig({
        scripts: {
          script_1: {
            placement: 'head',
            priority: 10,
          },
        },
      }),
    }))

    const loaded = await loadDraftSite(db)

    expect(loaded?.runtime?.scripts.script_1).toMatchObject({
      placement: 'head',
      priority: 10,
    })
  })
})
