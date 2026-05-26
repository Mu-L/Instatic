/**
 * BindingPickerDialog — the single-pane DataMeta picker.
 *
 * One scrollable column with grouped sections. Everything reachable in the
 * current scope is visible at once — no hidden left-pane source switcher,
 * no preview pane to scrub, no "which category is selected" ambiguity.
 * The only selectable thing is an individual field row, which uses
 * `pressed` for an unambiguous selected state.
 *
 * Groups, in order:
 *   1. Auto-scoped table fields (template page or loop-bound table)
 *   2. Loop metadata (synthetic fields not already in the table)
 *   3. System sources (Page / Site / Route) — one group per source
 *
 * DataMeta is fetched once and cached module-level in `./cache.ts`.
 */

import { useEffect, useMemo, useState } from 'react'
import type { PropertyControl } from '@core/module-engine/types'
import type { DynamicPropBinding } from '@core/page-tree'
import type { LoopItem, LoopSourceField } from '@core/loops/types'
import type { DataMeta, DataMetaField, DataMetaTable } from '@core/data/schemas'
import { useEditorStore, selectActivePage } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { EmptyState } from '@ui/components/EmptyState'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { getFieldIcon } from '@admin/pages/data/utils/fieldIcons'
import { isFieldBindable, type PropertyControlKind } from '../bindingCompatibility'
import { _cachedMeta, loadDataMeta } from './cache'
import { SYSTEM_SOURCES, type SystemSourceId } from '../systemSources'
import {
  buildPageFrame,
  buildSiteFrame,
  buildRouteFrame,
} from '@core/templates/contextFrames'
import { getCmsDataTable, previewCmsDataLoopItems } from '@core/persistence/cmsData'
import { dataTablePreviewToLoopItem } from '@core/templates/templatePreviewData'
import {
  deriveFormat,
  formatPreviewValue,
  loopFieldFormat,
  loopFieldMatchesControl,
  type FieldEntry,
  type FieldGroup,
} from './helpers'
import styles from './DynamicBindingControl.module.css'

// ---------------------------------------------------------------------------
// Icons for loop / system source field formats
//
// Resolved at module load (not inside the component) so the linter does not
// flag them as "components created during render".
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

// Loop synthetic fields that only make sense on `postType` tables. Hidden
// from the loop-metadata group when scoped to a `kind: 'data'` table (no
// body, featured media, SEO, etc.).
const POST_TYPE_ONLY_LOOP_FIELDS = new Set([
  'title',
  'body',
  'featuredMedia',
  'firstImage',
  'seoTitle',
  'seoDescription',
])

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

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

  // ─── Active page template for auto-scope + frame data ─────────────────
  const activePageTableSlug = useEditorStore((s) => {
    const page = selectActivePage(s)
    return page?.template?.tableSlug ?? null
  })

  // Live page/site frames for the per-row value preview. Read off the
  // store so the preview shows the same values bindings will resolve to
  // on the actual page.
  const activePageForFrame = useEditorStore(selectActivePage)
  const activeSite = useEditorStore((s) => s.site)

  const pageFrame = useMemo(
    () => (activePageForFrame ? buildPageFrame(activePageForFrame) : null),
    [activePageForFrame],
  )
  const siteFrame = useMemo(
    () => (activeSite ? buildSiteFrame(activeSite) : null),
    [activeSite],
  )
  const routeFrame = useMemo(
    () => (pageFrame ? buildRouteFrame(pageFrame.permalink) : null),
    [pageFrame],
  )

  // Auto-scope precedence:
  //   1. `loopTableId` (Loop bound to a specific data table) — most specific.
  //   2. `activePageTableSlug` (template page) — currentEntry resolves
  //      against this table.
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

  // Loop scope without a specific table — synthetic fields only.
  const hasLoopOnlyScope = !scopedTable && (availableFields?.length ?? 0) > 0

  // ─── Selection state ───────────────────────────────────────────────────
  // The only selection is which field is pending — there's no source/category
  // toggle anymore, so this is the single source of truth for "what would
  // I confirm right now?".
  const [pendingBinding, setPendingBinding] = useState<DynamicPropBinding | null>(null)

  // Reset selection when the dialog opens.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    setPendingBinding(null)
  }, [open])

  // ─── currentEntry preview item ─────────────────────────────────────────
  // The value shown on each row for `currentEntry.X` bindings comes from
  // this LoopItem. Resolution priority:
  //   1. Loop-bound table — fetch the most recent published row so the
  //      preview matches what real iterations will render.
  //   2. Template-page scope — synthesize from the table's field
  //      definitions so the preview is sensible even before any row is
  //      published (titles like "Example Post Title", etc.).
  //   3. Loop-bound with no published rows — fall back to (2).
  const [currentEntryItem, setCurrentEntryItem] = useState<LoopItem | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !scopedTable) {
      setCurrentEntryItem(null)
      return
    }
    let cancelled = false
    const tableId = scopedTable.id

    async function load() {
      // Loop-bound table → prefer real rows.
      if (loopTableId === tableId) {
        try {
          const result = await previewCmsDataLoopItems(tableId, {
            limit: 1,
            orderBy: 'publishedAt',
            direction: 'desc',
          })
          if (cancelled) return
          if (result.items.length > 0) {
            setCurrentEntryItem(result.items[0] ?? null)
            return
          }
        } catch {
          if (cancelled) return
          // fall through to synthetic
        }
      }
      // Template-page scope (or loop fallback) → synthetic preview from
      // the full DataTable schema.
      try {
        const table = await getCmsDataTable(tableId)
        if (cancelled || !table) return
        setCurrentEntryItem(dataTablePreviewToLoopItem(table))
      } catch {
        if (cancelled) return
        setCurrentEntryItem(null)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [open, scopedTable, loopTableId])

  // ─── Field list assembly ───────────────────────────────────────────────
  const controlKind = control.type as PropertyControlKind

  // All applicable groups, top to bottom. Computed once based on context —
  // no source-selection step in between. Authors see every reachable
  // binding at once and just click the one they want.
  const groups: FieldGroup[] = useMemo(() => {
    const result: FieldGroup[] = []

    // 1. Scoped table fields — leads when auto-scoped.
    if (scopedTable) {
      const tableEntries: FieldEntry[] = scopedTable.fields.map((f) => ({
        kind: 'meta' as const,
        field: f,
      }))
      result.push({ label: `${scopedTable.name} fields`, entries: tableEntries })

      // Loop synthetics not already present in the table.
      if (availableFields && availableFields.length > 0) {
        const tableFieldIds = new Set(scopedTable.fields.map((f) => f.id))
        const loopEntries: FieldEntry[] = availableFields
          .filter((f) => !tableFieldIds.has(f.id))
          .filter(
            (f) =>
              scopedTable.kind === 'postType' || !POST_TYPE_ONLY_LOOP_FIELDS.has(f.id),
          )
          .map((f) => ({ kind: 'loop' as const, field: f }))
        if (loopEntries.length > 0) {
          result.push({ label: 'Loop metadata', entries: loopEntries })
        }
      }
    } else if (hasLoopOnlyScope) {
      // 2. Loop-only scope — synthetic fields directly.
      const loopEntries: FieldEntry[] = (availableFields ?? []).map((f) => ({
        kind: 'loop' as const,
        field: f,
      }))
      result.push({
        label: sourceLabel ? `${sourceLabel} fields` : 'Loop metadata',
        entries: loopEntries,
      })
    }

    // 3. System sources — Page / Site / Route. Always visible (and always
    // reachable) since the publisher seeds these frames on every render.
    for (const source of SYSTEM_SOURCES) {
      const entries: FieldEntry[] = source.fields.map((f) => ({
        kind: 'system' as const,
        source: source.id,
        field: f,
      }))
      result.push({ label: source.label, entries })
    }

    return result
  }, [scopedTable, availableFields, hasLoopOnlyScope, sourceLabel])

  // Compatibility check across the entire list — used to show the "no
  // compatible fields" hint when an aggressive control type (image / media)
  // lands in a scope that has no media fields anywhere.
  const allFieldsIncompatible = useMemo(() => {
    if (groups.length === 0) return false
    return groups.every((g) =>
      g.entries.every((entry) => {
        if (entry.kind === 'loop' || entry.kind === 'system') {
          return !loopFieldMatchesControl(entry.field, controlKind)
        }
        return !isFieldBindable(controlKind, entry.field)
      }),
    )
  }, [groups, controlKind])

  // ─── Table existence (for the footer hint) ─────────────────────────────
  // When there are tables in the system but the current scope can't reach
  // them, surface the loop / template workflow as guidance.
  const tablesExist = (meta?.tables.length ?? 0) > 0
  const showWorkflowHint = !scopedTable && !hasLoopOnlyScope && tablesExist

  // ─── Handlers ──────────────────────────────────────────────────────────
  function handleMetaFieldClick(field: DataMetaField) {
    const format = deriveFormat(controlKind, field.type)
    setPendingBinding({
      source: 'currentEntry',
      field: field.id,
      ...(format !== undefined ? { format } : {}),
    })
  }

  function handleLoopFieldClick(field: LoopSourceField) {
    const format = loopFieldFormat(field.format)
    setPendingBinding({
      source: 'currentEntry',
      field: field.id,
      ...(format !== undefined ? { format } : {}),
    })
  }

  function handleSystemFieldClick(source: SystemSourceId, field: LoopSourceField) {
    const format = loopFieldFormat(field.format)
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

  // ─── Per-row value preview ─────────────────────────────────────────────
  // Resolves the value each binding would render against the current
  // page/site/route + the scoped table's preview row. Used for the
  // right-side pill on every field so authors see what the binding would
  // actually produce — not the field id.
  function getFieldPreviewValue(entry: FieldEntry): unknown {
    if (entry.kind === 'system') {
      const frame =
        entry.source === 'page'
          ? pageFrame
          : entry.source === 'site'
            ? siteFrame
            : entry.source === 'route'
              ? routeFrame
              : null
      if (!frame) return undefined
      return (frame as unknown as Record<string, unknown>)[entry.field.id]
    }
    // meta or loop — resolves against currentEntry (preview item).
    return currentEntryItem?.fields[entry.field.id]
  }

  // ─── Auto-scope chip ───────────────────────────────────────────────────
  const isAutoScoped = scopedTable !== null
  const isLoopTableScope =
    isAutoScoped && Boolean(loopTableId) && scopedTable?.id === loopTableId
  const autoScopeChipLabel = scopedTable
    ? isLoopTableScope
      ? `Loop row — ${scopedTable.name}`
      : `Current row — ${scopedTable.name}`
    : ''

  // ─── Render: single field row ──────────────────────────────────────────
  function renderFieldRow(entry: FieldEntry): React.ReactNode {
    if (entry.kind === 'meta') {
      const { field } = entry
      const FieldIcon = getFieldIcon(field.type)
      const bindable = isFieldBindable(controlKind, field)
      const tooltip = !bindable
        ? `Cannot bind a ${field.type} field to a ${control.label} control`
        : undefined
      const isSelected = pendingBinding?.field === field.id && pendingBinding?.source === 'currentEntry'
      const rawValue = getFieldPreviewValue(entry)
      const previewText = formatPreviewValue(rawValue)

      return (
        <Button
          key={field.id}
          variant="ghost"
          size="md"
          fullWidth
          align="start"
          pressed={isSelected}
          disabled={!bindable}
          tooltip={tooltip}
          onClick={() => {
            if (bindable) handleMetaFieldClick(field)
          }}
          type="button"
        >
          <span className={styles.fieldRowInner}>
            <span className={styles.fieldTypeIcon}>
              {field.type === 'media' && field.mediaKind === 'video' ? (
                <VideoSolidIcon size={12} aria-hidden="true" />
              ) : (
                <FieldIcon size={12} aria-hidden="true" />
              )}
            </span>
            <span className={styles.fieldRowText}>
              <span className={styles.fieldLabel}>{field.label}</span>
            </span>
            <span className={styles.fieldValue} title={previewText}>{previewText}</span>
          </span>
        </Button>
      )
    }

    if (entry.kind === 'system') {
      const { source, field } = entry
      const bindable = loopFieldMatchesControl(field, controlKind)
      const tooltip = !bindable
        ? `Cannot bind this ${source} field to a ${control.label} control`
        : undefined
      // Selection match requires BOTH source + field id because the same
      // field id ('id', 'slug') exists on multiple system sources.
      const isSelected =
        pendingBinding?.source === source && pendingBinding?.field === field.id
      const rawValue = getFieldPreviewValue(entry)
      const previewText = formatPreviewValue(rawValue)

      return (
        <Button
          key={`${source}.${field.id}`}
          variant="ghost"
          size="md"
          fullWidth
          align="start"
          pressed={isSelected}
          disabled={!bindable}
          tooltip={tooltip}
          onClick={() => {
            if (bindable) handleSystemFieldClick(source, field)
          }}
          type="button"
        >
          <span className={styles.fieldRowInner}>
            <span className={styles.fieldTypeIcon}>
              <LoopFieldIcon format={field.format} />
            </span>
            <span className={styles.fieldRowText}>
              <span className={styles.fieldLabel}>{field.label}</span>
            </span>
            <span className={styles.fieldValue} title={previewText}>{previewText}</span>
          </span>
        </Button>
      )
    }

    // Loop source field.
    const { field } = entry
    const bindable = loopFieldMatchesControl(field, controlKind)
    const tooltip = !bindable
      ? `Cannot bind this loop field to a ${control.label} control`
      : undefined
    const isSelected =
      pendingBinding?.field === field.id && pendingBinding?.source === 'currentEntry'
    const rawValue = getFieldPreviewValue(entry)
    const previewText = formatPreviewValue(rawValue)

    return (
      <Button
        key={`loop.${field.id}`}
        variant="ghost"
        size="md"
        fullWidth
        align="start"
        pressed={isSelected}
        disabled={!bindable}
        tooltip={tooltip}
        onClick={() => {
          if (bindable) handleLoopFieldClick(field)
        }}
        type="button"
      >
        <span className={styles.fieldRowInner}>
          <span className={styles.fieldTypeIcon}>
            <LoopFieldIcon format={field.format} />
          </span>
          <span className={styles.fieldRowText}>
            <span className={styles.fieldLabel}>{field.label}</span>
          </span>
          <span className={styles.fieldValue} title={previewText}>{previewText}</span>
        </span>
      </Button>
    )
  }

  // ─── Render: the full body ─────────────────────────────────────────────
  function renderBody() {
    if (metaLoading) {
      return <SkeletonBlock minHeight={200} ariaLabel="Loading data tables" />
    }
    if (metaError) {
      return (
        <div className={styles.pickerEmptyWrapper}>
          <EmptyState
            variant="centered"
            title="Could not load tables"
            description={metaError}
          />
        </div>
      )
    }

    return (
      <>
        {/* Auto-scope chip — shown whenever we have a specific table scope */}
        {isAutoScoped && scopedTable && (
          <div
            className={styles.scopeChip}
            aria-label={`Scoped to ${scopedTable.name}`}
          >
            <span className={styles.scopeChipDot} aria-hidden="true" />
            {autoScopeChipLabel}
          </div>
        )}

        <div className={styles.fieldList}>
          {allFieldsIncompatible && (
            <p className={styles.incompatibleHint}>
              No fields in the available sources are compatible with this control.
            </p>
          )}
          {groups.map((group) => (
            <div key={group.label} className={styles.fieldGroup}>
              <div className={styles.fieldGroupHeader}>
                <span className={styles.fieldGroupHeaderText}>{group.label}</span>
                <span className={styles.fieldGroupHeaderCount}>
                  {group.entries.length}
                </span>
              </div>
              {group.entries.map(renderFieldRow)}
            </div>
          ))}
        </div>

        {/* Subtle footer hint pointing at the loop / template workflow
            when there are tables in the system but the current node can't
            bind to them. Lives outside the scrolling list so it doesn't
            compete with the field rows above. */}
        {showWorkflowHint && (
          <p className={styles.subtleHint}>
            Wrap in a Loop or open a postType template to bind to row fields.
          </p>
        )}
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
      size="md"
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
