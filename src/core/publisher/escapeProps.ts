/**
 * Publisher — prop escaping (Constraint #211)
 *
 * Every string prop is escaped BEFORE being handed to a module's pure
 * render() function. Three categories with distinct rules:
 *
 * - URL-typed props (`href` / `src` / `action` / `*url` / `*src` / `*href`):
 *   validated by isSafeUrl() to neutralise `javascript:` / `vbscript:` /
 *   `data:` schemes (replaced with `#`). The raw safe URL is passed through
 *   un-escaped so module render() can call safeUrl() once — calling
 *   escapeHtml() here would double-escape ampersands in query strings.
 *
 * - Richtext / HTML props (`richtext` / `html` / `*richtext` / `*html`):
 *   passed through sanitizeRichtext() (DOMPurify when DOM is available,
 *   regex strip otherwise) as defense-in-depth on top of the editor-side
 *   sanitisation at write time.
 *
 * - Plain strings: HTML-escaped via escapeHtml().
 *
 * Non-string values pass through unchanged so derived assets like
 * `_resolvedMediaByKey` (attached after this step) survive the boundary.
 */

import { escapeHtml, isSafeUrl } from './utils'
import { sanitizeRichtext } from '@core/sanitize'

/**
 * URL-related prop key suffixes and exact keys.
 * These receive URL validation rather than HTML escaping.
 */
const URL_PROP_KEYS = new Set(['href', 'src', 'action', 'url'])
const URL_PROP_SUFFIXES = ['url', 'href', 'src']

/**
 * Richtext / HTML prop keys — passed through sanitizeRichtext() rather
 * than escapeHtml() so the module can emit tagged content. MUST have been
 * sanitized at the editor boundary; this is a second pass at the publisher.
 */
const RICHTEXT_PROP_KEYS = new Set(['richtext', 'html'])
const RICHTEXT_PROP_SUFFIXES = ['html', 'richtext']

function isUrlKey(key: string): boolean {
  const k = key.toLowerCase()
  if (URL_PROP_KEYS.has(k)) return true
  return URL_PROP_SUFFIXES.some((s) => k.endsWith(s))
}

function isRichtextKey(key: string): boolean {
  const k = key.toLowerCase()
  if (RICHTEXT_PROP_KEYS.has(k)) return true
  return RICHTEXT_PROP_SUFFIXES.some((s) => k.endsWith(s))
}

/**
 * Escape every string prop before passing them to a module's render().
 *
 * - String props → escapeHtml()
 * - URL props → isSafeUrl() (unsafe → '#'), no HTML escape (module's safeUrl() handles that)
 * - Richtext / HTML props → sanitizeRichtext() (DOMPurify; regex fallback)
 * - Non-string props → unchanged
 */
export function escapeProps(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const escaped: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== 'string') {
      escaped[key] = value
      continue
    }

    if (isRichtextKey(key)) {
      // Richtext: defense-in-depth sanitization via DOMPurify (Constraint #368).
      // DOMPurify runs at write time (editor/Properties Panel boundary); this is a
      // second pass at the publisher boundary so that corrupted or injected richtext
      // values cannot reach the published HTML unsanitized.
      // sanitizeRichtext falls back to a regex strip if DOMPurify is unavailable
      // (e.g. server-side Bun context with no DOM).
      escaped[key] = sanitizeRichtext(value)
    } else if (isUrlKey(key)) {
      // URLs: block javascript: and vbscript: schemes; pass safe URLs through raw
      // so that module render() functions can HTML-escape them via safeUrl() from
      // modules/base/utils/escape.ts.  Publisher HTML-escaping plain strings is the
      // escapeProps() contract for non-URL string props; URL props deliberately skip
      // the escapeHtml() step here to avoid double-escaping when modules call safeUrl()
      // (which also applies escapeHtml internally).
      // Note: publishPage() manually escapeHtml()'s faviconUrl/fontImportUrl because
      // those are not passed to module render() — they go directly into HTML template
      // strings that never pass through a module's safeUrl() call.
      escaped[key] = isSafeUrl(value) ? value : '#'
    } else {
      // Plain strings: HTML-escape
      escaped[key] = escapeHtml(value)
    }
  }

  return escaped
}
