"use client";

import * as React from "react";

import {
  clampPaneSize,
  ResizeDivider,
} from "@/components/workspace/resize-divider";
import { usePersistentState } from "@/lib/use-persistent-state";
import { layout } from "@/lib/tokens";

/**
 * Pane geometry state for the four-region workspace.
 *
 * Everything here is real: sizes are clamped to the `layout` token bounds on
 * every read and every write, and changes are persisted to `localStorage` so a
 * reload restores the arrangement the user chose.
 */

/** Bump when the bounds change shape, so stale stored values are discarded. */
const STORAGE_KEY = "kinema.workspace.paneSizes.v1";

export interface PaneSizes {
  readonly left: number;
  readonly right: number;
  readonly timeline: number;
}

const BOUNDS = {
  left: layout.leftPane,
  right: layout.rightPane,
  timeline: layout.timeline,
} as const;

const DEFAULTS: PaneSizes = {
  left: layout.leftPane.default,
  right: layout.rightPane.default,
  timeline: layout.timeline.default,
};

function isStoredSizes(value: unknown): value is Partial<PaneSizes> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every(
    (entry) => typeof entry === "number" && Number.isFinite(entry),
  );
}

export interface WorkspacePanes {
  readonly sizes: PaneSizes;
  readonly collapsed: {
    readonly left: boolean;
    readonly right: boolean;
    readonly timeline: boolean;
  };
  readonly setSize: (pane: keyof PaneSizes, next: number) => void;
  readonly toggleCollapse: (pane: keyof PaneSizes) => void;
  /** True once localStorage has been read; used to avoid a hydration flash. */
  readonly hydrated: boolean;
  /** Effective pixel size, honouring collapse. This is what the layout renders. */
  readonly rendered: PaneSizes;
  readonly expandedSizes: PaneSizes;
}

export function useWorkspacePanes(): WorkspacePanes {
  const [stored, setStored, hydrated] = usePersistentState<Partial<PaneSizes>>(
    STORAGE_KEY,
    {},
    { validate: isStoredSizes },
  );

  const [collapsedLeft, setCollapsedLeft] = React.useState(false);
  const [collapsedRight, setCollapsedRight] = React.useState(false);
  const [collapsedTimeline, setCollapsedTimeline] = React.useState(false);

  // Clamp on read, not on write only. A value written by an older build (or
  // hand-edited in devtools) must not be able to produce an unusable layout.
  const sizes = React.useMemo<PaneSizes>(
    () => ({
      left: clampPaneSize(stored.left, BOUNDS.left),
      right: clampPaneSize(stored.right, BOUNDS.right),
      timeline: clampPaneSize(stored.timeline, BOUNDS.timeline),
    }),
    [stored],
  );

  /**
   * Sizes are written on commit (drag end, key release), never per pointermove.
   * Writing on every frame would serialise JSON ~60x/second and jank the drag.
   */
  const setSize = React.useCallback(
    (pane: keyof PaneSizes, next: number) => {
      setStored({ ...stored, [pane]: clampPaneSize(next, BOUNDS[pane]) });
    },
    [stored, setStored],
  );

  const toggleCollapse = React.useCallback((pane: keyof PaneSizes) => {
    if (pane === "left") setCollapsedLeft((v) => !v);
    if (pane === "right") setCollapsedRight((v) => !v);
    if (pane === "timeline") setCollapsedTimeline((v) => !v);
  }, []);

  const collapsed = {
    left: collapsedLeft,
    right: collapsedRight,
    timeline: collapsedTimeline,
  } as const;

  const rendered = React.useMemo<PaneSizes>(
    () => ({
      left: collapsedLeft ? 0 : sizes.left,
      right: collapsedRight ? 0 : sizes.right,
      timeline: collapsedTimeline ? 0 : sizes.timeline,
    }),
    [collapsedLeft, collapsedRight, collapsedTimeline, sizes],
  );

  return {
    sizes,
    collapsed,
    setSize,
    toggleCollapse,
    hydrated,
    rendered,
    expandedSizes: sizes,
  };
}

export interface PaneDividerProps {
  readonly pane: keyof PaneSizes;
  readonly orientation: "vertical" | "horizontal";
  readonly label: string;
  readonly panes: WorkspacePanes;
  /** Sign applied to the drag delta. `-1` for the right pane and the timeline. */
  readonly direction?: 1 | -1;
}

/**
 * Wires a divider to one pane. Kept separate from `ResizeDivider` so the dumb
 * separator stays testable without the layout state.
 */
export function PaneDivider({
  pane,
  orientation,
  label,
  panes,
  direction = 1,
}: PaneDividerProps) {
  const bounds = BOUNDS[pane];
  return (
    <ResizeDivider
      orientation={orientation}
      label={label}
      value={panes.sizes[pane]}
      min={bounds.min}
      max={bounds.max}
      collapsed={panes.collapsed[pane]}
      // During the drag the live size is held locally by the divider; this fires
      // with the value already adjusted for the pane's growth direction.
      onChange={(next) =>
        panes.setSize(pane, direction === 1 ? next : bounds.min + bounds.max - next)
      }
      onCommit={(next) =>
        panes.setSize(pane, direction === 1 ? next : bounds.min + bounds.max - next)
      }
      onToggleCollapse={() => panes.toggleCollapse(pane)}
    />
  );
}