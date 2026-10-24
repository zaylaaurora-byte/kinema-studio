/**
 * Kinema design tokens.
 *
 * Derived from two things: the specification's token table (§02), and direct
 * inspection of the two supplied reference images. The references were measured rather
 * than eyeballed - their dominant colours are recorded below, which is why the canvas
 * value is anchored to real pixels from the artwork rather than chosen by taste.
 *
 *   Reference A (mint timer):    404x316, dominant #0E0F0D over 48% of pixels
 *   Reference B (yellow stopwatch): 1234x926, dominant #141413 over 50% of pixels
 *
 * Both confirm the near-black direction. The spec's proposed canvas (#0B0D0E) sits
 * between them, and is kept.
 *
 * ONE TYPOGRAPHIC RULE, taken from the spec and worth repeating because it is easy to
 * break: yellow is an ACCENT. "Preserve contrast: yellow as an accent, not dense body
 * text on black." Electric citron on near-black fails contrast at body sizes.
 */

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export const color = {
  /** Application background. The near-black everything sits on. */
  canvas: "#0B0D0E",
  /** Second background step, for sidebars and inset regions. */
  canvasRaised: "#101315",

  /** Panel surfaces. */
  panel: "#171A1D",
  panelElevated: "#202428",

  /** Borders and dividers. Kept subtle; the design relies on surface steps. */
  border: "#252A2E",
  borderStrong: "#333A3F",

  /** Text. */
  text: "#F4F5F2",
  textSecondary: "#A0A8A6",
  /**
   * Tertiary text, for timestamps and other low-priority metadata.
   *
   * Raised from the initially proposed #6F7876, which measured only 3.44:1 against the
   * elevated panel surface and therefore FAILED the WCAG 2.2 AA body-text minimum of
   * 4.5:1. This value measures at or above 4.5:1 on every surface in the palette, so it
   * remains legal for small text. See `contrast.test.ts`, which enforces this.
   */
  textTertiary: "#86908D",

  /** Primary accent: electric citron. CTAs, selection, active states. */
  accent: "#E6F55A",
  /**
   * Text colour to place ON the accent. The accent is light, so this must be dark.
   * Never use `text` on `accent`.
   */
  accentContrast: "#0B0D0E",
  accentSubtle: "#2A2F16",

  /** Optional positive-progress accent. */
  mint: "#94DDBD",
  mintContrast: "#06231A",

  /** Status. Always paired with an icon or label - never colour alone. */
  danger: "#F17E78",
  warning: "#F4C66A",
  success: "#94DDBD",
  info: "#8FB8E8",

  /** Focus ring. Must remain visible against every surface above. */
  focus: "#E6F55A",
} as const;

// ---------------------------------------------------------------------------
// Spacing, radius, type
// ---------------------------------------------------------------------------

/** 4px base scale. */
export const space = {
  0: "0",
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
  8: "32px",
  10: "40px",
  12: "48px",
  16: "64px",
  20: "80px",
  24: "96px",
} as const;

export const radius = {
  /** Compact controls: chips, inputs, small buttons. */
  sm: "8px",
  /** Panels and cards. */
  md: "12px",
  /** Large cards and modals. */
  lg: "18px",
  /** Pills and avatars. */
  full: "9999px",
} as const;

/**
 * Type scale.
 *
 * `display` is the oversized editorial face used sparingly, per the spec. It is for
 * page titles and hero moments only - not for section headings inside the workspace,
 * where it would consume vertical space the timeline needs.
 */
export const typography = {
  family: {
    sans: "'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
    display: "'Inter Variable', 'Inter', system-ui, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  },
  size: {
    xs: "11px",
    sm: "12px",
    base: "13px",
    md: "14px",
    lg: "16px",
    xl: "20px",
    "2xl": "26px",
    "3xl": "34px",
    display: "52px",
    "display-lg": "72px",
  },
  /**
   * Line heights. Body copy is generous (1.6) because creators read scripts and
   * dialogue in this app; tight leading makes long text exhausting.
   */
  leading: {
    tight: "1.15",
    snug: "1.3",
    normal: "1.5",
    relaxed: "1.6",
  },
  weight: {
    regular: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
  },
  /**
   * Tracking. Display sizes need negative tracking to look intentional; small caps
   * labels need positive tracking to stay legible.
   */
  tracking: {
    display: "-0.03em",
    heading: "-0.015em",
    normal: "0",
    label: "0.06em",
  },
} as const;

// ---------------------------------------------------------------------------
// Elevation and motion
// ---------------------------------------------------------------------------

/**
 * Elevation is expressed as a surface colour plus a hairline border rather than heavy
 * drop shadows. On a near-black canvas, large shadows read as smudges; a subtle
 * border is cleaner and keeps the interface feeling flat and precise.
 */
export const elevation = {
  none: "none",
  sm: "0 1px 2px rgba(0, 0, 0, 0.4)",
  md: "0 4px 12px rgba(0, 0, 0, 0.45)",
  lg: "0 12px 32px rgba(0, 0, 0, 0.55)",
  /** Overlays need a heavier shadow to separate from the workspace behind them. */
  overlay: "0 24px 64px rgba(0, 0, 0, 0.7)",
} as const;

/**
 * Motion durations, 140-240ms per the spec.
 *
 * The reduced-motion preference must be honoured; see `motionPreference` below. Any
 * transition that is purely decorative must collapse to zero duration, while
 * transitions that convey state (a progress ring) may remain but should simplify.
 */
export const motion = {
  duration: {
    instant: "0ms",
    fast: "140ms",
    normal: "180ms",
    slow: "240ms",
  },
  easing: {
    /** Default for most UI movement. */
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    /** For elements entering the viewport. */
    entrance: "cubic-bezier(0.16, 1, 0.3, 1)",
    /** For elements leaving. */
    exit: "cubic-bezier(0.4, 0, 1, 1)",
    /** For anything the user is dragging - should feel immediate, not eased in. */
    drag: "cubic-bezier(0.2, 0, 0, 1)",
  },
} as const;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The workspace is desktop-first, per the spec: "optimise for 1440px+ desktop, adapt
 * to tablets". These are the breakpoints used throughout.
 */
export const breakpoint = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  /** The design target. Below this the workspace switches to compact panes. */
  xl: "1280px",
  /** Full workspace with all panes open. */
  "2xl": "1440px",
  "3xl": "1920px",
} as const;

/**
 * Default pane dimensions for the four-region workspace layout the spec describes:
 * left tree/library, centre viewer, right Director/inspector, bottom timeline.
 */
export const layout = {
  leftPane: { default: 280, min: 220, max: 420 },
  rightPane: { default: 340, min: 280, max: 520 },
  timeline: { default: 240, min: 140, max: 480 },
  topBar: 52,
  /** Minimum comfortable height before the timeline crowds the viewer. */
  minViewerHeight: 320,
} as const;

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

/**
 * WCAG 2.2 AA is the stated target. These constants exist so that the requirement is
 * referenced in one place rather than restated loosely in each component.
 */
export const a11y = {
  /** AA minimum contrast for normal-size body text. */
  minContrastBody: 4.5,
  /** AA minimum for large text (>=18.66px bold or >=24px). */
  minContrastLargeText: 3,
  /** AA minimum for UI component boundaries and graphical objects. */
  minContrastNonText: 3,
  /** Minimum interactive target, WCAG 2.2 "Target Size (Minimum)". */
  minTargetSizePx: 24,
  /** Preferred target size for primary controls in a desktop app. */
  comfortableTargetSizePx: 32,
} as const;

export const tokens = {
  color,
  space,
  radius,
  typography,
  elevation,
  motion,
  breakpoint,
  layout,
  a11y,
} as const;

export type KinemaTokens = typeof tokens;
export type ColorToken = keyof typeof color;
export type SpaceToken = keyof typeof space;