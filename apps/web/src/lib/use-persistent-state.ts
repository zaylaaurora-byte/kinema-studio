"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * `useState` that persists to `localStorage`.
 *
 * Handles the three things a naive implementation gets wrong:
 *
 *  1. **SSR mismatch.** The server has no storage, so the first render always
 *     uses `initialValue` and the stored value is applied after mount. Rendering
 *     the stored value during hydration would make the server and client markup
 *     disagree and React would discard the tree.
 *  2. **Corrupt or foreign data.** A value that fails `parse` or `validate` is
 *     discarded and the default kept, so a stale schema from an older build
 *     cannot crash the workspace on load.
 *  3. **Storage being unavailable.** Safari private mode and some enterprise
 *     policies throw on `localStorage` access. Every call is guarded; losing
 *     persistence is acceptable, losing the app is not.
 */
export function usePersistentState<T>(
  key: string,
  initialValue: T,
  options?: {
    /** Reject values that are structurally wrong for the current schema. */
    readonly validate?: (value: unknown) => value is T;
  },
): readonly [T, (next: T) => void, boolean] {
  const validate = options?.validate;
  const [value, setValue] = useState<T>(initialValue);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(key);
    } catch {
      // Storage blocked. Keep the default and mark hydrated so consumers stop
      // waiting for a restore that is never coming.
      setHydrated(true);
      return;
    }

    if (stored !== null) {
      try {
        const parsed: unknown = JSON.parse(stored);
        if (validate === undefined || validate(parsed)) {
          setValue(parsed as T);
        }
      } catch {
        // Unparseable: drop it rather than throw during render.
      }
    }
    setHydrated(true);
  }, [key, validate]);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Quota exceeded or storage blocked. The in-memory value still updates,
        // so the UI stays correct for this session.
      }
    },
    [key],
  );

  return [value, set, hydrated] as const;
}