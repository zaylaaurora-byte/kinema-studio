import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class names and de-duplicate conflicting Tailwind utilities.
 *
 * `clsx` handles the conditionals; `twMerge` makes the last conflicting utility
 * win so that a caller passing `className="px-6"` genuinely overrides a component
 * default of `px-3` instead of producing both.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}