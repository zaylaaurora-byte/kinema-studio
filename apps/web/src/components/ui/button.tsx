"use client";

import { Slot } from "@radix-ui/react-slot";
import * as React from "react";

import {
  buttonVariants,
  type ButtonVariantProps,
} from "@/components/ui/button-variants";
import { cn } from "@/lib/cn";

/**
 * Button.
 *
 * Design direction (from the reference images, not copied from them): near-black
 * surfaces, one restrained citron accent, rounded controls, generous negative
 * space. The primary button is the only place the citron appears as a large fill,
 * which is what keeps it reading as an accent rather than as a theme.
 *
 * ACCESSIBILITY, stated because it is the easiest thing here to break:
 *  - Text on `accent` uses `text-accent-contrast` (dark). The accent is LIGHT;
 *    `text-text` on it measures far below the 4.5:1 AA minimum. Never swap it.
 *  - `danger` is a light desaturated red on a dark tint, so body text stays
 *    legible; it is never a saturated red fill with white text.
 *  - `disabled` is real, not decorative. The project bans buttons that look
 *    pressable but do nothing, so `disabled` also removes the cursor affordance
 *    and every hover response. Callers MUST wrap a disabled control in a Tooltip
 *    explaining why (WCAG 3.3.1, and the project's "honest UI" rule).
 *  - Minimum height is 32px (`a11y.comfortableTargetSizePx`), above the 24px
 *    WCAG 2.2 floor. `size="sm"` is the smallest and is still 32px.
 *
 * The class strings live in `button-variants.ts` so server components can call
 * `buttonVariants()` without triggering a client-reference error.
 */

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    ButtonVariantProps {
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
export type { ButtonVariantProps };