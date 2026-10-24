"use client";

import * as React from "react";

import { cn } from "@/lib/cn";
import { layout } from "@/lib/tokens";

/**
 * ResizeDivider - the separator between two workspace panes.
 *
 * HOW DRAGGING WORKS
 * `setPointerCapture` is taken on pointerdown, so the divider keeps receiving
 * `pointermove` even when the cursor outruns the 1px line or leaves the window.
 * Moves are accumulated against the size captured at drag start rather than
 * against the previous frame, which prevents drift when a delta is clamped at a
 * limit and then reversed.
 *
 * HOW KEYBOARD WORKS (WCAG 2.1.1 Keyboard, 2.4.7 Focus Visible)
 * The divider is a real `role="separator"` widget with `aria-valuenow`,
 * `aria-valuemin`, `aria-valuemax` and `aria-orientation`, so a screen reader
 * announces it as an adjustable splitter. Arrow keys resize by a step; Shift
 * multiplies the step by 4 for coarse travel; Home/End jump to the limits;
 * Enter/Space toggles collapse. `aria-valuetext` adds the unit ("280 pixels"),
 * because a bare number is announced without meaning.
 *
 * WHY POINTER EVENTS AND NOT MOUSE EVENTS
 * Pointer events unify mouse, pen and touch, so the same code path gives the
 * divider touch support on the tablet breakpoint without a second handler.
 */

const STEP = 16;
const COARSE_MULTIPLIER = 4;

export interface ResizeDividerProps {
  readonly orientation: "vertical" | "horizontal";
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** Called with an already-clamped value, in pixels. */
  readonly onChange: (next: number) => void;
  /** Called on drag end / key release so the caller can persist once, not per frame. */
  readonly onCommit?: (next: number) => void;
  /** Toggle handler for Enter/Space and double-click. Omit to disable collapsing. */
  readonly onToggleCollapse?: () => void;
  readonly collapsed?: boolean;
  readonly label: string;
  /**
   * How a positive DIVIDER movement (right, or down) maps onto this pane's size.
   *
   *  `1`  - pane grows as the divider moves right/down. The pane's far edge is
   *         the divider, so this is the LEFT pane.
   *  `-1` - pane grows as the divider moves left/up. The pane's near edge is the
   *         divider, so this is the RIGHT pane and the TIMELINE.
   *
   * Getting this wrong is subtle and was a real bug here: with the wrong sign,
   * ArrowUp on the timeline drove it to its maximum rather than its minimum.
   * The correct mental model is that the ARROW KEY always moves the DIVIDER, and
   * the pane responds according to which side of the divider it sits on.
   */
  readonly direction?: 1 | -1;
  readonly id?: string;
  readonly className?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function ResizeDivider({
  orientation,
  value,
  min,
  max,
  onChange,
  onCommit,
  onToggleCollapse,
  collapsed = false,
  label,
  direction = 1,
  id,
  className,
}: ResizeDividerProps) {
  const isVertical = orientation === "vertical";
  const [dragging, setDragging] = React.useState(false);
  // Live value during a drag, so the handler does not depend on a stale closure.
  const dragRef = React.useRef<{ startPos: number; startValue: number } | null>(
    null,
  );
  const latest = React.useRef(value);
  latest.current = value;

  const apply = React.useCallback(
    (next: number) => {
      const clamped = clamp(next, min, max);
      if (clamped !== latest.current) {
        latest.current = clamped;
        onChange(clamped);
      }
      return clamped;
    },
    [min, max, onChange],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    dragRef.current = {
      startPos: isVertical ? event.clientX : event.clientY,
      startValue: value,
    };
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const currentPos = isVertical ? event.clientX : event.clientY;
    const delta = currentPos - drag.startPos;
    // The divider moved by `delta`. Whether the pane grows or shrinks depends on
    // which side of the divider it occupies - that is what `direction` encodes.
    apply(drag.startValue + delta * direction);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onCommit?.(latest.current);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? STEP * COARSE_MULTIPLIER : STEP;
    // Arrow keys move the DIVIDER in screen space, then the pane reacts via
    // `direction`. ArrowRight/ArrowDown always push the divider right/down.
    let dividerDelta: number | null = null;

    if (isVertical) {
      if (event.key === "ArrowRight") dividerDelta = step;
      if (event.key === "ArrowLeft") dividerDelta = -step;
    } else {
      if (event.key === "ArrowDown") dividerDelta = step;
      if (event.key === "ArrowUp") dividerDelta = -step;
    }

    if (dividerDelta !== null) {
      event.preventDefault();
      onCommit?.(apply(latest.current + dividerDelta * direction));
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      onCommit?.(apply(min));
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      onCommit?.(apply(max));
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && onToggleCollapse) {
      event.preventDefault();
      onToggleCollapse();
    }
  };

  return (
    <div
      id={id}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${Math.round(value)} pixels`}
      aria-disabled={collapsed || undefined}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={onToggleCollapse}
      className={cn(
        "group relative z-10 flex items-center justify-center",
        "cursor-col-resize touch-none",
        "focus-visible:outline-none",
        isVertical ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
        className,
      )}
      style={{ touchAction: "none" }}
    >
      {/*
       * The visible line is 1px; the hit area is 9px wide via this overlay, so the
       * divider is comfortably grabbable without stealing layout space from the
       * panes. `-inset-x-1` centres it on the 1px line.
       */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute bg-border transition-colors duration-150 ease-[var(--ease-standard)]",
          "group-hover:bg-accent/40 group-data-[dragging]:bg-accent",
          "group-focus-visible:bg-focus",
          isVertical ? "-inset-x-1 inset-y-0" : "inset-x-0 -inset-y-1",
        )}
      />
      {/* Focus ring drawn on the hit area rather than the 1px line. */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute rounded-full opacity-0",
          "transition-opacity duration-150 group-focus-visible:opacity-100",
          "bg-focus",
          isVertical ? "inset-y-4 -inset-x-1.5 w-0.5" : "inset-x-4 -inset-y-1.5 h-0.5",
        )}
      />
    </div>
  );
}

/**
 * Clamp helper shared by the workspace layout so that pane sizes restored from
 * storage can never violate the token limits, even if the stored value came from
 * an older build with different bounds.
 */
export function clampPaneSize(
  value: unknown,
  bounds: { readonly min: number; readonly max: number; readonly default: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return bounds.default;
  return clamp(Math.round(value), bounds.min, bounds.max);
}

/** Type guard for restoring persisted sizes. Rejects anything not a finite number. */
export function isPaneSizeRecord(
  value: unknown,
): value is Record<string, number> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every(
    (entry) => typeof entry === "number" && Number.isFinite(entry),
  );
}

export { layout };