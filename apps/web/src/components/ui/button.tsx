"use client";

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/cn";

/**
 * Button.
 *
 * Design direction (from the reference images, not copied from them): near-black
 * surfaces, one restrained citron accent, rounded controls, generous negative
 * space. The primary button is the only place the citron appears as a large fill,
 * which is what keeps it reading as an accent rather than a theme.
 *
 * ACCESSIBILITY, stated because it is the easiest thing in this file to break:
 *  - Text on `accent` uses `text-accent-contrast` (dark). The accent is LIGHT;
 *    `text-text` on it measures far below the 4.5:1 AA minimum. Never swap it.
 *  - `danger` is a light desaturated red on a dark tint, so body text stays
 *    legible; it is never a saturated red fill with white text.
 *  - `disabled` is real, not decorative. The project bans buttons that look
 *    pressable but do nothing, so `disabled` also removes the cursor affordance
 *    and any hover response. Callers must wrap a disabled control in a Tooltip
 *    explaining why (WCAG 3.3.1 / the project's "honest UI" rule).
 *  - Minimum target is 32px tall (comfortableTargetSizePx), above the 24px
 *    WCAG 2.2 floor.
 */
const buttonVariants = cva(
  [
    "relative inline-flex select-none items-center justify-center gap-2",
    "whitespace-nowrap font-medium",
    "transition-colors duration-150 ease-[var(--ease-standard)]",
    // Focus: the token focus colour, via a ring rather than an outline so it
    // follows the border radius exactly.
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
    "disabled:pointer-events-none disabled:opacity-40",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-contrast hover:bg-accent/90 active:bg-accent/80",
        secondary:
          "border border-border-strong bg-panel-elevated text-text hover:bg-panel hover:border-border-strong/80",
        ghost:
          "bg-transparent text-text-secondary hover:bg-panel-elevated hover:text-text",
        danger:
          "border border-danger/40 bg-danger/12 text-danger hover:bg-danger/20 hover:border-danger/60",
        /** Text-only, for tertiary actions inside dense rows (breadcrumbs, panel footers). */
        link: "h-auto bg-transparent p-0 text-text-secondary underline-offset-4 hover:text-text hover:underline",
      },
      size: {
        sm: "h-8 rounded-sm px-3 text-sm",
        md: "h-9 rounded-sm px-4 text-base",
        lg: "h-11 rounded-md px-6 text-md",
        icon: "size-8 rounded-sm p-0",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * Render as the single child element instead of a `<button>`. Used for links
   * that must look like buttons without nesting an anchor inside a button.
   */
  readonly asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ className, variant, size, asChild = false, ...props }, ref) {
    const Component = asChild ? Slot : "button";
    return (
      <Component
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);

export { buttonVariants };