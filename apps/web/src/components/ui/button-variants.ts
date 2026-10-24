import { cva, type VariantProps } from "class-variance-authority";

/**
 * Button styling, deliberately separated from the `Button` component.
 *
 * WHY THIS FILE HAS NO `"use client"`
 * `buttonVariants()` is a plain function that returns a class string. Calling it
 * from a Server Component is legitimate - it computes a string and renders
 * nothing. But when it lived in `button.tsx`, that module carried `"use client"`
 * because `Button` needs `forwardRef`, and Next then treated the *function* as a
 * client reference. The landing page hit:
 *
 *     Attempted to call buttonVariants() from the server but buttonVariants is
 *     on the client.
 *
 * Keeping the variant map in a directive-free module means server components can
 * style a `<Link>` as a button without pulling React client runtime in for it.
 *
 * The class strings themselves are documented in `button.tsx`.
 */
export const buttonVariants = cva(
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
        /** Text-only, for tertiary actions inside dense rows. */
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

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;