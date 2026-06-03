import { type ReactNode, type SyntheticEvent } from "react";
import { registry } from "@core/module-engine";
import { useInsertModule } from "@site/hooks/useInsertModule";
import { ModulePickerDropdown } from "@site/toolbar/ModulePickerDropdown";
import { ModuleIcon } from "@site/ui/ModuleIcon";
import type { IconComponent } from "pixel-art-icons/types";
import { Button } from "@ui/components/Button";
import { UndoRedoButtons } from "./UndoRedoButtons";
import styles from "./CanvasNotch.module.css";

const QUICK_ACTION_MODULE_IDS = [
  "base.container",
  "base.text",
  "base.image",
] as const;

const ADD_TRIGGER_TEST_ID = "canvas-notch-add-btn";

/**
 * Notch action — supplies either a `moduleId` (icon resolved through the
 * module registry via `ModuleIcon`) or a literal `icon` component. Module
 * actions should always pass `moduleId` so the icon stays in sync with the
 * module declaration; ad-hoc actions (e.g. content-document blocks) supply
 * `icon` directly.
 */
export type CanvasNotchAction = {
  id: string;
  label: string;
  onClick: () => void;
} & (
  | { moduleId: string; icon?: never }
  | { icon: IconComponent; moduleId?: never }
);

interface CanvasNotchProps {
  actions?: CanvasNotchAction[];
  addControl?: ReactNode;
  floatingControl?: ReactNode;
  /**
   * Show the Undo/Redo group on the left side of the notch.
   * Defaults to true. Disable for canvases that don't drive the editor
   * page tree (e.g. the content document canvas, which has its own
   * draft-management lifecycle).
   */
  showHistoryControls?: boolean;
}

export function CanvasNotch({
  actions,
  addControl,
  floatingControl,
  showHistoryControls = true,
}: CanvasNotchProps = {}) {
  const insertModule = useInsertModule();

  const stopCanvasInteraction = (event: SyntheticEvent) => {
    event.stopPropagation();
  };

  const handleQuickInsert = (moduleId: string) => {
    const mod = registry.get(moduleId);
    if (!mod) return;
    insertModule(mod);
  };

  const defaultActions: CanvasNotchAction[] = [];
  for (const moduleId of QUICK_ACTION_MODULE_IDS) {
    const mod = registry.get(moduleId);
    if (!mod) continue;
    defaultActions.push({
      id: mod.id,
      label: mod.name,
      moduleId: mod.id,
      onClick: () => handleQuickInsert(mod.id),
    });
  }

  return (
    <div
      className={styles.shell}
      aria-label="Insert modules"
      data-testid="canvas-notch"
      onClick={stopCanvasInteraction}
    >
      <div className={styles.notch}>
        {showHistoryControls && (
          <>
            <UndoRedoButtons />
            <div aria-hidden="true" className={styles.divider} />
          </>
        )}

        {(actions ?? defaultActions).map((action) => {
          const ActionIcon = action.icon;
          return (
            <Button
              key={action.id}
              variant="ghost"
              size="sm"
              iconOnly
              className={styles.quickButton}
              onClick={action.onClick}
              aria-label={`Add ${action.label}`}
              tooltip={`Add ${action.label}`}
              data-testid={`canvas-notch-${action.label.toLowerCase()}-btn`}
            >
              {ActionIcon ? (
                <ActionIcon size={14} aria-hidden="true" />
              ) : (
                <ModuleIcon
                  moduleId={action.moduleId}
                  size={14}
                  aria-hidden="true"
                />
              )}
            </Button>
          );
        })}

        {addControl ?? (
          <ModulePickerDropdown
            triggerClassName={styles.addButton}
            triggerTestId={ADD_TRIGGER_TEST_ID}
          />
        )}
      </div>
      {floatingControl && (
        <div className={styles.floatingControl}>
          {floatingControl}
        </div>
      )}
    </div>
  );
}
