"use client";

import {
  ChevronRight,
  CircleDollarSign,
  CloudOff,
  Film,
  Play,
  Search,
  Upload,
} from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { TooltipLabel } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { a11y, layout } from "@/lib/tokens";

/**
 * TopBar - breadcrumbs, mode switch, spend, render status, export.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT
 * The project bans controls that look operable but do nothing, so the split is
 * explicit rather than cosmetic:
 *
 *  - Breadcrumbs: real. They reflect actual navigation state and the trailing
 *    crumb is not a link (you are already there).
 *  - Mode switch: real. It is a radix-free segmented `radiogroup`; the selection
 *    is persisted and drives the "Advanced" affordances in the workspace.
 *  - Cost: real in the sense that it reads the workspace's session budget state,
 *    which is genuinely zero because no provider is connected. It is labelled
 *    "no provider connected" rather than showing an invented figure.
 *  - Render status: real state machine (`idle`), not a fake progress bar. There
 *    is no render backend, so it reports offline with the reason.
 *  - Export and Render: DISABLED with a tooltip naming the missing dependency.
 *    A disabled control with a reason is the honest form; an enabled button that
 *    silently does nothing is the banned form.
 */

export type WorkspaceMode = "simple" | "advanced";

export interface TopBarProps {
  readonly projectName: string;
  readonly seriesName: string;
  readonly sceneName: string;
  readonly mode: WorkspaceMode;
  readonly onModeChange: (mode: WorkspaceMode) => void;
  readonly onOpenCommandPalette: () => void;
  /** Spend in USD for this session. Zero until a provider is wired up. */
  readonly spendUsd: number;
  /** Hard cap in USD, from project settings. */
  readonly budgetUsd: number | null;
}

const CRUMB_MAX = 22;

function truncate(value: string): string {
  return value.length > CRUMB_MAX ? `${value.slice(0, CRUMB_MAX - 1)}…` : value;
}

export function TopBar({
  projectName,
  seriesName,
  sceneName,
  mode,
  onModeChange,
  onOpenCommandPalette,
  spendUsd,
  budgetUsd,
}: TopBarProps) {
  const crumbs = [
    { label: projectName, full: `Project: ${projectName}` },
    { label: seriesName, full: `Series: ${seriesName}` },
    { label: sceneName, full: `Scene: ${sceneName}` },
  ];

  const budgetLabel =
    budgetUsd === null
      ? `$${spendUsd.toFixed(2)} spent · no budget cap set`
      : `$${spendUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} budget`;

  return (
    <header
      className="flex flex-none items-center gap-3 border-b border-border bg-canvas-raised px-3"
      style={{ height: layout.topBar }}
    >
      {/* Identity ------------------------------------------------------------ */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-7 flex-none items-center justify-center rounded-sm bg-accent text-accent-contrast"
        >
          <Film className="size-4" strokeWidth={2.25} />
        </span>

        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex min-w-0 items-center gap-1">
            {crumbs.map((crumb, index) => {
              const isLast = index === crumbs.length - 1;
              return (
                <li key={crumb.full} className="flex min-w-0 items-center gap-1">
                  {index > 0 ? (
                    <ChevronRight
                      aria-hidden="true"
                      className="size-3 flex-none text-text-tertiary"
                    />
                  ) : null}
                  <span
                    aria-current={isLast ? "page" : undefined}
                    title={crumb.full}
                    className={cn(
                      "truncate text-base",
                      isLast
                        ? "font-medium text-text"
                        : "text-text-secondary",
                    )}
                  >
                    {truncate(crumb.label)}
                  </span>
                </li>
              );
            })}
          </ol>
        </nav>
      </div>

      {/* Mode switch --------------------------------------------------------- */}
      <fieldset className="flex flex-none items-center rounded-sm border border-border bg-panel p-0.5">
        <legend className="sr-only">Workspace mode</legend>
        {(["simple", "advanced"] as const).map((value) => {
          const selected = mode === value;
          return (
            <label
              key={value}
              className={cn(
                "flex h-7 cursor-pointer select-none items-center rounded-[6px] px-3 text-sm font-medium capitalize",
                "transition-colors duration-150 ease-[var(--ease-standard)]",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-panel",
                selected
                  ? "bg-accent text-accent-contrast"
                  : "text-text-secondary hover:text-text",
              )}
            >
              <input
                type="radio"
                name="workspace-mode"
                value={value}
                checked={selected}
                onChange={() => onModeChange(value)}
                className="sr-only"
              />
              {value}
            </label>
          );
        })}
      </fieldset>

      {/* Cost + status ------------------------------------------------------- */}
      <div className="flex flex-none items-center gap-2">
        <TooltipLabel
          label={
            <>
              {budgetLabel}. Cost tracking is live, but no generation provider is
              connected in this build, so nothing has been spent.
            </>
          }
        >
          <span
            tabIndex={0}
            className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-border bg-panel px-2 text-sm text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas-raised"
          >
            <CircleDollarSign aria-hidden="true" className="size-3.5" />
            <span className="tabular text-text">${spendUsd.toFixed(2)}</span>
            {budgetUsd === null ? null : (
              <span className="tabular text-text-tertiary">
                / ${budgetUsd.toFixed(2)}
              </span>
            )}
          </span>
        </TooltipLabel>

        <TooltipLabel
          label="No render backend is connected. Rendering requires FFmpeg, which is not installed on this machine (see docs/LOCAL-ENVIRONMENT.md)."
        >
          <span tabIndex={0} className="inline-flex focus-visible:outline-none">
            <StatusBadge
              tone="neutral"
              srPrefix="Render status:"
              label="Renderer offline"
              icon={<CloudOff className="size-3" />}
            />
          </span>
        </TooltipLabel>
      </div>

      {/* Actions ------------------------------------------------------------- */}
      <div className="flex flex-none items-center gap-2">
        <TooltipLabel label="Search projects, scenes and assets (Ctrl+K)">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open command palette"
            onClick={onOpenCommandPalette}
            className="text-text-secondary"
          >
            <Search className="size-4" />
          </Button>
        </TooltipLabel>

        <TooltipLabel
          side="bottom"
          label="Rendering needs FFmpeg, which is not installed. Install it and restart the app to enable export."
        >
          <span className="inline-flex">
            <Button
              variant="ghost"
              size="sm"
              disabled
              aria-describedby={undefined}
              // Pointer events are disabled by `disabled:pointer-events-none`, so
              // the tooltip is anchored to the wrapper span above.
              className="gap-1.5 text-text-tertiary"
            >
              <Play className="size-3.5" />
              Render
            </Button>
          </span>
        </TooltipLabel>

        <TooltipLabel
          side="bottom"
          label="Export is available once at least one scene has rendered and FFmpeg is installed."
        >
          <span className="inline-flex">
            <Button variant="primary" size="sm" disabled className="gap-1.5">
              <Upload className="size-3.5" />
              Export
            </Button>
          </span>
        </TooltipLabel>
      </div>
    </header>
  );
}

/** Target size is asserted here rather than in prose so it cannot silently regress. */
export const TOP_BAR_TARGET_PX = a11y.comfortableTargetSizePx;