import type { StyleRule } from '@core/page-tree'
import { styleRuleSelector } from '@core/page-tree/classNames'
import { sanitiseCssValue } from './utils'

/**
 * Convert a camelCase CSS property name to kebab-case.
 * "backgroundColor" -> "background-color", "zIndex" -> "z-index"
 */
function toKebab(camel: string): string {
  return camel.replace(/([A-Z])/g, (_, c: string) => `-${c.toLowerCase()}`)
}

/**
 * Allowlist of camelCase CSS property names that the publisher supports.
 * Exported so the CSS importer can filter imported declarations to the same set.
 */
export const ALLOWED_PROPS = new Set<string>([
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
  'lineHeight', 'textAlign', 'textDecoration', 'textTransform', 'color', 'textShadow',
  'display', 'flexDirection', 'flexWrap', 'alignItems', 'justifyContent',
  'justifyItems', 'alignSelf', 'justifySelf', 'flex', 'gap', 'rowGap', 'columnGap',
  'gridTemplateColumns', 'gridTemplateRows', 'gridColumn', 'gridRow',
  'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'aspectRatio', 'boxSizing',
  // Spacing — per-side only. The shorthand `padding`/`margin` keys are not
  // stored; `bagToCSS` collapses the 4 sides into the CSS shorthand at
  // emission time (see `tryCollapseSides` below).
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'position', 'top', 'right', 'bottom', 'left', 'zIndex',
  'backgroundColor', 'background', 'backgroundImage', 'backgroundSize',
  'backgroundPosition', 'backgroundRepeat', 'objectFit', 'objectPosition',
  'opacity', 'overflow', 'overflowX', 'overflowY',
  'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
  'borderColor',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius',
  'borderBottomLeftRadius', 'borderBottomRightRadius',
  'outline', 'outlineOffset',
  'boxShadow', 'filter', 'backdropFilter', 'transform', 'transformOrigin',
  'transition', 'animation',
  'cursor', 'pointerEvents', 'userSelect', 'scrollBehavior',
  'fill',
  'isolation',
  'backgroundPositionX', 'backgroundPositionY', 'backgroundAttachment',
  'backgroundOrigin', 'backgroundClip',
  'content',
  'textWrapMode', 'textWrapStyle',
])

// ---------------------------------------------------------------------------
// Side-shorthand collapse — `paddingTop/Right/Bottom/Left` → `padding: T R B L`
// ---------------------------------------------------------------------------
//
// The schema stores per-side values (paddingTop, paddingRight, …) as the only
// canonical shape — there is no `padding`/`margin` shorthand key in storage.
// At the publishing boundary we collapse those four declarations into the
// standard CSS shorthand so the generated stylesheet reads the way a human
// would write it (`padding: 20px 0;`) rather than four separate
// `padding-top/right/bottom/left` lines.
//
// Collapse only happens when ALL four sides are present in the bag — partial
// overrides (e.g. a breakpoint that only changes `paddingTop`) keep their
// per-side shape so they don't accidentally reset the other three sides to 0.

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const
const SIDE_SHORTHAND_PREFIXES = ['padding', 'margin'] as const
type SideShorthandPrefix = (typeof SIDE_SHORTHAND_PREFIXES)[number]

const SIDE_PROP_TO_PREFIX = new Map<string, SideShorthandPrefix>(
  SIDE_SHORTHAND_PREFIXES.flatMap((prefix) =>
    SIDES.map((side) => [`${prefix}${side}`, prefix] as const),
  ),
)

/**
 * Collapse 4 per-side values into the shortest valid CSS shorthand:
 *   - all four equal               → "T"           (e.g. `20px`)
 *   - top == bottom, left == right → "T L"         (e.g. `20px 0`)
 *   - left == right                → "T L B"       (e.g. `20px 8px 12px`)
 *   - otherwise                    → "T R B L"     (e.g. `20px 8px 12px 4px`)
 */
function buildSidesShorthand(top: string, right: string, bottom: string, left: string): string {
  if (top === right && right === bottom && bottom === left) return top
  if (top === bottom && left === right) return `${top} ${right}`
  if (left === right) return `${top} ${left} ${bottom}`
  return `${top} ${right} ${bottom} ${left}`
}

/**
 * If `bag` carries all four `<prefix>Top/Right/Bottom/Left` values, return
 * the collapsed shorthand value. Returns `null` when any side is missing or
 * dropped by the sanitiser — the caller falls back to per-side longhand.
 */
function tryCollapseSides(
  bag: Record<string, unknown>,
  prefix: SideShorthandPrefix,
): string | null {
  const values: string[] = []
  for (const side of SIDES) {
    const raw = bag[`${prefix}${side}`]
    if (raw === undefined || raw === null || raw === '') return null
    const sanitised = sanitiseCssValue(raw as string | number)
    if (sanitised === null) return null
    values.push(sanitised)
  }
  const [top, right, bottom, left] = values
  return buildSidesShorthand(top, right, bottom, left)
}

/**
 * Serialise a style map to a CSS declaration block string.
 * Only emits properties in the allowlist with sanitised values.
 * Accepts the wide persistence type (Record<string, unknown>) since styles are
 * stored without per-property narrowing at the persistence boundary.
 *
 * Per-side `padding`/`margin` properties are collapsed into the standard
 * shorthand when all four sides are present (see `tryCollapseSides`). The
 * shorthand is emitted at the position of the first encountered side so it
 * appears in the natural order relative to other declarations.
 */
export function bagToCSS(bag: Record<string, unknown>): string {
  const lines: string[] = []
  // Track which prefixes have already been emitted as a collapsed shorthand
  // so we skip the remaining three side properties for that prefix.
  const collapsedPrefixes = new Set<SideShorthandPrefix>()

  for (const [prop, value] of Object.entries(bag)) {
    if (!ALLOWED_PROPS.has(prop)) continue
    if (value === undefined || value === null || value === '') continue

    const sidePrefix = SIDE_PROP_TO_PREFIX.get(prop)
    if (sidePrefix) {
      if (collapsedPrefixes.has(sidePrefix)) continue
      const shorthand = tryCollapseSides(bag, sidePrefix)
      if (shorthand !== null) {
        lines.push(`  ${sidePrefix}: ${shorthand};`)
        collapsedPrefixes.add(sidePrefix)
        continue
      }
      // Fewer than 4 sides present → fall through and emit longhand below.
    }

    const sanitised = sanitiseCssValue(value as string | number)
    if (sanitised === null) continue
    lines.push(`  ${toKebab(prop)}: ${sanitised};`)
  }
  return lines.join('\n')
}

/**
 * Generate the full CSS string for all classes in the registry.
 * Includes base styles and @media blocks for breakpoint overrides.
 *
 * Cascade order matters. We emit breakpoint @media blocks in DESCENDING
 * width order (widest first, narrowest last). All @media (max-width: N)
 * blocks have the same selector specificity, so the last-matching one in
 * source order wins. Desktop is widest → its rule applies at wider
 * viewports while shadowed by tablet/mobile when the viewport narrows.
 *
 * If we iterated `cls.breakpointStyles` in insertion order, the user's
 * editing sequence would silently determine which breakpoint "wins" at
 * any given viewport — e.g. mobile-then-desktop would let desktop styles
 * leak through to mobile widths because desktop's @media rule was last
 * in source. Sorting by width fixes that for good.
 */
export function generateClassCSS(
  classes: Record<string, StyleRule>,
  breakpoints: Array<{ id: string; width: number }>,
): string {
  const blocks: string[] = []
  // Map id → width once per call so we can sort breakpoint entries below
  // without re-scanning the array per class.
  const widthById = new Map<string, number>(breakpoints.map((bp) => [bp.id, bp.width]))

  // Cascade order: rules with a smaller `order` are emitted first so a later,
  // more-specific override appears later in source and wins on equal
  // specificity. Imported rules carry the source stylesheet's position;
  // user-created rules append at the end (see classSlice.nextRuleOrder).
  const orderedClasses = Object.values(classes).slice().sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : 0
    const bo = typeof b.order === 'number' ? b.order : 0
    return ao - bo
  })

  for (const cls of orderedClasses) {
    const baseDecls = bagToCSS(cls.styles)
    if (baseDecls) {
      blocks.push(`${styleRuleSelector(cls)} {\n${baseDecls}\n}`)
    }

    const bpEntries = Object.entries(cls.breakpointStyles)
      .map(([bpId, bpStyles]) => ({ bpStyles, width: widthById.get(bpId) }))
      .filter((entry): entry is { bpStyles: typeof entry.bpStyles; width: number } =>
        entry.width !== undefined,
      )
      // Widest first → narrowest last. The narrowest matching @media rule
      // ends up later in source and wins on equal specificity.
      .sort((a, b) => b.width - a.width)

    for (const { bpStyles, width } of bpEntries) {
      const decls = bagToCSS(bpStyles)
      if (!decls) continue
      blocks.push(`@media (max-width: ${width}px) {\n  ${styleRuleSelector(cls)} {\n${decls}\n  }\n}`)
    }
  }

  return blocks.join('\n\n')
}
