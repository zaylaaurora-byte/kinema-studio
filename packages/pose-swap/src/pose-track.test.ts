/**
 * `PoseTrack` tests — the primitive, and the boundary rule that is the classic bug.
 *
 * These are behavioural tests, not structural ones: they assert what a VIEWER would see
 * (which pose is on screen at a given instant) rather than what the data structure looks
 * like. A test that asserted "entries are sorted" would pass while the animation was one
 * frame late.
 */

import { describe, expect, it } from "vitest";
import {
  countPoseSwitches,
  holds,
  poseTrack,
  posesInTrack,
  samplePose,
  samplePoseEntry,
  switchTimes,
  totalDuration,
} from "./pose-track.js";

describe("poseTrack construction", () => {
  it("accepts a well-formed track", () => {
    const track = poseTrack("ok", [
      { time: 0, poseId: "neutral" },
      { time: 0.4, poseId: "wave" },
      { time: 1.2, poseId: "neutral" },
    ]);
    expect(track.name).toBe("ok");
    expect(track.entries).toHaveLength(3);
  });

  it("rejects an empty track", () => {
    expect(() => poseTrack("empty", [])).toThrow(/has no entries/);
  });

  it("rejects OUT-OF-ORDER entries with a clear error naming the index and times", () => {
    const build = (): unknown =>
      poseTrack("bad", [
        { time: 0, poseId: "a" },
        { time: 1.5, poseId: "b" },
        { time: 0.8, poseId: "c" },
      ]);

    expect(build).toThrow(/out of order/);
    // The message must be actionable: which entry, and what it conflicts with.
    expect(build).toThrow(/index 2 is at t=0.8s but index 1 is at t=1.5s/);
  });

  it("rejects two entries at the SAME time, since one pose would never be visible", () => {
    const build = (): unknown =>
      poseTrack("overlap", [
        { time: 0, poseId: "a" },
        { time: 0.5, poseId: "b" },
        { time: 0.5, poseId: "c" },
      ]);

    expect(build).toThrow(/two entries at t=0.5s/);
    expect(build).toThrow(/never be visible/);
  });

  it("rejects a negative time", () => {
    expect(() =>
      poseTrack("negative", [{ time: -0.1, poseId: "a" }]),
    ).toThrow(/negative time/);
  });

  it("rejects a non-finite time", () => {
    expect(() =>
      poseTrack("nan", [{ time: Number.NaN, poseId: "a" }]),
    ).toThrow(/non-finite/);
  });

  it("does NOT mutate or reorder the caller's array", () => {
    const entries = [
      { time: 0, poseId: "a" },
      { time: 1, poseId: "b" },
    ];
    const track = poseTrack("copy", entries);
    expect(track.entries).not.toBe(entries);
    expect(entries).toHaveLength(2);
  });
});

describe("samplePose — the boundary rule", () => {
  /**
   * THE headline test for this whole technique.
   *
   * At EXACTLY a switch time the NEW pose is active. One tick before, the OLD one is. Get
   * this backwards and every pose change in the show lands one frame late, which reads on
   * screen as the character reacting after the line rather than with it.
   */
  const track = poseTrack("boundary", [
    { time: 0, poseId: "A" },
    { time: 1, poseId: "B" },
    { time: 2.5, poseId: "C" },
  ]);

  it("returns the OLD pose one tick before the switch", () => {
    // A tick here is one frame at 60fps, which is the resolution the renderer works at.
    expect(samplePose(track, 1 - 1 / 60)).toBe("A");
    expect(samplePose(track, 0.999999)).toBe("A");
  });

  it("returns the NEW pose AT EXACTLY the switch time", () => {
    expect(samplePose(track, 1)).toBe("B");
    expect(samplePose(track, 2.5)).toBe("C");
  });

  it("returns the NEW pose just after the switch", () => {
    expect(samplePose(track, 1 + 1 / 60)).toBe("B");
    expect(samplePose(track, 2.5000001)).toBe("C");
  });

  it("switches at t=0 to the first pose rather than holding nothing", () => {
    expect(samplePose(track, 0)).toBe("A");
  });

  it("holds the FIRST pose before the track begins", () => {
    const late = poseTrack("late", [
      { time: 5, poseId: "A" },
      { time: 6, poseId: "B" },
    ]);
    expect(samplePose(late, 0)).toBe("A");
    expect(samplePose(late, -100)).toBe("A");
    expect(samplePose(late, 4.999)).toBe("A");
    // t=5 is the START of A's hold, not a switch into B. A is the first entry, so it is
    // active AT its own time and holds until the next entry. (The "new pose at exactly the
    // switch time" rule applies to B at t=6.)
    expect(samplePose(late, 5)).toBe("A");
    expect(samplePose(late, 5.999)).toBe("A");
    expect(samplePose(late, 6)).toBe("B");
  });

  it("holds the LAST pose after the track ends, indefinitely", () => {
    expect(samplePose(track, 2.5)).toBe("C");
    expect(samplePose(track, 3)).toBe("C");
    expect(samplePose(track, 1000)).toBe("C");
  });
});

describe("holds — a pose held over a span returns the same id throughout", () => {
  const track = poseTrack("spans", [
    { time: 0, poseId: "A" },
    { time: 0.4, poseId: "B" },
    { time: 1.2, poseId: "C" },
  ]);

  it("returns one id across the whole of a hold", () => {
    // Walk the interior of the 0.4 -> 1.2 hold at 60fps. Every sample must be B: a single
    // differing frame inside a hold is exactly the drift this technique forbids.
    for (let frame = 24; frame < 72; frame++) {
      expect(samplePose(track, frame / 60)).toBe("B");
    }
  });

  it("derives hold bars with correct start, end and duration", () => {
    const bars = holds(track, 2.0);
    expect(bars).toHaveLength(3);

    // Times are exact (they come straight from the entries); DURATIONS are a subtraction of
    // decimal seconds, so they are compared with a tolerance rather than for bit equality.
    // 0.4 -> 1.2 is 0.7999999999999999 in IEEE754, and asserting exact equality there would
    // be testing floating point rather than this code.
    expect(bars[0]).toMatchObject({ poseId: "A", startTime: 0, endTime: 0.4 });
    expect(bars[0]!.duration).toBeCloseTo(0.4, 12);
    expect(bars[1]).toMatchObject({ poseId: "B", startTime: 0.4, endTime: 1.2 });
    expect(bars[1]!.duration).toBeCloseTo(0.8, 12);
    expect(bars[2]).toMatchObject({ poseId: "C", startTime: 1.2, endTime: 2.0 });
    expect(bars[2]!.duration).toBeCloseTo(0.8, 12);
  });

  it("leaves the final hold open-ended when no 'until' is given", () => {
    const bars = holds(track);
    const last = bars[bars.length - 1]!;
    // Truthful: a track genuinely does not know how long its last pose is held.
    expect(last.endTime).toBeUndefined();
    expect(last.duration).toBeUndefined();
  });

  it("merges consecutive entries naming the SAME pose into one hold", () => {
    // Two entries, one drawing. Presenting these as two bars would show a cut that a
    // viewer cannot see, and invite an editor to trim a non-existent one.
    const repeated = poseTrack("repeated", [
      { time: 0, poseId: "A" },
      { time: 0.5, poseId: "A" },
      { time: 1.0, poseId: "B" },
    ]);
    const bars = holds(repeated, 1.5);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ poseId: "A", startTime: 0, endTime: 1.0 });
    expect(bars[0]!.duration).toBeCloseTo(1.0, 12);
  });

  it("rejects an 'until' before the track starts", () => {
    expect(() => holds(track, -1)).toThrow(/before the track's first entry/);
  });
});

describe("totalDuration, posesInTrack and switchTimes", () => {
  const track = poseTrack("meta", [
    { time: 0, poseId: "A" },
    { time: 0.5, poseId: "B" },
    { time: 0.5 + 0.3, poseId: "A" },
    { time: 1.5, poseId: "C" },
  ]);

  it("reports the time of the last switch as the total duration", () => {
    expect(totalDuration(track)).toBe(1.5);
  });

  it("reports distinct poses in first-appearance order", () => {
    expect(posesInTrack(track)).toEqual(["A", "B", "C"]);
  });

  it("reports switch times excluding t=0, which is a start and not a switch", () => {
    expect(switchTimes(track)).toEqual([0.5, 0.8, 1.5]);
  });
});

describe("samplePoseEntry", () => {
  const track = poseTrack("entries", [
    { time: 0, poseId: "A" },
    { time: 1, poseId: "B" },
  ]);

  it("reports the active entry and the start of its hold", () => {
    expect(samplePoseEntry(track, 0.5)).toMatchObject({
      poseId: "A",
      startTime: 0,
      index: 0,
    });
    // At the boundary it is the new entry, consistently with `samplePose`.
    expect(samplePoseEntry(track, 1)).toMatchObject({
      poseId: "B",
      startTime: 1,
      index: 1,
    });
  });

  it("agrees with samplePose at every frame of a track", () => {
    const busy = poseTrack("busy", [
      { time: 0, poseId: "A" },
      { time: 0.3, poseId: "B" },
      { time: 0.6, poseId: "A" },
      { time: 1.1, poseId: "C" },
    ]);
    for (let frame = 0; frame <= 90; frame++) {
      const t = frame / 60;
      expect(samplePoseEntry(busy, t).poseId).toBe(samplePose(busy, t));
    }
  });
});

describe("countPoseSwitches", () => {
  it("counts changes in the active pose, not distinct poses", () => {
    const alternating = poseTrack("alt", [
      { time: 0, poseId: "A" },
      { time: 0.25, poseId: "B" },
      { time: 0.5, poseId: "A" },
      { time: 0.75, poseId: "B" },
    ]);
    // A -> B -> A -> B over one second at 60fps is three changes.
    expect(countPoseSwitches(alternating, 1, 60)).toBe(3);
  });

  it("counts zero for a track that never changes pose", () => {
    const frozen = poseTrack("frozen", [
      { time: 0, poseId: "A" },
      { time: 0.5, poseId: "A" },
      { time: 1, poseId: "A" },
    ]);
    expect(countPoseSwitches(frozen, 1, 60)).toBe(0);
  });

  it("rejects a non-positive fps", () => {
    const t = poseTrack("t", [{ time: 0, poseId: "A" }]);
    expect(() => countPoseSwitches(t, 1, 0)).toThrow(/positive fps/);
  });
});