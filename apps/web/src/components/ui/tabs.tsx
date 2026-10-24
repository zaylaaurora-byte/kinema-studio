"use client";

import * as React from "react";

import { cn } from "@/lib/cn";

/**
 * Tabs - a real ARIA tablist with roving focus.
 *
 * Keyboard contract implemented here (WAI-ARIA Authoring Practices, "Tabs with
 * Automatic Activation"):
 *   - Left/Right move between tabs and activate immediately.
 *   - Home/End jump to the first/last tab.
 *   - Only the selected tab is in the tab order (`tabIndex` 0, others -1), so
 *     Tab moves into the panel rather than through every tab.
 *   - The focused tab gets the visible `focus` ring; the *selected* tab is marked
 *     by a citron underline, a shape change, not colour alone.
 *
 * The underline is a separate absolutely-positioned element rather than a
 * `border-b` on the button, so it does not shift the text baseline between the
 * selected and unselected states.
 */

export interface TabItem {
  readonly id: string;
  readonly label: string;
  /**
   * Set when the tab exists but its content is not implemented yet. The tab stays
   * focusable and announces `disabled` to assistive tech, and the caller renders
   * an empty state with the reason. It is NOT hidden - hiding it would be the
   * "coming soon disguised as nothing" pattern the project bans.
   */
  readonly disabledReason?: string;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  readonly value: string;
  readonly onValueChange: (id: string) => void;
  /** Ties the tablist to its panel via `aria-controls` / `aria-labelledby`. */
  readonly idBase: string;
  readonly className?: string;
  readonly "aria-label": string;
}

export function Tabs({
  items,
  value,
  onValueChange,
  idBase,
  className,
  "aria-label": ariaLabel,
}: TabsProps) {
  const listRef = React.useRef<HTMLDivElement>(null);

  const focusTab = React.useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      onValueChange(item.id);
      const node = listRef.current?.querySelector<HTMLButtonElement>(
        `[data-tab-id="${CSS.escape(item.id)}"]`,
      );
      node?.focus();
    },
    [items, onValueChange],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = items.findIndex((item) => item.id === value);
    if (current < 0) return;

    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        focusTab((current + 1) % items.length);
        break;
      case "ArrowLeft":
        event.preventDefault();
        focusTab((current - 1 + items.length) % items.length);
        break;
      case "Home":
        event.preventDefault();
        focusTab(0);
        break;
      case "End":
        event.preventDefault();
        focusTab(items.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cn("flex flex-none items-center gap-1 px-2", className)}
    >
      {items.map((item) => {
        const selected = item.id === value;
        const unavailable = item.disabledReason !== undefined;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-tab-id={item.id}
            id={`${idBase}-tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${item.id}`}
            aria-disabled={unavailable || undefined}
            title={item.disabledReason}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(item.id)}
            className={cn(
              "relative flex h-8 items-center rounded-sm px-3 text-sm font-medium",
              "transition-colors duration-150 ease-[var(--ease-standard)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
              selected
                ? "text-text"
                : "text-text-tertiary hover:bg-panel-elevated hover:text-text-secondary",
              unavailable && "opacity-60",
            )}
          >
            {item.label}
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-colors duration-150",
                selected ? "bg-accent" : "bg-transparent",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly idBase: string;
  readonly tabId: string;
}

export function TabPanel({
  idBase,
  tabId,
  className,
  ...props
}: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={`${idBase}-panel-${tabId}`}
      aria-labelledby={`${idBase}-tab-${tabId}`}
      tabIndex={0}
      className={cn(
        "min-h-0 flex-1 overflow-auto",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
        className,
      )}
      {...props}
    />
  );
}