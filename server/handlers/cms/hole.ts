/**
 * `/_pb/hole-runtime.js` and `/_pb/hole/<nodeId>` endpoints — Layer C server islands.
 *
 * The runtime asset is a tiny JavaScript module (< 1 KB) that uses
 * IntersectionObserver to lazily fetch rendered fragments for `<pb-hole>`
 * elements in published pages.
 *
 * The fragment endpoint (`/_pb/hole/<nodeId>`) renders a single node subtree
 * from the latest published snapshot and returns it as HTML. Responses are
 * cached by Layer B with version-aware keys — most popular holes render once
 * per publish per (nodeId, queryString) burst via single-flight.
 *
 * Version-awareness: the hole runtime stamps `data-pb-version` on each
 * placeholder from the published HTML. The fragment endpoint compares the
 * `?v=` param to the current `publishVersion`; a mismatch returns a lightweight
 * stale fragment without caching so the next page load picks up the new version.
 *
 * Inside the hole endpoint the RenderContext has no `dynamicNodeIds` — the node
 * subtree is rendered fully (it is already the request-time dynamic part).
 */

import type { DbClient } from '../../db/client'
import { registry } from '@core/module-engine/registry'
import { renderNode, type RenderContext } from '@core/publisher/render'
import { getLatestPublishedSiteSnapshot } from '../../repositories/publish'
import { getOrRender, getPublishVersion } from '../../publish/renderCache'
import { HOLE_RUNTIME_JS } from '../../publish/holeRuntime'

const HOLE_RUNTIME_PATH = '/_pb/hole-runtime.js'
const HOLE_PATH_PREFIX = '/_pb/hole/'

export function isHoleRuntimeAssetPath(pathname: string): boolean {
  return pathname === HOLE_RUNTIME_PATH
}

export function serveHoleRuntimeAsset(): Response {
  return new Response(HOLE_RUNTIME_JS, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      // Cache for 1 hour — the path is a well-known fixed CMS asset that
      // only changes on a CMS version bump. Use deploy-time cache-busting
      // (e.g. append a build hash) if you need longer caching.
      'cache-control': 'public, max-age=3600',
    },
  })
}

export interface HoleHandlerContext {
  db: DbClient
}

/**
 * Render a single dynamic node subtree for Layer C hole hydration.
 *
 * GET `/_pb/hole/<nodeId>?v=<publishVersion>` → HTML fragment.
 *
 * Version guard: if the `?v=` param doesn't match the current publish version,
 * a lightweight stale sentinel is returned without caching. The next page load
 * will include a fresh placeholder stamped with the new version.
 *
 * Caching: version-matched responses are stored in the Layer B LRU cache with
 * key `(/_pb/hole/<nodeId>, ?v=<version>)`. Single-flight ensures the factory
 * runs exactly once per concurrent burst.
 */
export async function handleHoleRequest(
  req: Request,
  url: URL,
  ctx: HoleHandlerContext,
): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  // /_pb/hole/<encoded-nodeId>
  const nodeId = decodeURIComponent(url.pathname.slice(HOLE_PATH_PREFIX.length))
  if (!nodeId) {
    return new Response('Missing node id', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  // Version check — if the ?v= param doesn't match the current publish version,
  // return a lightweight stale sentinel without caching. The next full page load
  // will carry the correct version in its placeholder attributes.
  const requestVersion = url.searchParams.get('v') ?? ''
  const currentVersion = getPublishVersion()
  if (requestVersion !== String(currentVersion)) {
    return new Response('<pb-hole-stale data-pb-stale="true"></pb-hole-stale>', {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }

  // Load the latest published snapshot. We search ALL pages because a hole can
  // live in any page (regular page or content-template page).
  const snapshot = await getLatestPublishedSiteSnapshot(ctx.db)
  if (!snapshot) {
    return new Response('Site not published', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  let containingPage = null
  for (const page of snapshot.site.pages) {
    if (page.nodes[nodeId]) {
      containingPage = page
      break
    }
  }

  if (!containingPage) {
    return new Response('Node not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  const foundPage = containingPage

  // Cache via Layer B. The query string includes ?v=<version> so each publish
  // generation gets its own cache slot — stale entries are never served.
  const cached = await getOrRender(
    { urlPath: `${HOLE_PATH_PREFIX}${nodeId}`, queryString: url.search },
    async () => {
      // Render the node subtree with no dynamicNodeIds — inside the hole
      // endpoint we render fully (the node is already the dynamic boundary).
      const renderCtx: RenderContext = {
        page: foundPage,
        site: snapshot.site,
        registry,
        breakpointId: undefined,
        cssMap: new Map(),
        templateContext: { entryStack: [] },
        // No dynamicNodeIds: inside a hole endpoint, we render the full subtree.
        // No holeNodeIds: not needed — this is a fragment render, not a page render.
      }
      const html = renderNode(nodeId, renderCtx)
      return {
        body: html,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        status: 200 as const,
      }
    },
  )

  if (!cached) {
    return new Response('Render failed', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  return new Response(cached.body, {
    status: cached.status,
    headers: cached.headers,
  })
}
