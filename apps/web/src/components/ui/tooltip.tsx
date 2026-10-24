"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import { cn } from "@/lib/cn";

/**
 * Tooltip.
 *
 * The project bans decorative controls, which means a disabled button is only
 * honest if it says WHY it is disabled. That makes this component load-bearing
 * rather than optional: `Button` with `disabled` renders without pointer events,
 * so the tooltip must be attached to a wrapper element to still fire.
 *
 * Radix handles the hard parts - hover/focus intent delays, `aria-describedby`
 * wiring, and dismissal on Escape (WCAG 1.4.13 "Content on Hover or Focus").
 */

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 8, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-50 max-w-72 rounded-sm border border-border-strong bg-panel-elevated",
          "px-3 py-2 text-sm leading-normal text-text shadow-overlay",
          "origin-[var(--radix-tooltip-content-transform-origin)]",
          "data-[state=delayed-open]:animate-in data-[state=closed]:animate-out",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});

/**
 * Convenience wrapper for the common case: a single element that needs a label.
 *
 * `children` is cloned by Radix's `asChild`, so the caller's element keeps its
 * own semantics (a `<button>`, an `<a>`) and gains `aria-describedby`.
 */
export function TooltipLabel({
  label,
  children,
  side = "bottom",
  /** Skip the wrapper entirely when there is nothing to say. */
}: {
  readonly label: React.ReactNode;
  readonly children: React.ReactNode;
  readonly side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}