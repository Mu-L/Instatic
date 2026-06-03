/**
 * VisualComponentModeControl — floating Visual Component edit-mode control.
 *
 * Renders below the canvas notch while the canvas is editing a Visual
 * Component. The control keeps VC mode visible in the canvas chrome instead of
 * hiding it in the global toolbar.
 */

import { useEffect, useRef, useState } from 'react'
import { validateComponentName, type VisualComponent } from '@core/visualComponents'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { ArrowLeftIcon } from 'pixel-art-icons/icons/arrow-left'
import styles from './VisualComponentModeControl.module.css'

const EMPTY_VCS: VisualComponent[] = []

export default function VisualComponentModeControl() {
  const activeDocument = useEditorStore((s) => s.activeDocument)
  const exitVisualComponentMode = useEditorStore((s) => s.exitVisualComponentMode)
  const renameVisualComponent = useEditorStore((s) => s.renameVisualComponent)

  const vcId = activeDocument?.kind === 'visualComponent' ? activeDocument.vcId : null
  const vc = useEditorStore(
    (s) => s.site?.visualComponents?.find((component) => component.id === vcId) ?? null,
  )

  const [isEditing, setIsEditing] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const [prevVcId, setPrevVcId] = useState<string | null>(null)
  if (vcId !== prevVcId) {
    setPrevVcId(vcId)
    if (isEditing) setIsEditing(false)
    if (nameError !== null) setNameError(null)
  }

  useEffect(() => {
    if (!isEditing) return
    requestAnimationFrame(() => inputRef.current?.select())
  }, [isEditing])

  if (activeDocument?.kind !== 'visualComponent') return null
  if (!vc) return null

  const component = vc

  function commitRename(input: HTMLInputElement): void {
    const newName = input.value.trim()

    if (!newName || newName === component.name) {
      input.value = component.name
      setIsEditing(false)
      setNameError(null)
      return
    }

    const currentVCs = useEditorStore.getState().site?.visualComponents ?? EMPTY_VCS
    const result = validateComponentName(newName, currentVCs, component.id)

    if (!result.ok) {
      setNameError(result.reason)
      return
    }

    renameVisualComponent(component.id, newName)
    setIsEditing(false)
    setNameError(null)
  }

  function cancelRename(input: HTMLInputElement): void {
    input.value = component.name
    setIsEditing(false)
    setNameError(null)
  }

  return (
    <div className={styles.control} data-testid="vc-mode-control">
      <Button
        variant="ghost"
        size="sm"
        shape="pill"
        className={styles.backButton}
        onClick={exitVisualComponentMode}
        data-testid="vc-mode-control-back"
        aria-label="Back to page"
      >
        <ArrowLeftIcon size={12} aria-hidden="true" />
        Back to page
      </Button>

      <span className={styles.modeLabel}>Editing</span>

      <span className={styles.nameChipWrapper}>
        {isEditing ? (
          <>
            <Input
              ref={inputRef}
              type="text"
              fieldSize="sm"
              defaultValue={component.name}
              data-testid="vc-mode-control-name-input"
              aria-label="Component name"
              className={styles.nameInput}
              onBlur={(event) => commitRename(event.target as HTMLInputElement)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitRename(event.target as HTMLInputElement)
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelRename(event.target as HTMLInputElement)
                }
              }}
            />
            {nameError !== null && (
              <div role="alert" className={styles.error}>
                {nameError}
              </div>
            )}
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            shape="pill"
            className={styles.nameChip}
            data-testid="vc-mode-control-name"
            aria-label={`Rename component: ${component.name}`}
            tooltip="Rename component"
            onClick={() => setIsEditing(true)}
          >
            {component.name}
          </Button>
        )}
      </span>
    </div>
  )
}
