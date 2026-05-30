/**
 * FontsSection — site fonts library shown at the top of the Typography panel.
 *
 * Lists every font installed on the site and lets the user add another from
 * Google's directory (custom uploads are a planned next step). All file work
 * happens on the server: this component only mutates `site.settings.fonts`
 * via the `addFont` / `removeFont` zustand actions and triggers the install /
 * uninstall HTTP endpoints.
 *
 * The section embeds into `FrameworkScalePanel` via the `extraSections` slot;
 * see `TypographyPanel.tsx` for the wiring.
 */

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { useEditorStore } from '@site/store/store'
import type { FontEntry } from '@core/fonts/schemas'
import { compareVariants } from '@core/fonts/variants'
import { generateSiteFontsCss } from '@core/fonts/css'
import { deleteCmsFontFamily } from '@core/persistence/cmsFonts'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { AddGoogleFontDialog } from './AddGoogleFontDialog'
import { AddCustomFontDialog } from './AddCustomFontDialog'
import styles from './FontsSection.module.css'

const EMPTY_FONTS: FontEntry[] = []

/**
 * Inject the site's installed `@font-face` rules into the admin document head
 * so the Typography panel can render each family name in its own font.
 *
 * The canvas iframe already injects the same rules for its preview, but the
 * admin shell (where this panel lives) has no `@font-face` declarations of its
 * own — without this the `fontFamily` set on each row would silently fall back
 * to system-ui. The self-hosted `/uploads/fonts/...` `src` URLs resolve through
 * the dev proxy / published server exactly as they do on the canvas.
 */
function useInstalledFontFaces(fonts: FontEntry[]) {
  const css = generateSiteFontsCss({ items: fonts })
  useEffect(() => {
    if (!css) return
    const styleEl = document.createElement('style')
    styleEl.setAttribute('data-source', 'pb-admin-installed-fonts')
    styleEl.textContent = css
    document.head.appendChild(styleEl)
    return () => {
      styleEl.remove()
    }
  }, [css])
}

export function FontsSection() {
  const fonts = useEditorStore((s) => s.site?.settings.fonts?.items ?? EMPTY_FONTS)
  const addFont = useEditorStore((s) => s.addFont)
  const removeFont = useEditorStore((s) => s.removeFont)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [editEntry, setEditEntry] = useState<FontEntry | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useInstalledFontFaces(fonts)

  const installedFamiliesLower = new Set(fonts.map((f) => f.family.toLowerCase()))

  // When editing, the font being edited is already installed — exclude its own
  // family from the dedup set so keeping the same name isn't flagged as taken.
  const editInstalledFamilies = editEntry
    ? new Set([...installedFamiliesLower].filter((f) => f !== editEntry.family.toLowerCase()))
    : installedFamiliesLower

  // Re-install replaces the entry: drop the old one by id (covers a custom-font
  // rename, where family-based replacement in `addFont` wouldn't match), then
  // add the freshly built entry.
  function handleEdited(entry: FontEntry) {
    if (editEntry) removeFont(editEntry.id)
    addFont(entry)
    setEditEntry(null)
  }

  async function handleRemove(entry: FontEntry) {
    setActionError(null)
    // Optimistically drop the entry from the library — the on-disk woff2 files
    // are best-effort to delete; a stale folder is harmless and gets pruned on
    // the next install of the same family.
    removeFont(entry.id)
    if (entry.source === 'google') {
      try {
        await deleteCmsFontFamily(entry.family)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not delete font files')
      }
    }
  }

  return (
    <div className={styles.section}>
      {fonts.length === 0 ? (
        // Mirror the "No <kind> scales yet." empty state used in the Scales
        // section so the two empty states inside the Typography panel read
        // consistently. The CTA opens the same Add Google Font dialog the
        // bottom-right "Add Google font" button does.
        <EmptyState
          plain
          compact
          title="No fonts installed yet."
          action={
            <div className={styles.addRow}>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setDialogOpen(true)}
              >
                Add Google font
              </Button>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setCustomDialogOpen(true)}
              >
                Upload custom font
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <ul className={styles.list} role="list" aria-label="Installed fonts">
            {fonts.map((entry) => (
              <FontRow
                key={entry.id}
                entry={entry}
                onEdit={() => setEditEntry(entry)}
                onRemove={() => { void handleRemove(entry) }}
              />
            ))}
          </ul>

          <div className={styles.addRow}>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => setDialogOpen(true)}
            >
              Add Google font
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => setCustomDialogOpen(true)}
            >
              Upload custom font
            </Button>
          </div>
        </>
      )}

      {actionError && (
        <p role="alert" className={styles.errorAlert}>{actionError}</p>
      )}

      {dialogOpen && (
        <AddGoogleFontDialog
          installedFamilies={installedFamiliesLower}
          onCancel={() => setDialogOpen(false)}
          onInstalled={(entry) => {
            addFont(entry)
            setDialogOpen(false)
          }}
        />
      )}

      {customDialogOpen && (
        <AddCustomFontDialog
          installedFamilies={installedFamiliesLower}
          onCancel={() => setCustomDialogOpen(false)}
          onInstalled={(entry) => {
            addFont(entry)
            setCustomDialogOpen(false)
          }}
        />
      )}

      {editEntry?.source === 'google' && (
        <AddGoogleFontDialog
          editEntry={editEntry}
          installedFamilies={editInstalledFamilies}
          onCancel={() => setEditEntry(null)}
          onInstalled={handleEdited}
        />
      )}

      {editEntry?.source === 'custom' && (
        <AddCustomFontDialog
          editEntry={editEntry}
          installedFamilies={editInstalledFamilies}
          onCancel={() => setEditEntry(null)}
          onInstalled={handleEdited}
        />
      )}
    </div>
  )
}

interface FontRowProps {
  entry: FontEntry
  onEdit: () => void
  onRemove: () => void
}

function FontRow({ entry, onEdit, onRemove }: FontRowProps) {
  const variants = [...entry.variants].sort(compareVariants)
  const variantSummary =
    variants.length === 0
      ? ''
      : variants.length <= 3
        ? variants.join(', ')
        : `${variants.slice(0, 3).join(', ')}, +${variants.length - 3}`

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <span
          className={styles.rowFamily}
          style={{ fontFamily: `"${entry.family}", system-ui, sans-serif` } as CSSProperties}
        >
          {entry.family}
        </span>
        <span className={styles.rowMeta}>
          {entry.source === 'google' ? 'Google' : 'Custom'}
          {variantSummary && ` · ${variantSummary}`}
          {entry.subsets.length > 0 && ` · ${entry.subsets.length} subset${entry.subsets.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className={styles.rowActions}>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={`Edit ${entry.family}`}
          tooltip={`Edit ${entry.family}`}
          onClick={onEdit}
        >
          <EditSolidIcon size={12} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={`Remove ${entry.family}`}
          tooltip={`Remove ${entry.family}`}
          onClick={onRemove}
        >
          <TrashSolidIcon size={12} aria-hidden="true" />
        </Button>
      </div>
    </li>
  )
}
