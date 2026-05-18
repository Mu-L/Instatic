/**
 * ControlRow — shared layout shell used by every property control row.
 *
 * Owns the wrapper div + label row so individual controls don't have to
 * duplicate the same boilerplate. Honors the `layout` variant:
 *
 *   - `inline` (default): 100px label column + control column.
 *   - `stacked`: label on its own line above a full-width control.
 *
 * The `labelSuffix` slot is used by controls that surface inline metadata
 * next to the label (e.g. NumberControl's unit, MediaLibraryControl /
 * UrlControl's validation error).
 *
 * Shared admin primitive — used by the site editor's PropertiesPanel
 * property controls and the data admin's TableSettings inspector.
 */
import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './ControlRow.module.css'

/** Row layout variant. Mirrors `PropertyControlLayout` from the module engine. */
export type ControlRowLayout = 'inline' | 'stacked'

interface ControlRowProps {
  /** Property key — used for the `htmlFor`/`id` linkage when `inputId` is omitted. */
  propKey: string
  /** Visible label text. Falls back to `propKey` when omitted. */
  label?: string
  /** Override the input id used for the `htmlFor` attribute. */
  inputId?: string
  /** Render the row in inline (default) or stacked layout. */
  layout?: ControlRowLayout
  /** Highlight the label as a breakpoint override. */
  isOverride?: boolean
  /** Dim the row to indicate the control is disabled. */
  disabled?: boolean
  /** Optional inline content rendered after the label (unit, validation error). */
  labelSuffix?: ReactNode
  /** Optional caption shown below the row in subdued text. */
  description?: ReactNode
  /** The actual control input(s). */
  children: ReactNode
}

export function ControlRow({
  propKey,
  label,
  inputId,
  layout = 'inline',
  isOverride,
  disabled,
  labelSuffix,
  description,
  children,
}: ControlRowProps) {
  return (
    <div
      className={cn(
        styles.controlWrapper,
        layout === 'stacked' && styles.controlWrapperStacked,
        disabled && styles.controlWrapperDisabled,
      )}
    >
      <div className={styles.labelRow}>
        <label
          htmlFor={inputId ?? `ctrl-${propKey}`}
          className={isOverride ? styles.labelOverride : undefined}
        >
          {label ?? propKey}
        </label>
        {labelSuffix}
      </div>
      {children}
      {description && (
        <span className={styles.description}>{description}</span>
      )}
    </div>
  )
}
