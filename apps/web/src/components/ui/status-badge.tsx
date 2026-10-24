"use client";

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/cn";

/**
 * StatusBadge.
 *
 * RULE FROM THE TOKEN MODULE: status colour is never the only signal -
 *   "Status. Always paired with an icon or label - never colour alone."
 *
 * So this component always renders a text label, and callers pass an icon. The
 * colour is reinforcement, not information. A screen reader hears "Rendering",
 * not "yellow dot".
 *
 * Contrast: the tinted backgrounds are `/{n}` alpha over the panel surface, and
 * every foreground is the light token (danger/warning/success/info/mint), all of
 * which clear 4.5:1 against those tints at `text-xs`.
 */
const statusBadgeVariants = cva(
  [
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full",
    "border px-2 py-0.5 text-xs font-medium",
  ].join(" "),
  {
    variants: {
      tone: {
        neutral: "border-border-strong bg-panel-elevated text-text-secondary",
        accent: "border-accent/35 bg-accent-subtle text-accent",
        success: "border-success/35 bg-success/12 text-success",
        warning: "border-warning/35 bg-warning/12 text-warning",
        danger: "border-danger/35 bg-danger/12 text-danger",
        info: "border-info/35 bg-info/12 text-info",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusBadgeVariants> {
  /** Always rendered. A status without words is not accessible. */
  readonly label: string;
  readonly icon?: React.ReactNode;
  /** Adds a screen-reader-only prefix, e.g. "Render status:". */
  readonly srPrefix?: string;
}

export function StatusBadge({
  label,
  icon,
  tone,
  srPrefix,
  className,
  ...props
}: StatusBadgeProps) {
  return (
    <span
      className={cn(statusBadgeVariants({ tone }), className)}
      {...props}
    >
      {icon ? (
        <span aria-hidden="true" className="flex size-3 items-center justify-center">
          {icon}
        </span>
      ) : null}
      {srPrefix ? <span className="sr-only">{srPrefix}</span> : null}
      {label}
    </span>
  );
}

/** A small numeric/metadata counter, e.g. shot count or credit balance. */
export function StatChip({
  label,
  value,
  title,
  className,
}: {
  readonly label: string;
  readonly value: string;
  readonly title?: string;
  readonly className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-baseline gap-1.5 rounded-sm border border-border bg-canvas-raised px-2 py-1",
        className,
      )}
    >
      <span className="text-xs uppercase tracking-label text-text-tertiary">
        {label}
      </span>
      <span className="tabular text-sm font-medium text-text">{value}</span>
    </span>
  );
}