import type { Page, SiteDocument } from '@core/page-tree'

export function normalizeRouteBase(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return '/'

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/g, '')
  return withoutTrailingSlash || '/'
}

/** What an inbound public URL resolved to, for template matching. */
export type RouteResolutionContext =
  | { kind: 'page' }
  | { kind: 'entry'; tableSlug: string }

export function isTemplatePage(page: Page): boolean {
  return page.template?.enabled === true
}

/**
 * The primary post-type slug a template targets, or null for an `everywhere`
 * layout / non-template page. Used to scope `currentEntry` bindings and to
 * populate the `{page.templateTableSlug}` binding frame in the single-target
 * case (the overwhelmingly common one in v1).
 */
export function primaryTemplateTableSlug(page: Page): string | null {
  const target = page.template?.target
  if (target?.kind === 'postTypes') return target.tableSlugs[0] ?? null
  return null
}

/**
 * Breadth levels, OUTER → INNER. Adding a level here (e.g. a path-prefix
 * "section" layout between everywhere and postTypes) is the only change
 * needed to deepen nesting — the resolver loop is level-agnostic.
 */
function matchesLevel(
  page: Page,
  level: 'everywhere' | 'postTypes',
  ctx: RouteResolutionContext,
): boolean {
  const target = page.template?.target
  if (!target) return false
  if (level === 'everywhere') return target.kind === 'everywhere'
  if (level === 'postTypes') {
    return target.kind === 'postTypes'
      && ctx.kind === 'entry'
      && target.tableSlugs.includes(ctx.tableSlug)
  }
  return false
}

const LEVELS = ['everywhere', 'postTypes'] as const

/**
 * Collect every template matching the route, ordered outer → inner. At most
 * one template per breadth level (highest priority, document order breaks ties).
 */
export function resolveTemplateChain(
  site: SiteDocument,
  ctx: RouteResolutionContext,
): Page[] {
  const indexed = site.pages.map((page, index) => ({ page, index }))
  const chain: Page[] = []
  for (const level of LEVELS) {
    const winner = indexed
      .filter(({ page }) => isTemplatePage(page) && matchesLevel(page, level, ctx))
      .sort((a, b) => ((b.page.template?.priority ?? 0) - (a.page.template?.priority ?? 0)) || a.index - b.index)[0]
    if (winner) chain.push(winner.page)
  }
  return chain
}
