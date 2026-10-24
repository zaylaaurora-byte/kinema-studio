/**
 * Test helpers.
 *
 * One rule here: a fixed clock. Every timestamp in this package flows through an injected
 * `now`, and the tests supply a counter rather than the real clock. That is what lets a plan
 * be asserted to be *identical* between two runs — with a real clock, two identical plans
 * would differ by a timestamp and the determinism test would be measuring the clock.
 */

import type { ToolContext } from "../tool.js";

/**
 * A deterministic clock, advancing one second per call.
 *
 * Advancing rather than frozen so that ordering assertions are meaningful: an audit trail
 * whose events share a timestamp cannot be shown to be in the right order.
 */
export function makeClock(startIso = "2026-01-01T00:00:00.000Z"): () => string {
  let offsetMs = 0;
  const start = Date.parse(startIso);
  return () => {
    const value = new Date(start + offsetMs).toISOString();
    offsetMs += 1000;
    return value;
  };
}

/** Build a ToolContext for tests. */
export function makeContext(
  overrides: {
    aborted?: boolean;
    artifacts?: Readonly<Record<string, unknown>>;
    taskId?: string;
    role?: string;
    invocationId?: string;
  } = {},
): ToolContext {
  return {
    invocationId: overrides.invocationId ?? "inv-1",
    taskId: overrides.taskId ?? "task-1",
    ...(overrides.role !== undefined ? { role: overrides.role } : {}),
    artifacts: overrides.artifacts ?? {},
    ...(overrides.aborted !== undefined ? { signal: { aborted: overrides.aborted } } : {}),
    now: makeClock(),
  };
}

/** A cancellation signal stub, matching the structural type the executor accepts. */
export function makeSignal(): { aborted: boolean } {
  return { aborted: false };
}