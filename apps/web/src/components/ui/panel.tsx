"use client";

import * as React from "react";

import { cn } from "@/lib/cn";

/**
 * Panel - the surface primitive every workspace region is built from.
 *
 * The design relies on surface steps and hairline borders rather than drop
 * shadows: on a near-black canvas a large shadow reads as a smudge. The
 * `raised` variant steps up to `panelElevated` for nested regions such as the
 * asset list inside the left pane.
 */
export interface PanelProps extends React.HTMLAttributes<HTMLElement> {
  readonly as?: "section" | "aside" | "div" | "main";
  readonly raised?: boolean;
  /** Removes the border when the panel is flush against a pane edge. */
  readonly flush?: boolean;
}

export const Panel = React.forwardRef<HTMLElement, PanelProps>(function Panel(
  { className, as: Component = "section", raised = false, flush = false, ...props },
  ref,
) {
  return (
    <Component
      ref={ref as React.Ref<never>}
      className={cn(
        "flex min-h-0 min-w-0 flex-col",
        raised ? "bg-panel-elevated" : "bg-panel",
        !flush && "border border-border",
        className,
      )}
      {...props}
    />
  );
});

export interface PanelHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Small icon rendered before the title. Decorative only; pass `aria-hidden`. */
  readonly icon?: React.ReactNode;
  /** Right-aligned actions (buttons, counters). */
  readonly actions?: React.ReactNode;
  /** Adds a hairline under the header. Off by default; the surface step usually suffices. */
  readonly divided?: boolean;
}

/**
 * PanelHeader - the label bar at the top of a region.
 *
 * Uses the `label` tracking token and uppercase, which is the one place in the
 * type scale where positive tracking is correct. Titles stay at `text-sm`; the
 * oversized editorial `display` sizes are reserved for page-level moments and
 * would waste vertical space the timeline needs.
 */
export const PanelHeader = React.forwardRef<HTMLDivElement, PanelHeaderProps>(
  function PanelHeader(
    { className, icon, actions, divided = false, children, ...props },
    ref,
  ) {
    return (
      <div
        ref={ref}
        className={cn(
          "flex h-9 flex-none items-center gap-2 px-3",
          divided && "border-b border-border",
          className,
        )}
        {...props}
      >
        {icon ? (
          <span className="flex size-4 flex-none items-center justify-center text-text-tertiary">
            {icon}
          </span>
        ) : null}
        <h2 className="truncate text-xs font-semibold uppercase tracking-label text-text-secondary">
          {children}
        </h2>
        {actions ? (
          <div className="ml-auto flex flex-none items-center gap-1">{actions}</div>
        ) : null}
      </div>
    );
  },
);

/** Scrollable body region. `min-h-0` is required for flex children to scroll. */
export const PanelBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function PanelBody({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn("min-h-0 flex-1 overflow-auto", className)}
      {...props}
    />
  );
});

/** Footer bar for summary rows and primary actions. */
export const PanelFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function PanelFooter({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex flex-none items-center gap-2 border-t border-border px-3 py-2",
        className,
      )}
      {...props}
    />
  );
});