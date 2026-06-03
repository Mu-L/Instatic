/**
 * Unit tests for applyImport — the full import pipeline orchestrator.
 *
 * Covers:
 *   - buildImportPlan: shape-agnostic round-trip with the sample fixture
 *   - commitImportPlan: mock adapter records all operations
 *   - Conflict resolution branches (auto-rename, skip, overwrite)
 *   - "Unused CSS" detection
 *   - Atomicity: forced upload failure leaves no partial store state
 */

import { describe, it, expect } from 'bun:test'
// Self-registers all base modules with the global registry so importHtml works
import '@modules/base'
import {
  buildImportPlan,
  commitImportPlan,
  applyConflictResolutions,
} from '@core/siteImport'
import type {
  SiteImportAdapter,
  SiteImportTransaction,
  ImportPlan,
  NewStyleRule,
  PageConflict,
  RuleConflict,
} from '@core/siteImport'
import type { ImportFragment } from '@core/htmlImport'
import { makeSampleFileMap, makeEmptySiteDocument, makeMockSiteDocument } from './mockSite'
import { makeSinglePageFileMap } from './fixtures'
import type { FileMap } from '@core/siteImport'

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

interface MockTxOp {
  type:
    | 'addPage'
    | 'overwritePage'
    | 'addStyleRule'
    | 'overwriteStyleRule'
    | 'addFonts'
    | 'addFontTokens'
    | 'addConditions'
    | 'addColorTokens'
    | 'addScripts'
  args: unknown
  id: string
}

function makeMockAdapter(opts?: {
  uploadFail?: boolean
  commitFail?: boolean
}): SiteImportAdapter & { uploads: string[]; ops: MockTxOp[] } {
  let idCounter = 0
  const nextId = () => `mock-id-${++idCounter}`
  const uploads: string[] = []
  const ops: MockTxOp[] = []

  return {
    uploads,
    ops,
    async uploadAsset(file) {
      if (opts?.uploadFail) throw new Error('upload failure')
      uploads.push(file.path)
      return `/uploads/media/${file.path.replace(/[^a-z0-9.]/g, '_')}`
    },
    async commit(recipe) {
      if (opts?.commitFail) throw new Error('commit failure')
      const tx: SiteImportTransaction = {
        addPage(input) {
          const id = nextId()
          ops.push({ type: 'addPage', args: input, id })
          return id
        },
        overwritePage(pageId, input) {
          const id = pageId
          ops.push({ type: 'overwritePage', args: { pageId, ...input }, id })
        },
        addStyleRule(rule) {
          const id = nextId()
          ops.push({ type: 'addStyleRule', args: rule, id })
          return id
        },
        overwriteStyleRule(ruleId, rule) {
          ops.push({ type: 'overwriteStyleRule', args: { ruleId, rule }, id: ruleId })
        },
        addFonts(fonts) {
          ops.push({ type: 'addFonts', args: { fonts }, id: '' })
          return fonts.map((f) => ({ id: nextId(), family: f.family }))
        },
        addFontTokens(tokens) {
          ops.push({ type: 'addFontTokens', args: { tokens }, id: '' })
          return tokens.map((t) => ({ id: nextId(), name: t.name, variable: t.variable }))
        },
        addConditions(conditions) {
          ops.push({ type: 'addConditions', args: { conditions }, id: '' })
        },
        addColorTokens(colors) {
          ops.push({ type: 'addColorTokens', args: { colors }, id: '' })
          return colors.map((c) => ({ slug: c.slug, value: c.value }))
        },
        addScripts(scripts) {
          ops.push({ type: 'addScripts', args: { scripts }, id: '' })
          return scripts.map((s) => ({ id: nextId(), path: s.path }))
        },
      }
      recipe(tx)
    },
  }
}

// ---------------------------------------------------------------------------
// buildImportPlan — basic structure
// ---------------------------------------------------------------------------

describe('buildImportPlan — structure', () => {
  const fileMap = makeSampleFileMap()
  const currentSite = makeEmptySiteDocument()
  const plan = buildImportPlan({ fileMap, currentSite })

  it('produces one page per HTML file', () => {
    expect(plan.pages).toHaveLength(3)
  })

  it('produces style rules from linked CSS', () => {
    // main.css and theme.css should produce rules
    expect(plan.styleRules.length).toBeGreaterThan(0)
  })

  it('folds a body <style> block into the plan as a per-page CSS source', () => {
    const html = `<!doctype html><html><head>
      <style>.promo { color: rgb(255, 99, 71); } a:hover { text-decoration: underline; }</style>
    </head><body><div class="promo">Sale</div></body></html>`
    const p = buildImportPlan({
      fileMap: makeSinglePageFileMap(html),
      currentSite: makeEmptySiteDocument(),
    })
    // The <style>'s class rule appears in the plan with its declarations.
    const promo = p.styleRules.find((r) => r.kind === 'class' && r.name === 'promo')
    expect(promo).toBeDefined()
    expect(promo!.styles.color).toContain('255')
    // The ambient selector is registered too.
    expect(p.styleRules.some((r) => r.kind === 'ambient' && r.selector === 'a:hover')).toBe(true)
    // The page node still carries the class NAME (linked to an id at commit time).
    const fragment = p.pages[0].nodeFragment
    const divNode = Object.values(fragment.nodes).find((n) => n.moduleId === 'base.container')
    expect(divNode?.classIds).toContain('promo')
  })

  it('collects image assets', () => {
    const sourcePaths = plan.assets.map((a) => a.sourcePath)
    expect(sourcePaths).toContain('images/hero.png')
    expect(sourcePaths).toContain('images/logo.png')
  })

  it('plan.assets contains only media files — HTML pages are excluded even when linked via anchor', () => {
    // INDEX_HTML has <a href="about.html">About us</a>.  about.html must NOT
    // appear in plan.assets because it is an HTML page, not a media asset.
    const sourcePaths = plan.assets.map((a) => a.sourcePath)
    expect(sourcePaths).not.toContain('index.html')
    expect(sourcePaths).not.toContain('about.html')
    expect(sourcePaths).not.toContain('contact.html')
    // CSS files must also be excluded
    expect(sourcePaths).not.toContain('styles/main.css')
    expect(sourcePaths).not.toContain('styles/theme.css')
    // Every asset must be an image or font (no web-document MIME types)
    for (const asset of plan.assets) {
      const isWebDoc =
        asset.mimeType.startsWith('text/html') ||
        asset.mimeType.startsWith('text/css') ||
        asset.mimeType.startsWith('text/javascript') ||
        asset.mimeType.startsWith('application/javascript')
      expect(isWebDoc).toBe(false)
    }
  })

  it('imports JS files as site scripts', () => {
    expect(plan.scripts.map((s) => s.path)).toContain('scripts/app.js')
  })

  it('has empty conflicts on a fresh site', () => {
    expect(plan.conflicts.pages).toHaveLength(0)
    expect(plan.conflicts.rules).toHaveLength(0)
  })

  it('detects unused CSS — CSS not linked by any page', () => {
    const withUnused: FileMap = {
      files: {
        ...fileMap.files,
        'styles/unused.css': { bytes: new TextEncoder().encode('.u { display: none }'), mimeType: 'text/css' },
      },
    }
    const p = buildImportPlan({ fileMap: withUnused, currentSite })
    expect(p.unusedCss).toContain('styles/unused.css')
  })

  it('extracts root font variables into font tokens', () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Home</h1></body></html>`
    const css = `
      :root {
        --font-display: "Acme Grotesk", serif;
        --font-size-base: 16px;
      }
      h1 { font-family: var(--font-display); }
    `
    const p = buildImportPlan({
      fileMap: makeSinglePageFileMap(html, css),
      currentSite: makeEmptySiteDocument(),
    })

    expect(p.fontTokens).toEqual([
      {
        name: 'Display',
        variable: 'font-display',
        family: 'Acme Grotesk',
        fallback: 'serif',
      },
    ])
    const root = p.styleRules.find((rule) => rule.selector === ':root')
    expect(root?.styles).toEqual({ '--font-size-base': '16px' })
    expect(p.styleRules.find((rule) => rule.selector === 'h1')?.styles.fontFamily).toBe('var(--font-display)')
  })
})

// ---------------------------------------------------------------------------
// buildImportPlan — slug derivation
// ---------------------------------------------------------------------------

describe('buildImportPlan — slug derivation', () => {
  it('derives correct slugs from HTML filenames', () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const slugs = plan.pages.map((p) => p.slug).sort()
    expect(slugs).toContain('index')
    expect(slugs).toContain('about')
    expect(slugs).toContain('contact')
  })
})

// ---------------------------------------------------------------------------
// buildImportPlan — conflict detection with existing site
// ---------------------------------------------------------------------------

describe('buildImportPlan — conflict detection', () => {
  it('detects slug collision with existing page', () => {
    // Create a site that has a page with slug 'about'
    const site = {
      ...makeEmptySiteDocument(),
      pages: [
        {
          id: 'about-id',
          title: 'About',
          slug: 'about',
          rootNodeId: 'r',
          nodes: { r: { id: 'r', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [], classIds: [] } },
        },
      ],
    }
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: site })
    const aboutConflict = plan.conflicts.pages.find((c) => c.desiredSlug === 'about')
    expect(aboutConflict).toBeDefined()
    expect(aboutConflict!.defaultResolution.resolvedSlug).toBe('about-2')
  })

  it('detects class rule name collision', () => {
    const site = makeMockSiteDocument() // has 'existing-class' rule
    // Temporarily add a 'hero-title' rule (present in our sample CSS)
    const now = Date.now()
    const siteWithHero = {
      ...site,
      styleRules: {
        ...site.styleRules,
        'hero-rule': {
          id: 'hero-rule',
          name: 'hero-title',
          kind: 'class' as const,
          selector: '.hero-title',
          order: 2,
          styles: {},
          contextStyles: {},
          createdAt: now,
          updatedAt: now,
        },
      },
    }
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: siteWithHero })
    const heroConflict = plan.conflicts.rules.find((c) => c.desiredName === 'hero-title')
    expect(heroConflict).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// commitImportPlan — happy path
// ---------------------------------------------------------------------------

describe('commitImportPlan — happy path', () => {
  it('uploads all assets', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const adapter = makeMockAdapter()
    await commitImportPlan(plan, adapter)
    // hero.png and logo.png should be uploaded
    expect(adapter.uploads).toContain('images/hero.png')
    expect(adapter.uploads).toContain('images/logo.png')
  })

  it('calls addPage for each non-conflicting page', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const adapter = makeMockAdapter()
    await commitImportPlan(plan, adapter)
    const addPageOps = adapter.ops.filter((o) => o.type === 'addPage')
    expect(addPageOps).toHaveLength(3)
  })

  it('calls addStyleRule for each non-conflicting rule', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const adapter = makeMockAdapter()
    await commitImportPlan(plan, adapter)
    const addRuleOps = adapter.ops.filter((o) => o.type === 'addStyleRule')
    expect(addRuleOps.length).toBeGreaterThan(0)
  })

  it('returns ImportResult with correct shape', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const adapter = makeMockAdapter()
    const result = await commitImportPlan(plan, adapter)
    expect(result.pages).toHaveLength(3)
    expect(result.styleRules.length).toBeGreaterThan(0)
    expect(result.assets.length).toBeGreaterThan(0)
    // Each asset should have a mediaUrl
    for (const asset of result.assets) {
      expect(asset.mediaUrl.startsWith('/uploads/media/')).toBe(true)
    }
  })

  it('commits imported font tokens after imported font families', async () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Home</h1></body></html>`
    const css = `
      @font-face {
        font-family: "Acme Grotesk";
        font-weight: 400;
        font-style: normal;
        src: url("fonts/acme.woff2") format("woff2");
      }
      :root { --font-display: "Acme Grotesk", serif; }
      h1 { font-family: var(--font-display); }
    `
    const plan = buildImportPlan({
      fileMap: {
        files: {
          ...makeSinglePageFileMap(html, css).files,
          'fonts/acme.woff2': { bytes: new Uint8Array([1, 2, 3]), mimeType: 'font/woff2' },
        },
      },
      currentSite: makeEmptySiteDocument(),
    })
    const adapter = makeMockAdapter()
    const result = await commitImportPlan(plan, adapter)

    const addFontsIndex = adapter.ops.findIndex((op) => op.type === 'addFonts')
    const addFontTokensIndex = adapter.ops.findIndex((op) => op.type === 'addFontTokens')
    expect(addFontsIndex).toBeGreaterThanOrEqual(0)
    expect(addFontTokensIndex).toBeGreaterThan(addFontsIndex)
    expect((adapter.ops[addFontTokensIndex].args as { tokens: unknown[] }).tokens).toEqual([
      {
        name: 'Display',
        variable: 'font-display',
        family: 'Acme Grotesk',
        fallback: 'serif',
      },
    ])
    expect(result.fontTokens).toEqual([
      { id: 'mock-id-2', name: 'Display', variable: 'font-display' },
    ])
  })

  it('rewrites asset URLs in the committed pages', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const adapter = makeMockAdapter()
    await commitImportPlan(plan, adapter)

    // Find addPage ops and inspect their nodeFragment for rewritten URLs
    const addPageOps = adapter.ops.filter((o) => o.type === 'addPage')
    let foundRewrittenSrc = false
    for (const op of addPageOps) {
      const fragment = (op.args as { nodeFragment: ImportFragment }).nodeFragment
      for (const node of Object.values(fragment.nodes)) {
        const src = node.props['src']
        if (typeof src === 'string' && src.startsWith('/uploads/media/')) {
          foundRewrittenSrc = true
        }
      }
    }
    expect(foundRewrittenSrc).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// commitImportPlan — conflict resolution branches
// ---------------------------------------------------------------------------

describe('commitImportPlan — conflict: skip', () => {
  it('skips a page when resolution is "skip"', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    // Manually inject a conflict with skip resolution
    const pageToSkip = plan.pages[0]
    const planWithConflict: ImportPlan = {
      ...plan,
      conflicts: {
        ...plan.conflicts,
        pages: [
          {
            source: pageToSkip.source,
            desiredSlug: pageToSkip.slug,
            existingPageId: 'existing-id',
            defaultResolution: { action: 'skip' },
          },
        ],
      },
    }
    const adapter = makeMockAdapter()
    const result = await commitImportPlan(planWithConflict, adapter)

    // The skipped page should not appear in addPage ops
    const addPageOps = adapter.ops.filter((o) => o.type === 'addPage')
    expect(addPageOps).toHaveLength(plan.pages.length - 1)
    // Should not appear in result.pages
    expect(result.pages.find((p) => p.source === pageToSkip.source)).toBeUndefined()
  })
})

describe('commitImportPlan — conflict: overwrite', () => {
  it('calls overwritePage when resolution is "overwrite"', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const pageToOverwrite = plan.pages[0]
    const planWithConflict: ImportPlan = {
      ...plan,
      conflicts: {
        ...plan.conflicts,
        pages: [
          {
            source: pageToOverwrite.source,
            desiredSlug: pageToOverwrite.slug,
            existingPageId: 'old-page-id',
            defaultResolution: { action: 'overwrite' },
          },
        ],
      },
    }
    const adapter = makeMockAdapter()
    await commitImportPlan(planWithConflict, adapter)
    const overwriteOps = adapter.ops.filter((o) => o.type === 'overwritePage')
    expect(overwriteOps).toHaveLength(1)
    expect((overwriteOps[0].args as Record<string, unknown>)['pageId']).toBe('old-page-id')
  })
})

describe('commitImportPlan — conflict: auto-rename', () => {
  it('uses resolvedSlug when resolution is "auto-rename"', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const pageToRename = plan.pages[0]
    const planWithConflict: ImportPlan = {
      ...plan,
      pages: plan.pages.map((p) =>
        p.source === pageToRename.source ? { ...p, slug: 'about-2' } : p,
      ),
      conflicts: {
        ...plan.conflicts,
        pages: [
          {
            source: pageToRename.source,
            desiredSlug: pageToRename.slug,
            existingPageId: 'old-page-id',
            defaultResolution: { action: 'auto-rename', resolvedSlug: 'about-2' },
          },
        ],
      },
    }
    const adapter = makeMockAdapter()
    await commitImportPlan(planWithConflict, adapter)
    const addOps = adapter.ops.filter(
      (o) => o.type === 'addPage' && (o.args as Record<string, unknown>)['slug'] === 'about-2',
    )
    expect(addOps.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Atomicity — forced upload failure leaves no partial store state
// ---------------------------------------------------------------------------

describe('commitImportPlan — per-asset upload failure recovery', () => {
  it('continues past upload failures, records them as warnings, and still commits the store mutation', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const adapter = makeMockAdapter({ uploadFail: true })

    // Per-asset failures used to throw and abort the whole commit. The new
    // contract: catch each failure, surface it as an `asset-upload-failed`
    // warning, continue uploading the rest, and still run `adapter.commit`
    // so the user's pages + style rules land regardless.
    const result = await commitImportPlan(plan, adapter)

    expect(adapter.ops.length).toBeGreaterThan(0) // commit DID run
    expect(result.assets).toEqual([]) // all uploads failed → no successful assets
    const uploadFailures = result.warnings.filter((w) => w.kind === 'asset-upload-failed')
    expect(uploadFailures.length).toBe(plan.assets.length)
  })
})

// ---------------------------------------------------------------------------
// Unused CSS
// ---------------------------------------------------------------------------

describe('buildImportPlan — unused CSS', () => {
  it('marks CSS files not linked by any page as unusedCss', () => {
    const enc = new TextEncoder()
    const fileMapWithOrphan: FileMap = {
      files: {
        'index.html': { bytes: enc.encode('<html><head></head><body><p>Hi</p></body></html>'), mimeType: 'text/html' },
        'styles/orphan.css': { bytes: enc.encode('.foo { color: red }'), mimeType: 'text/css' },
      },
    }
    const plan = buildImportPlan({ fileMap: fileMapWithOrphan, currentSite: makeEmptySiteDocument() })
    expect(plan.unusedCss).toContain('styles/orphan.css')
    // orphan CSS rules should NOT appear in styleRules
    expect(plan.styleRules.find((r) => r.name === 'foo')).toBeUndefined()
  })
})
