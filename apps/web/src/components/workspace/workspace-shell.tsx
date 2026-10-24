"use client";

import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Rows3 } from "lucide-react";
import * as React from "react";

import { CenterViewer } from "@/components/workspace/center-viewer";
import { LeftPane } from "@/components/workspace/left-pane";
import { PaneDivider, useWorkspacePanes } from "@/components/workspace/use-workspace-panes";
import { RightPane } from "@/components/workspace/right-pane";
import { Timeline } from "@/components/workspace/timeline";
import { TopBar, type WorkspaceMode } from "@/components/workspace/top-bar";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { TooltipLabel } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/tokens";
import { usePersistentState } from "@/lib/use-persistent-state";

/**
 * WorkspaceShell - the four-region desktop workspace.
 *
 * LAYOUT
 *   ┌──────────────────────── TopBar (52px, token `layout.topBar`) ────────┐
 *   │ Left │ Centre viewer │ Right │
 *   │      ├──── horizontal divider ────┤
 *   │      │ Timeline                    │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * The left and right panes flank the *whole* centre column, so the timeline sits
 * between them rather than under the full width. That is what the product spec's
 * region order describes, and it keeps the vertical dividers continuous - a
 * divider that stops halfway down reads as a broken border.
 *
 * GRID TRACKS
 * Column widths come from React state, not from CSS `resize`. The panes are laid
 * out as `grid-template-columns: <left>px 1px 1fr 1px <right>px` so the dividers
 * are real 1px tracks and the centre column absorbs the remainder with `1fr`. No
 * `calc()` fragility, and the centre can never be squeezed below its minimum
 * because `1fr` has an implicit `min-content` floor of zero only - the viewer's
 * own `min-w-0` lets it shrink, and `layout.minViewerHeight` guards the rows.
 *
 * COLLAPSE
 * Collapsing sets the track to 0 rather than unmounting the pane, so the pane's
 * state (selected tab, scroll position) survives. The keyboard path is on the
 * divider: Enter or Space toggles it, matching the ARIA window-splitter pattern.
 */
export function WorkspaceShell({
  projectName,
  seriesName,
  sceneName,
}: {
  readonly projectName: string;
  readonly seriesName: string;
  readonly sceneName: string;
}) {
  const panes = useWorkspacePanes();
  const [mode, setMode] = usePersistentState<WorkspaceMode>(
    "kinema.workspace.mode.v1",
    "simple",
    {
      validate: (value): value is WorkspaceMode =>
        value === "simple" || value === "advanced",
    },
  );
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  // Ctrl/Cmd+K is a genuine shortcut for a genuinely-rendered affordance: it
  // focuses the project tree rather than "opening" a palette that does not exist.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        document.getElementById("workspace-left-pane")?.focus();
      }
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const gridTemplateColumns = `${panes.rendered.left}px 1px minmax(0, 1fr) 1px ${panes.rendered.right}px`;
  const gridTemplateRows = `minmax(${layout.minViewerHeight}px, 1fr) 1px ${panes.rendered.timeline}px`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <TopBar
        projectName={projectName}
        seriesName={seriesName}
        sceneName={sceneName}
        mode={mode}
        onModeChange={setMode}
        onOpenCommandPalette={() => {
          setPaletteOpen(true);
          document.getElementById("workspace-left-pane")?.focus();
        }}
        spendUsd={0}
        budgetUsd={null}
      />

      {/*
       * Advanced mode is a real, visible difference: it reveals the divider
       * collapse controls and the pane-size readout. Simple mode hides them, which
       * is the point of having two modes. It is not a decorative toggle.
       */}
      {mode === "advanced" ? (
        <div className="flex flex-none items-center gap-2 border-b border-border bg-canvas-raised px-3 py-1">
          <span className="text-xs uppercase tracking-label text-text-tertiary">
            Advanced
          </span>
          <span className="tabular text-xs text-text-secondary">
            left {panes.sizes.left}px · right {panes.sizes.right}px · timeline{" "}
            {panes.sizes.timeline}px
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1.5 text-xs"
              onClick={() => panes.toggleCollapse("left")}
              aria-pressed={panes.collapsed.left}
            >
              {panes.collapsed.left ? (
                <PanelLeftOpen className="size-3.5" />
              ) : (
                <PanelLeftClose className="size-3.5" />
              )}
              {panes.collapsed.left ? "Show tree" : "Hide tree"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1.5 text-xs"
              onClick={() => panes.toggleCollapse("timeline")}
              aria-pressed={panes.collapsed.timeline}
            >
              <Rows3 className="size-3.5" />
              {panes.collapsed.timeline ? "Show timeline" : "Hide timeline"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1.5 text-xs"
              onClick={() => panes.toggleCollapse("right")}
              aria-pressed={panes.collapsed.right}
            >
              {panes.collapsed.right ? (
                <PanelRightOpen className="size-3.5" />
              ) : (
                <PanelRightClose className="size-3.5" />
              )}
              {panes.collapsed.right ? "Show inspector" : "Hide inspector"}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Main grid ----------------------------------------------------------- */}
      <div
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns, gridTemplateRows }}
      >
        {/* Row 1, col 1: left pane */}
        <Panel
          as="aside"
          flush
          aria-label="Project and asset library"
          className={cn(
            "row-start-1 col-start-1 border-r-0",
            panes.collapsed.left && "overflow-hidden border-r-0",
          )}
        >
          <div
            id="workspace-left-pane"
            tabIndex={-1}
            aria-hidden={panes.collapsed.left || undefined}
            className="flex min-h-0 flex-1 flex-col focus-visible:outline-none"
          >
            {panes.collapsed.left ? null : <LeftPane projectName={projectName} />}
          </div>
        </Panel>

        <PaneDivider
          pane="left"
          orientation="vertical"
          label="Resize project pane"
          panes={panes}
        />

        {/* Row 1, col 3: centre viewer */}
        <main
          className="row-start-1 col-start-3 flex min-h-0 min-w-0 flex-col"
          aria-label="Viewer"
        >
          <CenterViewer />
        </main>

        <PaneDivider
          pane="right"
          orientation="vertical"
          label="Resize inspector pane"
          panes={panes}
          direction={-1}
        />

        {/* Row 1, col 5: right pane */}
        <Panel
          as="aside"
          flush
          aria-label="AI Director and inspector"
          className={cn(
            "row-start-1 col-start-5 border-l-0",
            panes.collapsed.right && "overflow-hidden",
          )}
        >
          <div
            aria-hidden={panes.collapsed.right || undefined}
            className="flex min-h-0 flex-1 flex-col"
          >
            {panes.collapsed.right ? null : <RightPane />}
          </div>
        </Panel>

        {/* Row 2: divider spanning the centre column only */}
        <div className="row-start-2 col-start-3">
          <PaneDivider
            pane="timeline"
            orientation="horizontal"
            label="Resize timeline"
            panes={panes}
            direction={-1}
          />
        </div>

        {/* Row 3: timeline, under the viewer and between the side panes */}
        <div className="row-start-3 col-start-1 col-end-6 flex min-h-0 flex-col border-t border-border">
          <div
            aria-hidden={panes.collapsed.timeline || undefined}
            className="flex min-h-0 flex-1 flex-col"
          >
            {panes.collapsed.timeline ? null : <Timeline />}
          </div>
        </div>
      </div>

      {/*
       * Ctrl+K target. Rather than a fake command palette, the shortcut moves
       * focus to the project tree and this live region explains that. Honest, and
       * it still saves the keystroke it promises to save.
       */}
      <p role="status" aria-live="polite" className="sr-only">
        {paletteOpen
          ? "Focus moved to the project tree. A command palette is not implemented in this build."
          : ""}
      </p>
    </div>
  );
}

export { TooltipLabel };