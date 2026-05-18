/**
 * DynamicBindingControl — binding affordance + two-pane picker dialog.
 *
 * Wraps any property control child in two modes:
 *
 *  Unbound: renders children with a BracesIcon affordance button (visible on
 *    hover/focus-within) that opens the BindingPickerDialog.
 *
 *  Bound: replaces the child with a striped badge showing the resolved field
 *    label, plus a clear button.
 *
 * The picker dialog shows DataMeta tables (fetched once, cached module-level)
 * in a two-pane layout. When the active page has `template.tableSlug`, the
 * left pane is hidden and the right pane pre-fills with that table's fields
 * ("auto-scope"). When `availableFields` is provided (node inside a loop),
 * an additional "Loop" scope entry appears in the left pane.
 *
 * DataMeta cache lives in `DynamicBindingControl.cache.ts`; import
 * `clearDataMetaCache` from there directly (e.g. in tests).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropertyControl } from '@core/module-engine/types'
import type { DynamicPropBinding } from '@core/page-tree'
import type { LoopSourceField, LoopItem } from '@core/loops/types'
import type { DataMeta, DataMetaField, DataMetaTable } from '@core/data/schemas'
import { useEditorStore, selectActivePage } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { EmptyState } from '@ui/components/EmptyState'
import { SearchBar } from '@ui/components/SearchBar'
import { Separator } from '@ui/components/Separator'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { getFieldIcon } from '@admin/pages/data/utils/fieldIcons'
import {
  isFieldBindable,
  type PropertyControlKind,
} from './bindingCompatibility'
import { _cachedMeta, loadDataMeta } from './DynamicBindingControl.cache'
import { previewCmsDataLoopItems } from '@core/persistence/cmsData'
import { SYSTEM_SOURCES, type SystemSource, type SystemSourceId } from './systemSources'
import { buildPageFrame, buildSiteFrame, buildRouteFrame } from '@core/templates/contextFrames'
import { bindingToToken } from '@core/templates/tokenInterpolation'
import { cn } from '@ui/cn'
import styles from './DynamicBindingControl.module.css'
import controlStyles from '@ui/components/ControlRow/ControlRow.module.css'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DynamicBindingControlProps {
  propKey: string
  label: string
  control: PropertyControl
  layout?: 'inline' | 'stacked'
  binding?: DynamicPropBinding
  onSet: (binding: DynamicPropBinding) => void
  onClear: () => void
  /**
   * Insertion mode — used for string-typed property controls. When set,
   * the picker INSERTS a `{source.field}` token into the prop value at
   * the input's caret (via `onInsertToken`) instead of writing a
   * single-binding to `dynamicBindings`. The bound-state striped chip
   * is suppressed in this mode; the actual token shows up in the
   * underlying text input as ordinary characters.
   *
   * Non-string controls (number, toggle) keep the legacy "replace whole
   * prop" path because tokens can't carry non-string values.
   */
  insertMode?: boolean
  /**
   * Callback for `insertMode === true`. Receives the `{source.field}`
   * token string; the control implementation decides whether to append,
   * insert at caret, or replace the current value.
   */
  onInsertToken?: (token: string) => void
  /**
   * Fields offered by the closest enclosing loop source. When provided, an
   * additional "Loop" scope entry appears in the picker's left pane. These
   * are distinct from DataMeta fields: they include synthesised columns
   * (authorName, permalink, publishedAt, etc.) that live outside the table's
   * field definitions.
   */
  availableFields?: LoopSourceField[]
  /** Human label for the loop source — shown in the left pane. */
  sourceLabel?: string
  /**
   * Table id of the data table this loop iterates (only set when the
   * enclosing loop uses `data.rows`). When provided, the picker auto-scopes
   * to that single table — hiding the left pane and showing its fields
   * directly, plus the loop's synthetic fields in a separate group.
   */
  loopTableId?: string | null
  children: ReactNode
}

// ---------------------------------------------------------------------------
// Helpers: loop source field compat (format-based, not type-based)
// ---------------------------------------------------------------------------

function loopFieldMatchesControl(field: LoopSourceField, controlKind: PropertyControlKind): boolean {
  switch (controlKind) {
    case 'image':
    case 'media':
      return field.format === 'media'
    case 'richtext':
      return field.format === 'html'
    case 'text':
    case 'textarea':
    case 'url':
    case 'number':
    case 'color':
    case 'toggle':
    case 'select':
      return field.format !== 'media' && field.format !== 'html'
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Preview value formatter — renders a LoopItem field value as a short,
// human-readable string for the live preview pane. Stays defensive: any
// unknown shape becomes a JSON snippet so authors can still tell what they
// would bind to.
// ---------------------------------------------------------------------------

function formatPreviewValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') {
    if (!value) return '(empty)'
    return value.length > 200 ? `${value.slice(0, 200)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '(empty)'
    return value.map((v) => formatPreviewValue(v)).join(', ')
  }
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value)
      return json.length > 200 ? `${json.slice(0, 200)}…` : json
    } catch {
      return '[object]'
    }
  }
  return String(value)
}

// ---------------------------------------------------------------------------
// Format derivation when building the binding
// ---------------------------------------------------------------------------

function deriveFormat(
  controlKind: PropertyControlKind,
  fieldType: DataMetaField['type'],
): DynamicPropBinding['format'] | undefined {
  if (fieldType === 'media') return 'media'
  if (
    (fieldType === 'richText' || fieldType === 'longText') &&
    (controlKind === 'richtext' || controlKind === 'textarea')
  ) {
    return 'html'
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Resolved binding label for the bound-state badge
// ---------------------------------------------------------------------------

function resolveBindingLabel(
  binding: DynamicPropBinding,
  availableFields: LoopSourceField[] | undefined,
  sourceLabel: string | undefined,
  meta: DataMeta | null,
): string {
  // System sources first — checked by `binding.source`, not by field id
  // alone, because the same field id ('id', 'slug') can exist on
  // multiple system sources.
  if (
    binding.source === 'page' ||
    binding.source === 'site' ||
    binding.source === 'viewer' ||
    binding.source === 'route'
  ) {
    const system = SYSTEM_SOURCES.find((s) => s.id === binding.source)
    if (system) {
      const field = system.fields.find((f) => f.id === binding.field)
      const fieldLabel = field?.label ?? binding.field
      return `${system.label} → ${fieldLabel}`
    }
  }
  // Loop source fields
  if (availableFields && availableFields.length > 0) {
    const match = availableFields.find((f) => f.id === binding.field)
    if (match) {
      const prefix = sourceLabel ? `${sourceLabel} → ` : ''
      return `${prefix}${match.label}`
    }
  }
  // DataMeta tables
  if (meta) {
    for (const table of meta.tables) {
      const field = table.fields.find((f) => f.id === binding.field)
      if (field) return `${table.name} → ${field.label}`
    }
  }
  // Fallback: humanise the field id
  return `Current entry → ${binding.field}`
}

// ---------------------------------------------------------------------------
// Icon for loop source field format
//
// Icons are resolved at module load (not inside the component) so the
// linter does not flag them as "components created during render".
// ---------------------------------------------------------------------------

const LoopRichTextIcon = getFieldIcon('richText')
const LoopUrlIcon = getFieldIcon('url')
const LoopPlainTextIcon = getFieldIcon('text')

function LoopFieldIcon({ format }: { format?: LoopSourceField['format'] }) {
  if (format === 'media') return <ImageSolidIcon size={12} aria-hidden="true" />
  if (format === 'html') return <LoopRichTextIcon size={12} aria-hidden="true" />
  if (format === 'url') return <LoopUrlIcon size={12} aria-hidden="true" />
  return <LoopPlainTextIcon size={12} aria-hidden="true" />
}

// ---------------------------------------------------------------------------
// BindingPickerDialog — the two-pane DataMeta picker
// ---------------------------------------------------------------------------

const LOOP_SCOPE_KEY = '__loop__'
const SYSTEM_KEY_PREFIX = 'system:'

function systemKey(sourceId: SystemSourceId): string {
  return `${SYSTEM_KEY_PREFIX}${sourceId}`
}

interface PickerDialogProps {
  open: boolean
  label: string
  control: PropertyControl
  availableFields?: LoopSourceField[]
  sourceLabel?: string
  loopTableId?: string | null
  /**
   * Insert mode — confirm button reads "Insert", dialog title indicates
   * insertion rather than binding, and the result is delivered as a
   * token by the parent `DynamicBindingControl`.
   */
  insertMode?: boolean
  onClose: () => void
  onSet: (binding: DynamicPropBinding) => void
}

export function BindingPickerDialog({
  open,
  label,
  control,
  availableFields,
  sourceLabel,
  loopTableId,
  insertMode = false,
  onClose,
  onSet,
}: PickerDialogProps) {
  // ─── Meta fetching ─────────────────────────────────────────────────────
  // Lazy initializer picks up the cached value so already-loaded meta is
  // immediately available without a synchronous setState in the effect.
  const [meta, setMeta] = useState<DataMeta | null>(() => _cachedMeta)
  const [metaLoading, setMetaLoading] = useState(false)
  const [metaError, setMetaError] = useState<string | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    if (_cachedMeta) return // already in state via lazy initializer
    let cancelled = false
    setMetaLoading(true)
    loadDataMeta()
      .then((m) => {
        if (cancelled) return
        setMeta(m)
        setMetaLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setMetaError(err instanceof Error ? err.message : 'Failed to load data meta')
        setMetaLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // ─── Active page template for auto-scope ───────────────────────────────
  const activePageTableSlug = useEditorStore((s) => {
    const page = selectActivePage(s)
    return page?.template?.tableSlug ?? null
  })

  // Live page/site frames for the system-source preview pane. Read off
  // the store so the preview shows the same values bindings will resolve
  // to on the actual page.
  const activePageForFrame = useEditorStore(selectActivePage)
  const activeSite = useEditorStore((s) => s.site)

  // Auto-scope precedence:
  //   1. `loopTableId` (Loop bound to a specific data table) — most specific.
  //      The user picked a table on the loop, so the binding picker should
  //      offer that table's fields directly.
  //   2. `activePageTableSlug` (template page) — the page is bound to a row
  //      from this table, so currentEntry resolves against it.
  // Once auto-scoped, the left pane is hidden and the right pane shows the
  // table's fields. The loop's synthetic fields (authorName, permalink,
  // publishedAt, etc.) appear as a separate group at the bottom of the
  // right pane so they remain reachable.
  const scopedTable: DataMetaTable | null = useMemo(() => {
    if (!meta) return null
    if (loopTableId) {
      const byId = meta.tables.find((t) => t.id === loopTableId)
      if (byId) return byId
    }
    if (activePageTableSlug) {
      return meta.tables.find((t) => t.slug === activePageTableSlug) ?? null
    }
    return null
  }, [loopTableId, activePageTableSlug, meta])

  // Loop scope as a standalone left-pane entry: only when we have loop
  // fields AND no specific table to auto-scope to (otherwise the synthetic
  // fields are appended to the table-fields pane instead).
  const hasLoopScope = !scopedTable && (availableFields?.length ?? 0) > 0

  // ─── Picker state ──────────────────────────────────────────────────────
  const [selectedTableKey, setSelectedTableKey] = useState<string | null>(null)
  const [tableSearch, setTableSearch] = useState('')
  const [fieldSearch, setFieldSearch] = useState('')
  const [pendingBinding, setPendingBinding] = useState<DynamicPropBinding | null>(null)
  // Hovered field id — drives the live preview pane on the right so users
  // can "scrub" through fields and see what each one actually contains
  // before committing to a binding.
  const [hoveredFieldId, setHoveredFieldId] = useState<string | null>(null)
  // Sample rows for the loop's bound table. Fetched lazily when the dialog
  // opens with a `loopTableId` so the preview pane shows real values from
  // the user's data instead of synthetic placeholders.
  const [previewItems, setPreviewItems] = useState<LoopItem[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !loopTableId) {
      return
    }
    let cancelled = false
    setPreviewLoading(true)
    previewCmsDataLoopItems(loopTableId, { limit: 3, orderBy: 'publishedAt', direction: 'desc' })
      .then((result) => {
        if (cancelled) return
        setPreviewItems(result.items)
        setPreviewLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setPreviewItems([])
        setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, loopTableId])

  // Reset state and apply auto-scope when dialog opens / meta loads.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    setTableSearch('')
    setFieldSearch('')
    setPendingBinding(null)
    if (scopedTable) {
      setSelectedTableKey(`table:${scopedTable.id}`)
    } else {
      setSelectedTableKey(null)
    }
  }, [open, scopedTable])

  // When meta finishes loading and we have an auto-scope, select it.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!meta || !open) return
    if (hasLoopScope) return
    if (scopedTable && !selectedTableKey) {
      setSelectedTableKey(`table:${scopedTable.id}`)
    }
  }, [meta, open, hasLoopScope, scopedTable, selectedTableKey])

  // ─── Computed field list for the right pane ────────────────────────────
  const controlKind = control.type as PropertyControlKind

  type FieldEntry =
    | { kind: 'meta'; field: DataMetaField }
    | { kind: 'loop'; field: LoopSourceField }
    | { kind: 'system'; source: SystemSourceId; field: LoopSourceField }
  type FieldGroup = { label: string; entries: FieldEntry[] }

  // Post-type-only loop synthetic fields. Hidden when the auto-scoped table
  // is `kind: 'data'` because they're irrelevant noise there (no body,
  // featured media, SEO, etc.).
  const POST_TYPE_ONLY_LOOP_FIELDS = useMemo(
    () => new Set(['title', 'body', 'featuredMedia', 'firstImage', 'seoTitle', 'seoDescription']),
    [],
  )

  const rightPaneGroups: FieldGroup[] | null = useMemo(() => {
    if (!selectedTableKey) return null

    // Loop-only scope (no specific table chosen) — flat list of the source's
    // synthetic fields under a single "Loop metadata" group.
    if (selectedTableKey === LOOP_SCOPE_KEY) {
      const entries = (availableFields ?? []).map((f) => ({ kind: 'loop' as const, field: f }))
      return [{ label: sourceLabel ? `${sourceLabel} fields` : 'Loop metadata', entries }]
    }

    // System source scope (page / site / viewer / route).
    if (selectedTableKey.startsWith(SYSTEM_KEY_PREFIX)) {
      const sourceId = selectedTableKey.slice(SYSTEM_KEY_PREFIX.length) as SystemSourceId
      const source = SYSTEM_SOURCES.find((s) => s.id === sourceId)
      if (!source) return null
      const entries: FieldEntry[] = source.fields.map((f) => ({
        kind: 'system' as const,
        source: source.id,
        field: f,
      }))
      return [{ label: `${source.label} fields`, entries }]
    }

    const tableId = selectedTableKey.replace('table:', '')
    const table = meta?.tables.find((t) => t.id === tableId)
    if (!table) return null

    const tableEntries: FieldEntry[] = table.fields.map((f) => ({ kind: 'meta' as const, field: f }))
    const tableGroup: FieldGroup = { label: `${table.name} fields`, entries: tableEntries }

    // When auto-scoped to the loop's bound table, surface the loop's
    // synthetic source fields (authorName, permalink, publishedAt, etc.)
    // as a separate group so users can tell what came from THEIR table vs
    // what the loop adds automatically. Dedupe by field id and filter out
    // post-type-only synthetics for `kind: 'data'` tables.
    if (scopedTable && scopedTable.id === table.id && availableFields && availableFields.length > 0) {
      const tableFieldIds = new Set(table.fields.map((f) => f.id))
      const loopEntries: FieldEntry[] = availableFields
        .filter((f) => !tableFieldIds.has(f.id))
        .filter((f) => table.kind === 'postType' || !POST_TYPE_ONLY_LOOP_FIELDS.has(f.id))
        .map((f) => ({ kind: 'loop' as const, field: f }))
      if (loopEntries.length > 0) {
        return [tableGroup, { label: 'Loop metadata', entries: loopEntries }]
      }
    }
    return [tableGroup]
  }, [
    selectedTableKey,
    meta,
    availableFields,
    scopedTable,
    sourceLabel,
    POST_TYPE_ONLY_LOOP_FIELDS,
  ])

  // Apply the search filter to each group (dropping empty groups so the
  // section header doesn't render against zero rows).
  const filteredRightPaneGroups = useMemo(() => {
    if (!rightPaneGroups) return null
    const q = fieldSearch.trim().toLowerCase()
    if (!q) return rightPaneGroups
    return rightPaneGroups
      .map((g) => ({
        ...g,
        entries: g.entries.filter((entry) => {
          const label = entry.field.label.toLowerCase()
          const id = entry.field.id.toLowerCase()
          return label.includes(q) || id.includes(q)
        }),
      }))
      .filter((g) => g.entries.length > 0)
  }, [rightPaneGroups, fieldSearch])

  const allFieldsIncompatible = useMemo(() => {
    if (!rightPaneGroups || rightPaneGroups.length === 0) return false
    return rightPaneGroups.every((g) =>
      g.entries.every((entry) => {
        // System and loop fields share the same format-based compat rule.
        if (entry.kind === 'loop' || entry.kind === 'system') {
          return !loopFieldMatchesControl(entry.field, controlKind)
        }
        return !isFieldBindable(controlKind, entry.field)
      }),
    )
  }, [rightPaneGroups, controlKind])

  const totalRightPaneFieldCount = useMemo(
    () => rightPaneGroups?.reduce((sum, g) => sum + g.entries.length, 0) ?? 0,
    [rightPaneGroups],
  )

  // ─── Table lists for left pane ─────────────────────────────────────────
  const postTypeTables = useMemo(() => {
    if (!meta) return []
    const q = tableSearch.trim().toLowerCase()
    return meta.tables.filter((t) => t.kind === 'postType' && (!q || t.name.toLowerCase().includes(q)))
  }, [meta, tableSearch])

  const dataTables = useMemo(() => {
    if (!meta) return []
    const q = tableSearch.trim().toLowerCase()
    return meta.tables.filter((t) => t.kind === 'data' && (!q || t.name.toLowerCase().includes(q)))
  }, [meta, tableSearch])

  // ─── Handlers ──────────────────────────────────────────────────────────
  function handleTableSelect(key: string) {
    setSelectedTableKey(key)
    setFieldSearch('')
    setPendingBinding(null)
  }

  function handleMetaFieldClick(field: DataMetaField) {
    const format = deriveFormat(controlKind, field.type)
    setPendingBinding({
      source: 'currentEntry',
      field: field.id,
      ...(format !== undefined ? { format } : {}),
    })
  }

  function handleLoopFieldClick(field: LoopSourceField) {
    const format: DynamicPropBinding['format'] | undefined =
      field.format === 'html' ? 'html'
      : field.format === 'url' ? 'url'
      : field.format === 'media' ? 'media'
      : undefined
    setPendingBinding({
      source: 'currentEntry',
      field: field.id,
      ...(format !== undefined ? { format } : {}),
    })
  }

  function handleSystemFieldClick(source: SystemSourceId, field: LoopSourceField) {
    const format: DynamicPropBinding['format'] | undefined =
      field.format === 'html' ? 'html'
      : field.format === 'url' ? 'url'
      : field.format === 'media' ? 'media'
      : undefined
    setPendingBinding({
      source,
      field: field.id,
      ...(format !== undefined ? { format } : {}),
    })
  }

  function handleConfirm() {
    if (!pendingBinding) return
    onSet(pendingBinding)
  }

  function handleClose() {
    setPendingBinding(null)
    onClose()
  }

  // ─── Render helpers ────────────────────────────────────────────────────
  const isAutoScoped = scopedTable !== null
  // Distinguish auto-scope source for the chip copy: loop-bound vs. template-page.
  const isLoopTableScope = isAutoScoped && Boolean(loopTableId) && scopedTable?.id === loopTableId
  const autoScopeChipLabel = scopedTable
    ? isLoopTableScope
      ? `Loop row — ${scopedTable.name}`
      : `Current row — ${scopedTable.name}`
    : ''

  // Selection lives in `selectedTableKey` and starts with `system:` when
  // a system source is active. We surface that to the preview pane so
  // it can render the chosen frame's current value.
  const selectedSystemSourceId: SystemSourceId | null = useMemo(() => {
    if (!selectedTableKey?.startsWith(SYSTEM_KEY_PREFIX)) return null
    const id = selectedTableKey.slice(SYSTEM_KEY_PREFIX.length) as SystemSourceId
    return SYSTEM_SOURCES.some((s) => s.id === id) ? id : null
  }, [selectedTableKey])

  // The right preview pane is meaningful when:
  //   - the picker is auto-scoped to a loop-bound table (sample rows), OR
  //   - a system source is selected (page/site/viewer/route current value).
  const showPreviewPane = isLoopTableScope || selectedSystemSourceId !== null

  // What's "focused" in the field list — the field whose value we render
  // in the preview pane. Selection wins (sticky after click); hover is a
  // transient secondary signal. Fall back to the first bindable field so
  // the preview pane is never empty when there's data to show.
  const focusedFieldId: string | null = useMemo(() => {
    if (pendingBinding?.field) return pendingBinding.field
    if (hoveredFieldId) return hoveredFieldId
    const firstGroup = rightPaneGroups?.[0]
    return firstGroup?.entries[0]?.field.id ?? null
  }, [pendingBinding, hoveredFieldId, rightPaneGroups])

  const focusedEntry = useMemo<FieldEntry | null>(() => {
    if (!focusedFieldId || !rightPaneGroups) return null
    for (const group of rightPaneGroups) {
      const found = group.entries.find((e) => e.field.id === focusedFieldId)
      if (found) return found
    }
    return null
  }, [focusedFieldId, rightPaneGroups])

  function renderFieldRow(entry: FieldEntry): React.ReactNode {
    if (entry.kind === 'meta') {
      const { field } = entry
      const FieldIcon = getFieldIcon(field.type)
      const bindable = isFieldBindable(controlKind, field)
      const tooltip = !bindable
        ? `Cannot bind a ${field.type} field to a ${control.label} control`
        : undefined
      const isSelected = pendingBinding?.field === field.id
      // Hide id pill when it's just the slugified label — redundant noise.
      const showIdPill = field.id.toLowerCase() !== field.label.toLowerCase()

      return (
        <div
          key={field.id}
          onMouseEnter={() => setHoveredFieldId(field.id)}
          onMouseLeave={() => setHoveredFieldId((curr) => (curr === field.id ? null : curr))}
        >
          <Button
            variant="ghost"
            size="md"
            fullWidth
            align="start"
            pressed={isSelected}
            disabled={!bindable}
            tooltip={tooltip}
            onClick={() => { if (bindable) handleMetaFieldClick(field) }}
            onFocus={() => setHoveredFieldId(field.id)}
            type="button"
          >
            <span className={styles.fieldRowInner}>
              <span className={styles.fieldTypeIcon}>
                {field.type === 'media' && (field.mediaKind === 'video')
                  ? <VideoSolidIcon size={12} aria-hidden="true" />
                  : <FieldIcon size={12} aria-hidden="true" />
                }
              </span>
              <span className={styles.fieldRowText}>
                <span className={styles.fieldLabel}>{field.label}</span>
              </span>
              {showIdPill && <span className={styles.fieldId}>{field.id}</span>}
            </span>
          </Button>
        </div>
      )
    }

    // System source field (page / site / viewer / route).
    // Selection match requires BOTH source + field id because the same
    // field id ('id', 'slug') exists on multiple system sources.
    if (entry.kind === 'system') {
      const { source, field } = entry
      const bindable = loopFieldMatchesControl(field, controlKind)
      const tooltip = !bindable
        ? `Cannot bind this ${source} field to a ${control.label} control`
        : undefined
      const isSelected =
        pendingBinding?.source === source && pendingBinding?.field === field.id
      const showIdPill = field.id.toLowerCase() !== field.label.toLowerCase()

      return (
        <div
          key={`${source}.${field.id}`}
          onMouseEnter={() => setHoveredFieldId(field.id)}
          onMouseLeave={() => setHoveredFieldId((curr) => (curr === field.id ? null : curr))}
        >
          <Button
            variant="ghost"
            size="md"
            fullWidth
            align="start"
            pressed={isSelected}
            disabled={!bindable}
            tooltip={tooltip}
            onClick={() => { if (bindable) handleSystemFieldClick(source, field) }}
            onFocus={() => setHoveredFieldId(field.id)}
            type="button"
          >
            <span className={styles.fieldRowInner}>
              <span className={styles.fieldTypeIcon}>
                <LoopFieldIcon format={field.format} />
              </span>
              <span className={styles.fieldRowText}>
                <span className={styles.fieldLabel}>{field.label}</span>
              </span>
              {showIdPill && <span className={styles.fieldId}>{field.id}</span>}
            </span>
          </Button>
        </div>
      )
    }

    // Loop source field
    const { field } = entry
    const bindable = loopFieldMatchesControl(field, controlKind)
    const tooltip = !bindable
      ? `Cannot bind this loop field to a ${control.label} control`
      : undefined
    const isSelected = pendingBinding?.field === field.id
    const showIdPill = field.id.toLowerCase() !== field.label.toLowerCase()

    return (
      <div
        key={field.id}
        onMouseEnter={() => setHoveredFieldId(field.id)}
        onMouseLeave={() => setHoveredFieldId((curr) => (curr === field.id ? null : curr))}
      >
        <Button
          variant="ghost"
          size="md"
          fullWidth
          align="start"
          pressed={isSelected}
          disabled={!bindable}
          tooltip={tooltip}
          onClick={() => { if (bindable) handleLoopFieldClick(field) }}
          onFocus={() => setHoveredFieldId(field.id)}
          type="button"
        >
          <span className={styles.fieldRowInner}>
            <span className={styles.fieldTypeIcon}>
              <LoopFieldIcon format={field.format} />
            </span>
            <span className={styles.fieldRowText}>
              <span className={styles.fieldLabel}>{field.label}</span>
            </span>
            {showIdPill && <span className={styles.fieldId}>{field.id}</span>}
          </span>
        </Button>
      </div>
    )
  }

  // ─── Right pane content ────────────────────────────────────────────────
  function renderRightPane() {
    if (!selectedTableKey) {
      return (
        <div className={styles.pickerEmptyWrapper}>
          <EmptyState
            variant="centered"
            title="Select a source"
            description="Pick a source from the left — System for page / site / viewer / route data, or any of your tables."
          />
        </div>
      )
    }
    if (!filteredRightPaneGroups) {
      return (
        <div className={styles.pickerEmptyWrapper}>
          <EmptyState variant="centered" title="Table not found." />
        </div>
      )
    }
    const noMatches = filteredRightPaneGroups.length === 0 && fieldSearch
    // Section headers add visual noise when there's only one group AND no
    // separation to convey (e.g. a single table's fields, no loop overlay).
    // Render them only when there are at least two groups to distinguish.
    const showSectionHeaders = (rightPaneGroups?.length ?? 0) > 1

    return (
      <>
        <SearchBar
          value={fieldSearch}
          onValueChange={setFieldSearch}
          placeholder="Search fields…"
          className={styles.paneSearch}
          aria-label="Search fields"
        />
        <div className={styles.fieldList}>
          {allFieldsIncompatible && (
            <p className={styles.incompatibleHint}>
              No fields in this table are compatible with this control.
            </p>
          )}
          {noMatches ? (
            <EmptyState
              variant="card"
              title={`No fields match "${fieldSearch}"`}
            />
          ) : totalRightPaneFieldCount === 0 ? (
            <EmptyState variant="card" title="No fields available" />
          ) : (
            filteredRightPaneGroups.map((group) => (
              <div key={group.label} className={styles.fieldGroup}>
                {showSectionHeaders && (
                  <div className={styles.fieldGroupHeader}>
                    <span className={styles.fieldGroupHeaderText}>{group.label}</span>
                    <span className={styles.fieldGroupHeaderCount}>
                      {group.entries.length}
                    </span>
                  </div>
                )}
                {group.entries.map(renderFieldRow)}
              </div>
            ))
          )}
        </div>
      </>
    )
  }

  // ─── Left pane content ─────────────────────────────────────────────────
  function renderLeftPane() {
    const q = tableSearch.trim().toLowerCase()
    const visibleSystemSources: SystemSource[] = q
      ? SYSTEM_SOURCES.filter((s) => s.label.toLowerCase().includes(q) || s.id.includes(q))
      : [...SYSTEM_SOURCES]
    const hasSystem = visibleSystemSources.length > 0
    const hasPostTypes = postTypeTables.length > 0
    const hasDataTables = dataTables.length > 0
    const noResults =
      !hasLoopScope && !hasSystem && !hasPostTypes && !hasDataTables && tableSearch

    return (
      <div className={styles.tablePane}>
        <SearchBar
          value={tableSearch}
          onValueChange={setTableSearch}
          placeholder="Search sources…"
          className={styles.paneSearch}
          aria-label="Search sources"
        />
        <div className={styles.tableList}>
          {/* Loop scope entry */}
          {hasLoopScope && (
            <>
              <Button
                variant="ghost"
                size="sm"
                fullWidth
                align="start"
                pressed={selectedTableKey === LOOP_SCOPE_KEY}
                onClick={() => handleTableSelect(LOOP_SCOPE_KEY)}
                type="button"
              >
                <span className={styles.fieldRowInner}>
                  <span className={styles.tableRowIcon}>
                    <BracesIcon size={12} aria-hidden="true" />
                  </span>
                  <span>{sourceLabel ?? 'Current loop'}</span>
                </span>
              </Button>
              {(hasSystem || hasPostTypes || hasDataTables) && <Separator />}
            </>
          )}

          {/* System sources group — Page / Site / Viewer / Route. Always
              available since the publisher seeds these frames on every
              render; no DB lookup required to enumerate. */}
          {hasSystem && (
            <>
              <p className={styles.groupLabel}>System</p>
              {visibleSystemSources.map((source) => (
                <Button
                  key={source.id}
                  variant="ghost"
                  size="sm"
                  fullWidth
                  align="start"
                  pressed={selectedTableKey === systemKey(source.id)}
                  onClick={() => handleTableSelect(systemKey(source.id))}
                  type="button"
                  tooltip={source.description}
                >
                  <span className={styles.fieldRowInner}>
                    <span className={styles.tableRowIcon}>
                      <BracesIcon size={12} aria-hidden="true" />
                    </span>
                    <span>{source.label}</span>
                  </span>
                </Button>
              ))}
              {(hasPostTypes || hasDataTables) && <Separator />}
            </>
          )}

          {/* Post types group */}
          {hasPostTypes && (
            <>
              <p className={styles.groupLabel}>Post types</p>
              {postTypeTables.map((table) => (
                <Button
                  key={table.id}
                  variant="ghost"
                  size="sm"
                  fullWidth
                  align="start"
                  pressed={selectedTableKey === `table:${table.id}`}
                  onClick={() => handleTableSelect(`table:${table.id}`)}
                  type="button"
                >
                  <span className={styles.fieldRowInner}>
                    <span className={styles.tableRowIcon}>
                      <DatabaseSolidIcon size={12} aria-hidden="true" />
                    </span>
                    <span>{table.name}</span>
                  </span>
                </Button>
              ))}
            </>
          )}

          {/* Separator between groups */}
          {hasPostTypes && hasDataTables && <Separator />}

          {/* Data tables group */}
          {hasDataTables && (
            <>
              <p className={styles.groupLabel}>Data tables</p>
              {dataTables.map((table) => (
                <Button
                  key={table.id}
                  variant="ghost"
                  size="sm"
                  fullWidth
                  align="start"
                  pressed={selectedTableKey === `table:${table.id}`}
                  onClick={() => handleTableSelect(`table:${table.id}`)}
                  type="button"
                >
                  <span className={styles.fieldRowInner}>
                    <span className={styles.tableRowIcon}>
                      <DatabaseSolidIcon size={12} aria-hidden="true" />
                    </span>
                    <span>{table.name}</span>
                  </span>
                </Button>
              ))}
            </>
          )}

          {/* No results in search */}
          {noResults && (
            <EmptyState variant="card" title={`No tables match "${tableSearch}"`} />
          )}

          {/* No tables at all */}
          {!hasLoopScope && !hasPostTypes && !hasDataTables && !tableSearch && !metaLoading && (
            <EmptyState
              variant="card"
              title="No tables yet"
              description="Create a table in /data first."
            />
          )}
        </div>
      </div>
    )
  }

  // ─── Live preview pane ─────────────────────────────────────────────────
  // Right-hand pane shown when the picker is auto-scoped to a loop's
  // bound table, OR when a system source is selected. For the loop
  // case it renders the focused field's value across up to 3 sample
  // rows; for the system case it renders the focused field's current
  // value from the page/site/route frame.
  function renderPreviewPane() {
    // ── System source preview: render the current frame value ────────
    if (selectedSystemSourceId) {
      // Build the chosen frame from the in-memory site state. Anonymous
      // visitor preview for `viewer` until we surface the current admin
      // user — bindings against `viewer` resolve to empty in that case.
      const frame: Record<string, unknown> | null = (() => {
        if (selectedSystemSourceId === 'page') {
          return activePageForFrame
            ? (buildPageFrame(activePageForFrame) as unknown as Record<string, unknown>)
            : null
        }
        if (selectedSystemSourceId === 'site') {
          return activeSite
            ? (buildSiteFrame(activeSite) as unknown as Record<string, unknown>)
            : null
        }
        if (selectedSystemSourceId === 'viewer') {
          return null
        }
        if (selectedSystemSourceId === 'route') {
          return activePageForFrame
            ? (buildRouteFrame(buildPageFrame(activePageForFrame).permalink) as unknown as Record<string, unknown>)
            : null
        }
        return null
      })()

      if (!focusedEntry) {
        return (
          <div className={styles.previewPane}>
            <div className={styles.previewEmpty}>
              <EmptyState
                variant="centered"
                title="Hover a field"
                description="Pick a field on the left to see its current value."
              />
            </div>
          </div>
        )
      }

      const fieldId = focusedEntry.field.id
      const fieldLabel = focusedEntry.field.label

      return (
        <div className={styles.previewPane}>
          <div className={styles.previewHeader}>
            <span className={styles.previewHeaderLabel}>Current value</span>
            <span className={styles.previewHeaderField}>{fieldLabel}</span>
          </div>
          <div className={styles.previewBody}>
            <div className={styles.previewRow}>
              <div className={styles.previewRowMeta}>
                <span className={styles.previewRowIndex}>{selectedSystemSourceId}</span>
                <span className={styles.previewRowId}>{fieldId}</span>
              </div>
              <div className={styles.previewRowValue}>
                {frame
                  ? formatPreviewValue(frame[fieldId])
                  : selectedSystemSourceId === 'viewer'
                    ? '(anonymous — resolves at runtime)'
                    : '—'}
              </div>
            </div>
          </div>
        </div>
      )
    }

    // ── Loop preview: real published rows ────────────────────────────
    if (previewLoading && previewItems.length === 0) {
      return (
        <div className={styles.previewPane}>
          <div className={styles.loadingState} role="status" aria-label="Loading sample rows">
            <LoaderIcon size={16} aria-hidden="true" />
          </div>
        </div>
      )
    }

    if (previewItems.length === 0) {
      return (
        <div className={styles.previewPane}>
          <div className={styles.previewEmpty}>
            <EmptyState
              variant="centered"
              title="No rows yet"
              description={`Add a row to ${scopedTable?.name ?? 'this table'} to preview real values.`}
            />
          </div>
        </div>
      )
    }

    if (!focusedEntry) {
      return (
        <div className={styles.previewPane}>
          <div className={styles.previewEmpty}>
            <EmptyState
              variant="centered"
              title="Hover a field"
              description="The right pane previews real values from your first rows."
            />
          </div>
        </div>
      )
    }

    const fieldId = focusedEntry.field.id
    const fieldLabel = focusedEntry.field.label

    return (
      <div className={styles.previewPane}>
        <div className={styles.previewHeader}>
          <span className={styles.previewHeaderLabel}>Preview</span>
          <span className={styles.previewHeaderField}>{fieldLabel}</span>
        </div>
        <div className={styles.previewBody}>
          {previewItems.map((item, idx) => (
            <div key={item.id} className={styles.previewRow}>
              <div className={styles.previewRowMeta}>
                <span className={styles.previewRowIndex}>Row {idx + 1}</span>
                <span className={styles.previewRowId}>#{item.id.slice(0, 8)}</span>
              </div>
              <div className={styles.previewRowValue}>
                {formatPreviewValue(item.fields[fieldId])}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ─── Dialog body ───────────────────────────────────────────────────────
  function renderBody() {
    if (metaLoading) {
      return (
        <div className={styles.loadingState} role="status" aria-label="Loading data tables">
          <LoaderIcon size={16} aria-hidden="true" />
        </div>
      )
    }
    if (metaError) {
      return (
        <div className={styles.pickerEmptyWrapper}>
          <EmptyState variant="centered" title="Could not load tables" description={metaError} />
        </div>
      )
    }

    // Layout selection:
    //   - Loop-bound (showPreviewPane): two panes — fields | live preview.
    //   - Other auto-scoped (template page): single pane, no preview pane
    //     because there's no specific row to preview against here.
    //   - Default: two panes — table list | fields.
    const layoutClass = showPreviewPane
      ? styles.fieldsAndPreview
      : isAutoScoped
        ? styles.singlePane
        : styles.twoPanes

    return (
      <>
        {/* Auto-scope chip — shown whenever the left pane is hidden */}
        {isAutoScoped && scopedTable && (
          <div className={styles.scopeChip} aria-label={`Scoped to ${scopedTable.name}`}>
            <span className={styles.scopeChipDot} aria-hidden="true" />
            {autoScopeChipLabel}
          </div>
        )}

        <div className={layoutClass}>
          {!isAutoScoped && renderLeftPane()}
          <div className={styles.fieldPane}>
            {renderRightPane()}
          </div>
          {showPreviewPane && renderPreviewPane()}
        </div>
      </>
    )
  }

  const dialogTitle = insertMode ? `Insert into "${label}"` : `Bind "${label}"`
  const confirmLabel = insertMode ? 'Insert' : 'Confirm'

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={dialogTitle}
      // Width by layout:
      //  - Two-pane with preview (loop-bound) → xl, full 640px.
      //  - Two-pane default (table list + fields) → xl.
      //  - Single-pane (template-page auto-scope) → md, 440px.
      size={isAutoScoped && !showPreviewPane ? 'md' : 'xl'}
      bodyClassName={styles.dialogBody}
      footer={
        <>
          <Button variant="ghost" size="sm" type="button" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={handleConfirm}
            disabled={!pendingBinding}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {renderBody()}
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// DynamicBindingControl — main export
// ---------------------------------------------------------------------------

export function DynamicBindingControl({
  propKey,
  label,
  control,
  layout = 'inline',
  binding,
  onSet,
  onClear,
  insertMode = false,
  onInsertToken,
  availableFields,
  sourceLabel,
  loopTableId,
  children,
}: DynamicBindingControlProps) {
  const [dialogOpen, setDialogOpen] = useState(false)

  // Lazy initializer picks up already-cached meta so bound-state labels are
  // immediately resolved without needing an initial synchronous setState.
  const [resolvedMeta, setResolvedMeta] = useState<DataMeta | null>(() => _cachedMeta)
  useEffect(() => {
    if (_cachedMeta) return // already in state via lazy initializer
    // Pre-load meta so bound-state labels resolve on next render.
    loadDataMeta()
      .then((m) => setResolvedMeta(m))
      .catch(() => { /* ignore — label falls back to field id */ })
  }, [])

  // ── Bound state (legacy single-binding only) ────────────────────────────
  // In insert mode the binding lives inline in the prop value as a token,
  // so we never enter this branch — the children render normally and
  // tokens appear in the text input as ordinary characters.
  if (binding && !insertMode) {
    const bindingLabel = resolveBindingLabel(binding, availableFields, sourceLabel, resolvedMeta)
    return (
      <div
        className={cn(
          styles.boundWrapper,
          layout === 'stacked' && styles.boundWrapperStacked,
        )}
        data-bound="true"
      >
        <div className={controlStyles.labelRow}>
          <label>{label}</label>
        </div>
        <div className={styles.boundValueRow}>
          <Button
            variant="ghost"
            size="md"
            className={styles.boundValueDisplay}
            aria-label={bindingLabel}
            type="button"
          >
            {bindingLabel}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label={`Remove binding for ${label}`}
            tooltip={`Remove binding for ${label}`}
            onClick={onClear}
            type="button"
          >
            <CloseIcon size={11} aria-hidden="true" />
          </Button>
        </div>
      </div>
    )
  }

  // ── Unbound state — render children with BracesIcon affordance ──────────
  return (
    <>
      <div className={styles.affordanceWrapper} data-prop-key={propKey}>
        {children}
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          className={styles.affordanceBtn}
          aria-label={insertMode ? `Insert binding for ${label}` : `Bind ${label}`}
          tooltip={insertMode ? 'Insert data token' : 'Bind to data field'}
          onClick={() => setDialogOpen(true)}
          type="button"
        >
          <BracesIcon size={11} aria-hidden="true" />
        </Button>
      </div>

      <BindingPickerDialog
        open={dialogOpen}
        label={label}
        control={control}
        availableFields={availableFields}
        sourceLabel={sourceLabel}
        loopTableId={loopTableId}
        insertMode={insertMode}
        onClose={() => setDialogOpen(false)}
        onSet={(b) => {
          if (insertMode && onInsertToken) {
            onInsertToken(bindingToToken(b.source, b.field))
          } else {
            onSet(b)
          }
          setDialogOpen(false)
        }}
      />
    </>
  )
}
