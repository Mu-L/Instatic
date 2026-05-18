/**
 * FieldsSection — the "Fields" block rendered inside TableSettings.
 *
 * Moved from the former standalone FieldEditor.tsx and merged here so the
 * inspector has a single-panel settings view instead of a three-mode dispatch.
 *
 * PostType field guards (FIX 2):
 *   - Mandatory built-ins (title, slug): locked rows — no edit/delete.
 *   - Optional built-ins (body, featuredMedia, seoTitle, seoDescription):
 *     deletable (remove from table); editable for description/required only.
 *   - Custom non-built-in fields: fully editable and deletable.
 *
 * Deletion goes through `useConfirmDelete` instead of bespoke inline confirm.
 */
import { memo, useState } from 'react'
import type { ReactElement, DragEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Input, Textarea } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Switch } from '@ui/components/Switch'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { DragAndDropSolidIcon } from 'pixel-art-icons/icons/drag-and-drop-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { NewFieldDialog } from '@admin/pages/data/components/NewFieldDialog/NewFieldDialog'
import { getFieldIcon } from '@admin/pages/data/utils/fieldIcons'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import {
  POST_TYPE_MANDATORY_FIELD_IDS,
  POST_TYPE_OPTIONAL_BUILTIN_FIELD_IDS,
  type DataField,
  type DataFieldType,
  type DataSelectOption,
  type DataTable,
  type UpdateDataTableInput,
} from '@core/data/schemas'
import { isPostTypeBuiltInFieldId } from '@core/data/fields'
import styles from './DataInspector.module.css'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FieldsSectionProps {
  table: DataTable
  tables: DataTable[]
  /** Total row count — used in the field-delete confirmation message. */
  rowCount: number
  onUpdateTable: (input: UpdateDataTableInput) => Promise<DataTable>
  canEdit: boolean
}

interface DraftOption {
  id: string
  label: string
  value: string
}

interface FieldEditState {
  label: string
  required: boolean
  description: string
  // text
  textMaxLength: string
  textPlaceholder: string
  // richText
  richTextFormat: 'markdown' | 'html'
  // number
  numberMin: string
  numberMax: string
  numberStep: string
  numberInteger: boolean
  numberFormat: 'number' | 'currency' | 'percent'
  numberCurrency: string
  // boolean
  booleanDefault: boolean
  // select / multiSelect
  selectOptions: DraftOption[]
  // media
  mediaKind: 'image' | 'video' | 'any'
  mediaAllowMultiple: boolean
  // relation
  relationAllowMultiple: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RICH_TEXT_FORMAT_OPTIONS = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'html', label: 'HTML' },
]

const NUMBER_FORMAT_OPTIONS = [
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'percent', label: 'Percent' },
]

const MEDIA_KIND_OPTIONS = [
  { value: 'any', label: 'Any' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
]

const FIELD_TYPE_LABELS: Record<DataFieldType, string> = {
  text: 'Text',
  longText: 'Long text',
  richText: 'Rich text',
  number: 'Number',
  boolean: 'Boolean',
  date: 'Date',
  dateTime: 'Date & time',
  select: 'Select',
  multiSelect: 'Multi-select',
  url: 'URL',
  email: 'Email',
  media: 'Media',
  relation: 'Relation',
}

// ---------------------------------------------------------------------------
// PostType field classification helpers
// ---------------------------------------------------------------------------

function isMandatoryField(fieldId: string): boolean {
  return (POST_TYPE_MANDATORY_FIELD_IDS as readonly string[]).includes(fieldId)
}

function isOptionalBuiltIn(field: DataField): boolean {
  return field.builtIn === true && !isMandatoryField(field.id)
}

/** Whether a field can be deleted from its table. */
function isFieldDeletable(field: DataField, table: DataTable): boolean {
  if (field.id === table.primaryFieldId) return false
  if (table.kind === 'postType' && isMandatoryField(field.id)) return false
  return true
}

/** Tooltip text for a disabled delete button, if applicable. */
function deleteTooltip(field: DataField, table: DataTable): string | undefined {
  if (field.id === table.primaryFieldId) return 'Cannot delete the primary field'
  if (table.kind === 'postType' && isMandatoryField(field.id)) {
    return 'Required by all post types — cannot be deleted'
  }
  return undefined
}

/** Whether the label input should be locked for this field. */
function isLabelLocked(field: DataField, table: DataTable): boolean {
  return table.kind === 'postType' && isPostTypeBuiltInFieldId(field.id)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugifyOptionValue(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function makeOption(label: string): DraftOption {
  return { id: crypto.randomUUID(), label, value: slugifyOptionValue(label) }
}

function fieldToEditState(field: DataField): FieldEditState {
  return {
    label: field.label,
    required: field.required ?? false,
    description: field.description ?? '',
    textMaxLength: field.type === 'text' ? (field.maxLength?.toString() ?? '') : '',
    textPlaceholder: field.type === 'text' ? (field.placeholder ?? '') : '',
    richTextFormat: field.type === 'richText' ? field.format : 'markdown',
    numberMin: field.type === 'number' ? (field.min?.toString() ?? '') : '',
    numberMax: field.type === 'number' ? (field.max?.toString() ?? '') : '',
    numberStep: field.type === 'number' ? (field.step?.toString() ?? '') : '',
    numberInteger: field.type === 'number' ? (field.integer ?? false) : false,
    numberFormat: field.type === 'number' ? (field.format ?? 'number') : 'number',
    numberCurrency: field.type === 'number' ? (field.currency ?? '') : '',
    booleanDefault: field.type === 'boolean' ? (field.defaultValue ?? false) : false,
    selectOptions:
      field.type === 'select' || field.type === 'multiSelect'
        ? field.options.map((o) => ({ id: o.id, label: o.label, value: o.value }))
        : [makeOption('')],
    mediaKind: field.type === 'media' ? (field.mediaKind ?? 'any') : 'any',
    mediaAllowMultiple: field.type === 'media' ? (field.allowMultiple ?? false) : false,
    relationAllowMultiple: field.type === 'relation' ? (field.allowMultiple ?? false) : false,
  }
}

function applyEditState(field: DataField, state: FieldEditState, labelLocked: boolean): DataField {
  const common = {
    id: field.id,
    label: labelLocked ? field.label : (state.label.trim() || field.label),
    ...(state.required ? { required: true as const } : {}),
    ...(state.description.trim() ? { description: state.description.trim() } : {}),
    ...(field.builtIn ? { builtIn: true as const } : {}),
  }

  switch (field.type) {
    case 'text':
      return {
        type: 'text',
        ...common,
        ...(state.textMaxLength ? { maxLength: Number(state.textMaxLength) } : {}),
        ...(state.textPlaceholder.trim() ? { placeholder: state.textPlaceholder.trim() } : {}),
      }
    case 'longText':
      return { type: 'longText', ...common }
    case 'richText':
      return { type: 'richText', ...common, format: state.richTextFormat }
    case 'number':
      return {
        type: 'number',
        ...common,
        ...(state.numberMin !== '' ? { min: Number(state.numberMin) } : {}),
        ...(state.numberMax !== '' ? { max: Number(state.numberMax) } : {}),
        ...(state.numberStep !== '' ? { step: Number(state.numberStep) } : {}),
        ...(state.numberInteger ? { integer: true as const } : {}),
        ...(state.numberFormat !== 'number' ? { format: state.numberFormat } : {}),
        ...(state.numberFormat === 'currency' && state.numberCurrency.trim()
          ? { currency: state.numberCurrency.trim() }
          : {}),
      }
    case 'boolean':
      return {
        type: 'boolean',
        ...common,
        ...(state.booleanDefault ? { defaultValue: true as const } : {}),
      }
    case 'date':
      return { type: 'date', ...common }
    case 'dateTime':
      return { type: 'dateTime', ...common }
    case 'select': {
      const options: DataSelectOption[] = state.selectOptions
        .filter((o) => o.label.trim())
        .map((o) => ({
          id: o.id,
          label: o.label.trim(),
          value: o.value || slugifyOptionValue(o.label),
        }))
      return { type: 'select', ...common, options }
    }
    case 'multiSelect': {
      const options: DataSelectOption[] = state.selectOptions
        .filter((o) => o.label.trim())
        .map((o) => ({
          id: o.id,
          label: o.label.trim(),
          value: o.value || slugifyOptionValue(o.label),
        }))
      return { type: 'multiSelect', ...common, options }
    }
    case 'url':
      return { type: 'url', ...common }
    case 'email':
      return { type: 'email', ...common }
    case 'media':
      return {
        type: 'media',
        ...common,
        ...(state.mediaKind !== 'any' ? { mediaKind: state.mediaKind } : {}),
        ...(state.mediaAllowMultiple ? { allowMultiple: true as const } : {}),
      }
    case 'relation':
      return {
        type: 'relation',
        ...common,
        targetTableId: field.targetTableId,
        ...(state.relationAllowMultiple ? { allowMultiple: true as const } : {}),
      }
    default: {
      const _exhaustive: never = field
      void _exhaustive
      return field
    }
  }
}

// ---------------------------------------------------------------------------
// FieldEditForm — inline panel rendered below the field row
// ---------------------------------------------------------------------------

interface FieldEditFormProps {
  field: DataField
  tables: DataTable[]
  state: FieldEditState
  saving: boolean
  error: string | null
  /** When true, label input is disabled (built-in postType fields). */
  labelLocked: boolean
  onChange: <K extends keyof FieldEditState>(key: K, value: FieldEditState[K]) => void
  onOptionUpdate: (index: number, patch: Partial<DraftOption>) => void
  onOptionRemove: (index: number) => void
  onOptionAdd: () => void
  onSave: () => void
  onCancel: () => void
}

function FieldEditForm({
  field,
  tables,
  state,
  saving,
  error,
  labelLocked,
  onChange,
  onOptionUpdate,
  onOptionRemove,
  onOptionAdd,
  onSave,
  onCancel,
}: FieldEditFormProps): ReactElement {
  const tableOptions = tables.map((t) => ({ value: t.id, label: t.name }))

  return (
    <div className={styles.fieldEditForm}>
      {/* Type — read only */}
      <div className={styles.fieldEditTypeRow}>
        <span className={styles.fieldEditTypeLabel}>Type:</span>
        <span className={styles.fieldEditTypeValue}>{FIELD_TYPE_LABELS[field.type]}</span>
        <span className={styles.fieldEditTypeNote}>(cannot be changed)</span>
      </div>

      {/* Label */}
      <label className={styles.formGroup}>
        <span className={styles.label}>
          Label
          {labelLocked && (
            <span className={styles.optional}> (locked)</span>
          )}
        </span>
        <Input
          fieldSize="sm"
          value={state.label}
          disabled={labelLocked}
          onChange={(e) => onChange('label', e.target.value)}
          autoComplete="off"
        />
      </label>

      {/* Required */}
      <div className={styles.switchRow}>
        <span className={styles.switchLabel}>Required</span>
        <Switch
          checked={state.required}
          onCheckedChange={(v) => onChange('required', v)}
        />
      </div>

      {/* Description */}
      <label className={styles.formGroup}>
        <span className={styles.label}>
          Description <span className={styles.optional}>(optional)</span>
        </span>
        <Textarea
          fieldSize="sm"
          value={state.description}
          onChange={(e) => onChange('description', e.target.value)}
          placeholder="Shown next to the field in the editor"
          rows={2}
        />
      </label>

      {/* ── Type-specific (hidden for locked built-ins) ── */}

      {!labelLocked && field.type === 'text' && (
        <>
          <label className={styles.formGroup}>
            <span className={styles.label}>
              Max length <span className={styles.optional}>(optional)</span>
            </span>
            <Input
              fieldSize="sm"
              type="number"
              value={state.textMaxLength}
              onChange={(e) => onChange('textMaxLength', e.target.value)}
              placeholder="255"
              min={1}
            />
          </label>
          <label className={styles.formGroup}>
            <span className={styles.label}>
              Placeholder <span className={styles.optional}>(optional)</span>
            </span>
            <Input
              fieldSize="sm"
              value={state.textPlaceholder}
              onChange={(e) => onChange('textPlaceholder', e.target.value)}
              placeholder="Enter a value…"
            />
          </label>
        </>
      )}

      {!labelLocked && field.type === 'richText' && (
        <div className={styles.formGroup}>
          <span className={styles.label}>Format</span>
          <Select
            fieldSize="sm"
            value={state.richTextFormat}
            options={RICH_TEXT_FORMAT_OPTIONS}
            onChange={(e) => onChange('richTextFormat', e.target.value as 'markdown' | 'html')}
          />
        </div>
      )}

      {!labelLocked && field.type === 'number' && (
        <>
          <div className={styles.fieldRow3Col}>
            <label className={styles.formGroup}>
              <span className={styles.label}>Min</span>
              <Input
                fieldSize="sm"
                type="number"
                value={state.numberMin}
                onChange={(e) => onChange('numberMin', e.target.value)}
              />
            </label>
            <label className={styles.formGroup}>
              <span className={styles.label}>Max</span>
              <Input
                fieldSize="sm"
                type="number"
                value={state.numberMax}
                onChange={(e) => onChange('numberMax', e.target.value)}
              />
            </label>
            <label className={styles.formGroup}>
              <span className={styles.label}>Step</span>
              <Input
                fieldSize="sm"
                type="number"
                value={state.numberStep}
                onChange={(e) => onChange('numberStep', e.target.value)}
              />
            </label>
          </div>
          <div className={styles.switchRow}>
            <span className={styles.switchLabel}>Integer only</span>
            <Switch
              checked={state.numberInteger}
              onCheckedChange={(v) => onChange('numberInteger', v)}
            />
          </div>
          <div className={styles.formGroup}>
            <span className={styles.label}>Format</span>
            <Select
              fieldSize="sm"
              value={state.numberFormat}
              options={NUMBER_FORMAT_OPTIONS}
              onChange={(e) =>
                onChange('numberFormat', e.target.value as 'number' | 'currency' | 'percent')
              }
            />
          </div>
          {state.numberFormat === 'currency' && (
            <label className={styles.formGroup}>
              <span className={styles.label}>
                Currency code <span className={styles.optional}>(e.g. USD)</span>
              </span>
              <Input
                fieldSize="sm"
                value={state.numberCurrency}
                onChange={(e) => onChange('numberCurrency', e.target.value)}
                placeholder="USD"
                maxLength={10}
              />
            </label>
          )}
        </>
      )}

      {!labelLocked && field.type === 'boolean' && (
        <div className={styles.switchRow}>
          <span className={styles.switchLabel}>Default value</span>
          <Switch
            checked={state.booleanDefault}
            onCheckedChange={(v) => onChange('booleanDefault', v)}
          />
        </div>
      )}

      {!labelLocked && (field.type === 'select' || field.type === 'multiSelect') && (
        <div className={styles.formGroup}>
          <span className={styles.label}>Options</span>
          <div className={styles.optionList}>
            {state.selectOptions.map((opt, index) => (
              <div key={opt.id} className={styles.optionRow}>
                <Input
                  fieldSize="sm"
                  value={opt.label}
                  onChange={(e) => onOptionUpdate(index, { label: e.target.value })}
                  placeholder="Label"
                  autoComplete="off"
                />
                <Input
                  fieldSize="sm"
                  value={opt.value}
                  onChange={(e) => onOptionUpdate(index, { value: e.target.value })}
                  placeholder="value"
                  autoComplete="off"
                  monospace
                />
                <Button
                  variant="ghost"
                  size="xs"
                  iconOnly
                  type="button"
                  aria-label="Remove option"
                  onClick={() => onOptionRemove(index)}
                  disabled={state.selectOptions.length <= 1}
                >
                  <TrashSolidIcon size={12} aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="ghost"
            size="xs"
            type="button"
            align="start"
            onClick={onOptionAdd}
          >
            <PlusIcon size={11} aria-hidden="true" />
            Add option
          </Button>
        </div>
      )}

      {!labelLocked && field.type === 'media' && (
        <>
          <div className={styles.formGroup}>
            <span className={styles.label}>Media kind</span>
            <Select
              fieldSize="sm"
              value={state.mediaKind}
              options={MEDIA_KIND_OPTIONS}
              onChange={(e) =>
                onChange('mediaKind', e.target.value as 'image' | 'video' | 'any')
              }
            />
          </div>
          <div className={styles.switchRow}>
            <span className={styles.switchLabel}>Allow multiple</span>
            <Switch
              checked={state.mediaAllowMultiple}
              onCheckedChange={(v) => onChange('mediaAllowMultiple', v)}
            />
          </div>
        </>
      )}

      {!labelLocked && field.type === 'relation' && (
        <>
          <div className={styles.formGroup}>
            <span className={styles.label}>Target table</span>
            <span className={styles.caption}>
              {tableOptions.find((t) => t.value === field.targetTableId)?.label ?? field.targetTableId}
              {' '}
              <span className={styles.optional}>(cannot be changed after creation)</span>
            </span>
          </div>
          <div className={styles.switchRow}>
            <span className={styles.switchLabel}>Allow multiple</span>
            <Switch
              checked={state.relationAllowMultiple}
              onCheckedChange={(v) => onChange('relationAllowMultiple', v)}
            />
          </div>
        </>
      )}

      {/* Error */}
      {error && (
        <p role="alert" className={styles.errorBanner}>{error}</p>
      )}

      {/* Actions */}
      <div className={styles.fieldEditFormActions}>
        <Button variant="ghost" size="xs" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="xs"
          type="button"
          disabled={saving || (!labelLocked && !state.label.trim())}
          onClick={onSave}
        >
          <CheckIcon size={11} aria-hidden="true" />
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// FieldsSection
// ---------------------------------------------------------------------------

export const FieldsSection = memo(function FieldsSection({
  table,
  tables,
  rowCount,
  onUpdateTable,
  canEdit,
}: FieldsSectionProps): ReactElement {
  const confirmDelete = useConfirmDelete()

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [editState, setEditState] = useState<FieldEditState | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [newFieldDialogOpen, setNewFieldDialogOpen] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)

  // Dragging is allowed for all tables; mandatory postType fields are excluded
  // from drag-and-drop because they're rendered as locked rows.
  const canDragField = (field: DataField): boolean => {
    if (!canEdit) return false
    if (table.kind === 'postType' && isMandatoryField(field.id)) return false
    return true
  }

  // ── Drag-and-drop ──

  function handleDragStart(e: DragEvent<HTMLDivElement>, fieldId: string) {
    e.dataTransfer.setData('text/plain', fieldId)
    e.dataTransfer.effectAllowed = 'move'
    setDraggingId(fieldId)
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>, fieldId: string) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverId(fieldId)
  }

  function handleDragLeave() {
    setDragOverId(null)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>, targetFieldId: string) {
    e.preventDefault()
    const sourceId = draggingId ?? e.dataTransfer.getData('text/plain')
    setDraggingId(null)
    setDragOverId(null)

    if (!sourceId || sourceId === targetFieldId) return

    const fromIndex = table.fields.findIndex((f) => f.id === sourceId)
    const toIndex = table.fields.findIndex((f) => f.id === targetFieldId)
    if (fromIndex === -1 || toIndex === -1) return

    const reordered = [...table.fields]
    const [moved] = reordered.splice(fromIndex, 1)
    if (!moved) return
    reordered.splice(toIndex, 0, moved)

    setUpdateError(null)
    onUpdateTable({ fields: reordered }).catch((err) => {
      console.error('[FieldsSection] Reorder failed:', err)
      setUpdateError(err instanceof Error ? err.message : 'Could not reorder fields')
    })
  }

  function handleDragEnd() {
    setDraggingId(null)
    setDragOverId(null)
  }

  // ── Inline edit ──

  function startEdit(field: DataField) {
    setEditingFieldId(field.id)
    setEditState(fieldToEditState(field))
    setEditError(null)
  }

  function cancelEdit() {
    setEditingFieldId(null)
    setEditState(null)
    setEditError(null)
  }

  function updateEditState<K extends keyof FieldEditState>(key: K, value: FieldEditState[K]) {
    setEditState((prev) => (prev ? { ...prev, [key]: value } : null))
  }

  function updateEditOption(index: number, patch: Partial<DraftOption>) {
    setEditState((prev) => {
      if (!prev) return null
      const updated = prev.selectOptions.map((opt, i) => {
        if (i !== index) return opt
        const next = { ...opt, ...patch }
        if ('label' in patch && !('value' in patch)) {
          next.value = slugifyOptionValue(next.label)
        }
        return next
      })
      return { ...prev, selectOptions: updated }
    })
  }

  function removeEditOption(index: number) {
    setEditState((prev) =>
      prev ? { ...prev, selectOptions: prev.selectOptions.filter((_, i) => i !== index) } : null,
    )
  }

  function addEditOption() {
    setEditState((prev) =>
      prev ? { ...prev, selectOptions: [...prev.selectOptions, makeOption('')] } : null,
    )
  }

  async function saveEdit() {
    if (!editingFieldId || !editState) return
    const field = table.fields.find((f) => f.id === editingFieldId)
    if (!field) return

    const locked = isLabelLocked(field, table)
    const updated = applyEditState(field, editState, locked)
    const updatedFields = table.fields.map((f) => (f.id === editingFieldId ? updated : f))

    setEditSaving(true)
    setEditError(null)
    try {
      await onUpdateTable({ fields: updatedFields })
      setEditingFieldId(null)
      setEditState(null)
    } catch (err) {
      console.error('[FieldsSection] Save failed:', err)
      setEditError(err instanceof Error ? err.message : 'Could not save field')
    } finally {
      setEditSaving(false)
    }
  }

  // ── Delete ──

  function requestDeleteField(field: DataField) {
    const rowDescription = rowCount > 0
      ? `This will permanently delete the field and all values across ${rowCount} row${rowCount === 1 ? '' : 's'}.`
      : undefined
    confirmDelete({
      title: `Delete field "${field.label}"?`,
      description: rowDescription,
      commit: () => {
        const updatedFields = table.fields.filter((f) => f.id !== field.id)
        setUpdateError(null)
        onUpdateTable({ fields: updatedFields }).catch((err) => {
          console.error('[FieldsSection] Delete field failed:', err)
          setUpdateError(err instanceof Error ? err.message : 'Could not delete field')
        })
      },
    })
  }

  // ── New field ──

  async function handleNewField(field: DataField) {
    await onUpdateTable({ fields: [...table.fields, field] })
    setNewFieldDialogOpen(false)
  }

  // Compute which optional built-in field IDs are absent from the table
  // (so NewFieldDialog can offer quick-add buttons for them).
  const missingOptionalBuiltInIds = table.kind === 'postType'
    ? (POST_TYPE_OPTIONAL_BUILTIN_FIELD_IDS as readonly string[]).filter(
        (id) => !table.fields.some((f) => f.id === id),
      )
    : []

  // ── Render ──

  return (
    <div className={styles.fieldsSectionBody}>
      {updateError && (
        <p role="alert" className={styles.errorBanner}>{updateError}</p>
      )}

      <div className={styles.fieldList}>
        {table.fields.map((field) => {
          const FieldIcon = getFieldIcon(field.type)
          const canDrag = canDragField(field)
          const deletable = isFieldDeletable(field, table)
          const delTooltip = deleteTooltip(field, table)
          const mandatory = table.kind === 'postType' && isMandatoryField(field.id)
          const optionalBuiltIn = isOptionalBuiltIn(field)
          const isEditing = editingFieldId === field.id

          return (
            <div key={field.id}>
              {/* Field row */}
              <div
                className={[
                  styles.fieldRow,
                  dragOverId === field.id ? styles.fieldRowDragOver : '',
                  draggingId === field.id ? styles.fieldRowDragging : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                draggable={canDrag}
                onDragStart={canDrag ? (e) => handleDragStart(e, field.id) : undefined}
                onDragOver={canDrag ? (e) => handleDragOver(e, field.id) : undefined}
                onDragLeave={canDrag ? handleDragLeave : undefined}
                onDrop={canDrag ? (e) => handleDrop(e, field.id) : undefined}
                onDragEnd={canDrag ? handleDragEnd : undefined}
              >
                {/* Drag handle — shown only for draggable fields */}
                {canDrag ? (
                  <span className={styles.dragHandle} aria-hidden="true">
                    <DragAndDropSolidIcon size={12} />
                  </span>
                ) : (
                  <span className={styles.dragHandleSpacer} aria-hidden="true" />
                )}

                {/* Field type icon */}
                <span className={styles.fieldIcon} aria-hidden="true">
                  <FieldIcon size={13} />
                </span>

                {/* Name */}
                <span className={styles.fieldName}>{field.label}</span>

                {/* Mandatory built-in lock badge */}
                {mandatory && (
                  <span className={styles.lockedBadge} aria-label="Required field — locked">
                    <LockSolidIcon size={10} aria-hidden="true" />
                  </span>
                )}

                {/* Optional built-in badge */}
                {!mandatory && optionalBuiltIn && (
                  <span className={styles.typeBadge}>built-in</span>
                )}

                {/* Type badge */}
                {!mandatory && (
                  <span className={styles.typeBadge}>{FIELD_TYPE_LABELS[field.type]}</span>
                )}

                {/* Actions — not shown for mandatory built-ins */}
                {!mandatory && canEdit && (
                  <div className={styles.fieldActions}>
                    {/* Edit — always shown (lock only for label/type in the form) */}
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      type="button"
                      aria-label={`Edit ${field.label}`}
                      tooltip={`Edit ${field.label}`}
                      pressed={isEditing}
                      onClick={() => (isEditing ? cancelEdit() : startEdit(field))}
                    >
                      <EditSolidIcon size={12} aria-hidden="true" />
                    </Button>
                    {/* Delete */}
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      tone="danger"
                      type="button"
                      aria-label={`Delete ${field.label}`}
                      tooltip={delTooltip ?? `Delete ${field.label}`}
                      disabled={!deletable}
                      onClick={deletable ? () => requestDeleteField(field) : undefined}
                    >
                      <TrashSolidIcon size={12} aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </div>

              {/* Inline edit form */}
              {isEditing && editState && (
                <FieldEditForm
                  field={field}
                  tables={tables}
                  state={editState}
                  saving={editSaving}
                  error={editError}
                  labelLocked={isLabelLocked(field, table)}
                  onChange={updateEditState}
                  onOptionUpdate={updateEditOption}
                  onOptionRemove={removeEditOption}
                  onOptionAdd={addEditOption}
                  onSave={() => void saveEdit()}
                  onCancel={cancelEdit}
                />
              )}
            </div>
          )
        })}
      </div>

      {/* Add field */}
      {canEdit && (
        <Button
          variant="primary"
          size="sm"
          type="button"
          align="start"
          onClick={() => setNewFieldDialogOpen(true)}
        >
          <PlusIcon size={12} aria-hidden="true" />
          Add field
        </Button>
      )}

      <NewFieldDialog
        open={newFieldDialogOpen}
        onClose={() => setNewFieldDialogOpen(false)}
        existingFieldIds={table.fields.map((f) => f.id)}
        tables={tables}
        missingOptionalBuiltInIds={missingOptionalBuiltInIds}
        onCreate={handleNewField}
      />
    </div>
  )
})
