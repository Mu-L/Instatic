import { extname, resolve, sep } from 'node:path'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { SESSION_COOKIE_NAME } from './auth/tokens'

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.map': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

// Mime types worth compressing. Already-compressed binary formats (woff2, png,
// jpg, mp4, webp, webm) gain nothing and would burn CPU.
const COMPRESSIBLE_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.svg', '.map'])

// Below this size compression overhead (extra response bytes for headers,
// CPU cost) outweighs the savings.
const COMPRESS_MIN_BYTES = 1024

// Use ArrayBuffer-backed Uint8Arrays explicitly: gzipSync / Response body
// require this concrete variant in TS DOM lib, not the SharedArrayBuffer
// generic.
type ResponseBytes = Uint8Array<ArrayBuffer>

interface CachedCompression {
  brotli: ResponseBytes | null
  gzip: ResponseBytes | null
  // mtime fingerprint so we automatically invalidate when the file changes
  // (e.g. between deploys without a server restart).
  mtimeMs: number
}

// Cache compressed bytes per absolute file path. Static assets in /assets/
// are immutable+hashed so this is effectively populated once per deploy.
const compressionCache = new Map<string, CachedCompression>()

function contentType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function resolveStaticPath(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  const rootPath = resolve(root)
  const filePath = resolve(rootPath, `.${decoded}`)
  if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${sep}`)) return null
  return filePath
}

function isCompressible(filePath: string, byteLength: number): boolean {
  if (byteLength < COMPRESS_MIN_BYTES) return false
  return COMPRESSIBLE_EXTENSIONS.has(extname(filePath).toLowerCase())
}

/**
 * Pick the best encoding the client will accept. Order of preference:
 *   br > gzip > identity
 * We do not parse q-values — clients in the wild include `br, gzip` either
 * way, and a wrong q-value parse would give us a bigger response, never a
 * broken one.
 */
function selectEncoding(acceptEncoding: string | null): 'br' | 'gzip' | null {
  if (!acceptEncoding) return null
  const normalized = acceptEncoding.toLowerCase()
  if (normalized.includes('br')) return 'br'
  if (normalized.includes('gzip')) return 'gzip'
  return null
}

async function compressForEncoding(
  filePath: string,
  bytes: ResponseBytes,
  encoding: 'br' | 'gzip',
  mtimeMs: number,
): Promise<ResponseBytes> {
  let entry = compressionCache.get(filePath)
  if (!entry || entry.mtimeMs !== mtimeMs) {
    entry = { brotli: null, gzip: null, mtimeMs }
    compressionCache.set(filePath, entry)
  }

  if (encoding === 'br') {
    if (!entry.brotli) {
      // Brotli quality 5 — sweet spot for first-request latency on text payloads
      // (~99% of max ratio for ~10% of the CPU vs. quality 11). We cache the
      // result in-process anyway, so repeat hits pay zero cost.
      const compressed = brotliCompressSync(bytes, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
      })
      // Node returns a Buffer (Uint8Array<ArrayBufferLike>); copy into a
      // fresh ArrayBuffer-backed view so it satisfies BodyInit and our cache type.
      entry.brotli = new Uint8Array(new Uint8Array(compressed)) as ResponseBytes
    }
    return entry.brotli
  }

  if (!entry.gzip) {
    entry.gzip = Bun.gzipSync(bytes) as ResponseBytes
  }
  return entry.gzip
}

export async function serveStaticFile(
  staticDir: string,
  pathname: string,
  req?: Request,
): Promise<Response | null> {
  const filePath = resolveStaticPath(staticDir, pathname)
  if (!filePath) return null

  const file = Bun.file(filePath)
  if (!(await file.exists())) return null

  const cacheControl = pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
  const mime = contentType(filePath)

  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer) as ResponseBytes
  const acceptEncoding = req?.headers.get('accept-encoding') ?? null
  const encoding = isCompressible(filePath, bytes.byteLength)
    ? selectEncoding(acceptEncoding)
    : null

  if (encoding) {
    const compressed = await compressForEncoding(filePath, bytes, encoding, file.lastModified)
    // Body bytes are owned by us — no risk of consumer mutation.
    return new Response(compressed, {
      headers: {
        'content-type': mime,
        'cache-control': cacheControl,
        'content-encoding': encoding,
        // Tells caches the response varies based on the request encoding,
        // so a gzip-only client doesn't get served a cached brotli payload.
        'vary': 'accept-encoding',
      },
    })
  }

  return new Response(bytes, {
    headers: {
      'content-type': mime,
      'cache-control': cacheControl,
    },
  })
}

// ---------------------------------------------------------------------------
// Admin shell — pre-rendered login skeleton for unauthenticated visitors.
// ---------------------------------------------------------------------------
//
// `index.html` ships with an empty animated spinner inside `<div id="root">`.
// Until React mounts (~400 ms cold, see bench:browser), there is nothing
// contentful on the page — Chromium's FCP fires only when React first
// renders, not on the spinner. For visitors with no session cookie, the
// React app's first render is always the login form, so we can pre-render
// the same form server-side and ship it inside the initial HTML. That
// shifts FCP from ~400 ms to ~DCL (~50 ms on local) and gives the user
// instant visual confirmation that the page loaded.
//
// Hydration: React mounts and replaces the static form via the same
// `<div id="root">` it always renders into. There is no React 18-style
// `hydrateRoot()` here — the static markup is purely a perception fix.
// The brief window where the static form is "visible but inert" (~400 ms)
// is fine: the action+method attributes make the form work as a real HTML
// form even without JS, so the user can submit before React mounts.
//
// Authentication signal: presence of the session cookie. We do NOT
// validate it server-side here (that would couple the static handler to
// the auth DB on every cold load). If the cookie is bogus, the served
// spinner shell stays — `useAdminBoot` in the React app will receive a
// 401 from /me and fall back to the login form on its own.
function requestHasSessionCookie(req: Request | undefined): boolean {
  if (!req) return false
  const cookie = req.headers.get('cookie')
  if (!cookie) return false
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) return true
  }
  return false
}

// Static skeleton injected into `<div id="root">` for unauthenticated
// visitors. Minimal CSS — the React form has its own styles which take
// over on hydration, this only needs to look plausible for ~400 ms.
//
// Critical CSS is inlined under `<style data-initial-login>` next to the
// existing `<style data-initial-loader>` block. Both blocks together are
// ~3 KB; we keep them above the fold of the initial HTML so paint can
// happen on the first packet.
const LOGIN_SKELETON_STYLES = `
  /* Login skeleton — visible only until React mounts. Mirrors the visual
     of the React AdminPreAuthForm closely enough that hydration is not
     jarring. */
  .login-skeleton {
    display: grid;
    min-height: 100vh;
    place-items: center;
    overflow: auto;
    color: #ededed;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Inter, sans-serif;
  }
  .login-skeleton__panel {
    width: 100%;
    max-width: 360px;
    padding: 36px 32px 32px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.32);
    box-sizing: border-box;
  }
  .login-skeleton__brand {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 24px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.6);
    letter-spacing: 0.02em;
  }
  .login-skeleton__brand-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #5b8def;
  }
  .login-skeleton__title {
    margin: 0 0 24px;
    font-size: 22px;
    font-weight: 600;
    color: #f5f5f5;
    line-height: 1.2;
  }
  .login-skeleton__field { display: block; margin-bottom: 14px; }
  .login-skeleton__field > span {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.6);
  }
  .login-skeleton__input {
    width: 100%;
    box-sizing: border-box;
    padding: 9px 12px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.04);
    color: #f5f5f5;
    font-size: 14px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
  }
  .login-skeleton__input:focus {
    border-color: rgba(91, 141, 239, 0.6);
    box-shadow: 0 0 0 3px rgba(91, 141, 239, 0.15);
  }
  .login-skeleton__submit {
    width: 100%;
    padding: 10px 16px;
    margin-top: 6px;
    border-radius: 12px;
    border: 1px solid transparent;
    background: #f5f5f5;
    color: #000;
    font-size: 14px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
  }
  .login-skeleton__submit:hover { background: #fff; }
`

const LOGIN_SKELETON_HTML = `<div class="login-skeleton" data-initial-login-skeleton="true">
  <div class="login-skeleton__panel">
    <div class="login-skeleton__brand">
      <span class="login-skeleton__brand-dot" aria-hidden="true"></span>
      <span>Admin</span>
    </div>
    <h1 class="login-skeleton__title">Sign in</h1>
    <form class="login-skeleton__form" action="/admin/api/cms/login" method="POST">
      <label class="login-skeleton__field">
        <span>Email</span>
        <input class="login-skeleton__input" type="email" name="email" required autocomplete="email" />
      </label>
      <label class="login-skeleton__field">
        <span>Password</span>
        <input class="login-skeleton__input" type="password" name="password" required autocomplete="current-password" />
      </label>
      <button class="login-skeleton__submit" type="submit">Sign in</button>
    </form>
  </div>
</div>`

// Build the admin shell HTML with the login skeleton injected. We avoid
// repeating the heavy index.html template by patching the served body
// in-place: replace the inner contents of `<div id="root">` (which the
// build pipeline always emits with the loader spinner) with our skeleton.
function injectLoginSkeleton(html: string): string {
  // 1. Inject the skeleton CSS right after the loader CSS block so the
  //    critical styles are sent in the first response packet.
  const styleTag = `<style data-initial-login>${LOGIN_SKELETON_STYLES}</style>`
  let next = html.replace(
    /<\/style>\s*<\/head>/,
    (m) => m.replace('</style>', `</style>\n    ${styleTag}`),
  )
  // Fallback if the marker pattern shifts: append the style at the end of <head>.
  if (!next.includes('data-initial-login')) {
    next = next.replace('</head>', `  ${styleTag}\n  </head>`)
  }

  // 2. Replace the inner contents of `<div id="root">…</div>` with the
  //    skeleton. The build emits the loader markup as children of #root,
  //    followed by `</div></body>`. Match the loader specifically (its
  //    `data-initial-loader-spinner` attribute is a stable anchor) so the
  //    regex isn't sensitive to indentation or script placement.
  const next2 = next.replace(
    /<div\s+class="loading"[\s\S]*?data-initial-loader-spinner[\s\S]*?<\/div>\s*<\/div>/i,
    LOGIN_SKELETON_HTML,
  )
  if (next2 === next) {
    // Pattern shifted in a build — fall back to swapping the whole #root
    // body. Slightly more invasive but always works.
    return next.replace(
      /(<div id="root">)([\s\S]*?)(<\/div>\s*<\/body>)/i,
      `$1${LOGIN_SKELETON_HTML}$3`,
    )
  }
  return next2
}

export async function serveAdminApp(staticDir: string, req?: Request): Promise<Response | null> {
  // Authenticated visitors keep the existing spinner shell — they're about
  // to be redirected to /admin/dashboard or another section anyway, and
  // their first React commit is the lazy-loaded authenticated layout, not
  // a login form. Pre-rendering the login form here would create a
  // jarring login-form-flash before the editor mounts.
  if (requestHasSessionCookie(req)) {
    return serveStaticFile(staticDir, '/index.html', req)
  }

  // Unauthenticated path: ship a pre-rendered login form so FCP lands at
  // DCL time instead of after the React bundle parses + mounts.
  const filePath = resolveStaticPath(staticDir, '/index.html')
  if (!filePath) return null
  const file = Bun.file(filePath)
  if (!(await file.exists())) return null

  const html = await file.text()
  const transformed = injectLoginSkeleton(html)
  const bytes = new TextEncoder().encode(transformed) as ResponseBytes
  const acceptEncoding = req?.headers.get('accept-encoding') ?? null
  const encoding = selectEncoding(acceptEncoding)

  // Compress inline — we deliberately do NOT route through
  // `compressForEncoding`'s filePath-keyed cache, which would otherwise
  // poison the entry for plain `/index.html` (different bytes, same key).
  // The unauthenticated path is uncommon and the HTML is small (~14 KB),
  // so per-request brotli is cheap.
  if (encoding === 'br') {
    const compressed = brotliCompressSync(bytes, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
    })
    return new Response(new Uint8Array(new Uint8Array(compressed)) as ResponseBytes, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'content-encoding': 'br',
        'vary': 'accept-encoding',
      },
    })
  }
  if (encoding === 'gzip') {
    const compressed = Bun.gzipSync(bytes) as ResponseBytes
    return new Response(compressed, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'content-encoding': 'gzip',
        'vary': 'accept-encoding',
      },
    })
  }

  return new Response(bytes, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    },
  })
}

/**
 * MIMEs we trust to render inline from `/uploads/*` without forcing a
 * download prompt. Strict by design: only the modern image/video formats
 * the upload handler accepts via magic-byte detection.
 *
 * Anything else served from `/uploads/*` is forced to `Content-Disposition:
 * attachment` so a future regression (or a legacy file written before the
 * extension hardening) can't be top-level navigated to and rendered as
 * HTML on the admin origin.
 */
const INERT_UPLOAD_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
])

/**
 * Defense-in-depth headers for `/uploads/*` responses:
 *
 *  - `X-Content-Type-Options: nosniff` — prevents the browser from
 *    overriding our declared Content-Type. Caddy already sets this in the
 *    production reverse proxy, but `bun run dev` and self-hosted
 *    deployments without Caddy don't have it; we set it at the app layer
 *    so it ships in every environment.
 *
 *  - `Content-Disposition: attachment` for non-inert MIMEs — even if a
 *    file with an unsafe extension somehow landed in the uploads dir
 *    (predating the extension hardening, or via a future regression),
 *    forcing a download prevents top-level navigation from running it as
 *    HTML/JS on the admin origin.
 */
export function hardenUploadResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('x-content-type-options', 'nosniff')
  const contentType = headers.get('content-type') ?? ''
  const baseMime = contentType.split(';', 1)[0].trim().toLowerCase()
  if (!INERT_UPLOAD_MIMES.has(baseMime)) {
    headers.set('content-disposition', 'attachment')
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
