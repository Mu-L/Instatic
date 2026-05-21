import { useCallback, type ChangeEvent, type SyntheticEvent } from "react";
import type { Breakpoint } from '@core/page-tree'
import { Select } from "@ui/components/Select";
import { SmartphoneSolidIcon } from "pixel-art-icons/icons/smartphone-solid";
import { TabletSolidIcon } from "pixel-art-icons/icons/tablet-solid";
import { MonitorSolidIcon } from "pixel-art-icons/icons/monitor-solid";
import { LaptopSolidIcon } from "pixel-art-icons/icons/laptop-solid";
import { TvSolidIcon } from "pixel-art-icons/icons/tv-solid";
import styles from "./CanvasBreakpointSelector.module.css";

interface CanvasBreakpointSelectorProps {
  breakpoints: Breakpoint[];
  activeBreakpointId: string;
  onBreakpointChange: (breakpointId: string) => void;
}

export function CanvasBreakpointSelector({
  breakpoints,
  activeBreakpointId,
  onBreakpointChange,
}: CanvasBreakpointSelectorProps) {
  const activeBreakpoint = breakpoints.find(
    (breakpoint) => breakpoint.id === activeBreakpointId,
  );
  const selectedBreakpointId = activeBreakpoint?.id ?? breakpoints[0]?.id ?? "";

  const stopCanvasInteraction = useCallback((event: SyntheticEvent) => {
    event.stopPropagation();
  }, []);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onBreakpointChange(event.target.value);
    },
    [onBreakpointChange],
  );

  if (breakpoints.length === 0) return null;

  return (
    <div
      className={styles.shell}
      data-testid="canvas-breakpoint-selector"
      onClick={stopCanvasInteraction}
      onMouseDown={stopCanvasInteraction}
      aria-label="Breakpoint editing context"
    >
      <div className={styles.notch}>
        <Select
          value={selectedBreakpointId}
          onChange={handleChange}
          aria-label="Canvas breakpoint"
          fieldSize="xs"
          emphasis="strong"
          className={styles.breakpointSelect}
          menuMinWidth={164}
          menuPlacement="left-start"
          options={breakpoints.map((breakpoint) => ({
            value: breakpoint.id,
            textValue: breakpoint.label,
            label: (
              <span className={styles.optionLabel}>
                <span>{breakpoint.label}</span>
                <span className={styles.optionWidth}>{breakpoint.width}px</span>
              </span>
            ),
            icon: <BreakpointIcon name={breakpoint.icon} />,
          }))}
        />
      </div>
    </div>
  );
}

function BreakpointIcon({ name }: { name: string }) {
  switch (name) {
    case "smartphone":
      return <SmartphoneSolidIcon size={11} aria-hidden="true" />;
    case "tablet":
      return <TabletSolidIcon size={11} aria-hidden="true" />;
    case "laptop":
      return <LaptopSolidIcon size={11} aria-hidden="true" />;
    case "tv":
      return <TvSolidIcon size={11} aria-hidden="true" />;
    case "monitor":
    default:
      return <MonitorSolidIcon size={11} aria-hidden="true" />;
  }
}
