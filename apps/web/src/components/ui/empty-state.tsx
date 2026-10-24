"use client";

import * as React from "react";

import { cn } from "@/lib/cn";

/**
 * EmptyState.
 *
 * This is the honest alternative to a fake populated list. The project's
 * contributing guide bans "hardcoded demo results presented as real output", so
 * every region that has no data renders one of these instead: a plain statement
 * of what is missing, and - when a next step exists - one real action.
 *
 * The illustration is a geometric outline, not a decorative mascot; it echoes the
 * reference images' flat, high-contrast geometry without pretending to be art.
 */
export interface EmptyStateProps {
  readonly icon?: React.ReactNode;
  readonly title: string;
  readonly description: string;
  /** Only pass actions that genuinely do something. */
  readonly action?: React.ReactNode;
  readonly className?: string;
  readonly compact?: boolean;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-12",
        className,
      )}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className={cn(
            "flex items-center justify-center rounded-md border border-dashed border-border-strong text-text-tertiary",
            compact ? "size-8" : "size-12",
          )}
        >
          {icon}
        </div>
      ) : null}
      <p className="text-md font-medium text-text-secondary">{title}</p>
      <p className="max-w-72 text-sm leading-relaxed text-text-tertiary">
        {description}
      </p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}