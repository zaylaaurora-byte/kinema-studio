"use client";

import { useSyncExternalStore } from "react";

/**
 * Tracks `prefers-reduced-motion: reduce`.
 *
 * WHY THIS EXISTS
 * `packages/config/src/tokens.ts` states the requirement explicitly:
 *
 *   "The reduced-motion preference must be honoured ... Any transition that is
 *    purely decorative must collapse to zero duration, while transitions that
 *    convey state (a progress ring) may remain but should simplify."
 *
 * `globals.css` enforces the zero-duration half in CSS. This hook is the half the
 * CSS cannot reach: JS-driven animation. `motion` animations, the spring used by
 * the pane-collapse transition, and anything else that runs outside a CSS
 * transition must consult this and drop to a no-op.
 *
 * It is built on `useSyncExternalStore` rather than `useState` + `useEffect`
 * because that gives the correct value during the very first client render - a
 * `useEffect`-based version renders once with `false` and can flash a full
 * animation at a user who explicitly asked for none.
 */

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => {};
  }
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

/**
 * The server has no media queries, so it assumes "no preference". React uses this
 * value for SSR and the first hydration pass, then re-reads the real one.
 */
function getServerSnapshot(): boolean {
  return false;
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Returns `0` when the user prefers reduced motion, otherwise the supplied
 * duration. Use as `transition={{ duration: useMotionDuration(motion.duration.normal) }}`
 * so a decorative animation collapses instead of being merely shortened.
 */
export function useMotionDuration(seconds: number): number {
  return useReducedMotion() ? 0 : seconds;
}