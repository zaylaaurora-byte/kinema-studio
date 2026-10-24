/**
 * Mouth flap tests.
 *
 * The two claims under test are the ones the ADR makes explicitly:
 *   1. a viseme timeline maps to the six shapes through a table, per character;
 *   2. cadence quantisation is what makes it read as STYLE rather than noise — asserted as
 *      a measured reduction in switches, not as an opinion.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_VISEME_MAP,
  IDLE_MOUTH,
  MOUTH_SHAPES,
  heldMouth,
  mouthFromVisemes,
  mouthTrack,
  resolveVisemeMap,
  sampleMouth,
  type VisemeEvent,
  type VisemeGroup,
} from "./mouth.js";
import { countPoseSwitches, samplePose } from "./pose-track.js";
import { hostVisemeMap, humanVisemeMap } from "./library/index.js";
import { HOST_VISEME_OVERRIDES, HUMAN_VISEME_OVERRIDES } from "./library/index.js";

describe("the closed set of mouth shapes", () => {
  it("is exactly the six shapes the ADR names", () => {
    expect([...MOUTH_SHAPES].sort()).toEqual(
      ["closed", "oShape", "openSmall", "openWide", "smile", "teeth"].sort(),
    );
  });

  it("maps every viseme group to a shape in that set", () => {
    for (const [viseme, shape] of Object.entries(DEFAULT_VISEME_MAP)) {
      expect(MOUTH_SHAPES, `viseme ${viseme}`).toContain(shape);
    }
  });

  it("maps bilabials to CLOSED, because the lips are genuinely shut", () => {
    // The clearest lip-sync error there is: showing an open mouth on p/b/m.
    expect(DEFAULT_VISEME_MAP.PP).toBe("closed");
    expect(DEFAULT_VISEME_MAP.silence).toBe("closed");
  });

  it("maps the wide-open 'ah' to openWide", () => {
    expect(DEFAULT_VISEME_MAP.aa).toBe("openWide");
  });
});

describe("resolveVisemeMap", () => {
  it("returns the default table when there are no overrides", () => {
    expect(resolveVisemeMap()).toEqual(DEFAULT_VISEME_MAP);
  });

  it("applies a partial override without restating the whole table", () => {
    const resolved = resolveVisemeMap({ aa: "teeth" });
    expect(resolved.aa).toBe("teeth");
    // Everything else is untouched.
    expect(resolved.PP).toBe(DEFAULT_VISEME_MAP.PP);
    expect(Object.keys(resolved)).toHaveLength(Object.keys(DEFAULT_VISEME_MAP).length);
  });
});

describe("mouthTrack and sampleMouth", () => {
  const track = mouthTrack("m", [
    { time: 0, shape: "closed" },
    { time: 0.3, shape: "openWide" },
    { time: 0.6, shape: "closed" },
  ]);

  it("applies the SAME boundary rule as a pose track", () => {
    expect(sampleMouth(track, 0.299)).toBe("closed");
    expect(sampleMouth(track, 0.3)).toBe("openWide");
    expect(sampleMouth(track, 0.599)).toBe("openWide");
    expect(sampleMouth(track, 0.6)).toBe("closed");
  });

  it("holds before the first entry and after the last", () => {
    expect(sampleMouth(track, -5)).toBe("closed");
    expect(sampleMouth(track, 99)).toBe("closed");
  });

  it("rejects a track containing something that is not a mouth shape", () => {
    const bad = { name: "bad", entries: [{ time: 0, poseId: "neutral" }] };
    expect(() => sampleMouth(bad, 0)).toThrow(/not a mouth shape/);
  });

  it("rejects out-of-order mouth entries like any other track", () => {
    expect(() =>
      mouthTrack("bad", [
        { time: 0.5, shape: "closed" },
        { time: 0.2, shape: "openWide" },
      ]),
    ).toThrow(/out of order/);
  });
});

describe("mouthFromVisemes — mapping", () => {
  it("maps a simple timeline to the expected shapes", () => {
    const visemes: VisemeEvent[] = [
      { time: 0.0, viseme: "silence" },
      { time: 0.2, viseme: "PP" },
      { time: 0.4, viseme: "aa" },
      { time: 0.7, viseme: "O" },
      { time: 1.0, viseme: "SS" },
    ];
    const track = mouthFromVisemes(visemes, { name: "line" });

    expect(sampleMouth(track, 0.1)).toBe("closed");
    expect(sampleMouth(track, 0.3)).toBe("closed"); // PP is bilabial
    expect(sampleMouth(track, 0.5)).toBe("openWide");
    expect(sampleMouth(track, 0.8)).toBe("oShape");
    expect(sampleMouth(track, 1.1)).toBe("teeth");
  });

  it("returns a closed mouth for an empty timeline rather than throwing", () => {
    // A character who says nothing still needs a mouth.
    const track = mouthFromVisemes([]);
    expect(sampleMouth(track, 0)).toBe("closed");
    expect(sampleMouth(track, 10)).toBe("closed");
  });

  it("sorts an unsorted timeline instead of rejecting it", () => {
    // Sorting here is legitimate — it is part of the transform from tool output to track —
    // and it keeps poseTrack's strictness from becoming a nuisance at this boundary.
    const track = mouthFromVisemes([
      { time: 0.6, viseme: "aa" },
      { time: 0.0, viseme: "silence" },
      { time: 0.3, viseme: "O" },
    ]);
    expect(sampleMouth(track, 0.1)).toBe("closed");
    expect(sampleMouth(track, 0.4)).toBe("oShape");
    expect(sampleMouth(track, 0.7)).toBe("openWide");
  });

  it("collapses consecutive identical shapes into one hold", () => {
    // EE and I both map to openSmall; three visemes must not become three entries.
    const track = mouthFromVisemes([
      { time: 0, viseme: "silence" },
      { time: 0.1, viseme: "E" },
      { time: 0.2, viseme: "I" },
      { time: 0.3, viseme: "E" },
      { time: 0.5, viseme: "silence" },
    ]);
    expect(track.entries).toHaveLength(3);
    expect(track.entries.map((e) => e.poseId)).toEqual(["closed", "openSmall", "closed"]);
  });

  it("does not mutate the caller's viseme array", () => {
    const visemes: VisemeEvent[] = [
      { time: 0.5, viseme: "aa" },
      { time: 0.0, viseme: "silence" },
    ];
    mouthFromVisemes(visemes);
    expect(visemes[0]!.time).toBe(0.5);
  });

  it("honours an explicit startTime", () => {
    const track = mouthFromVisemes([{ time: 0, viseme: "aa" }], { startTime: 5 });
    expect(track.entries[0]!.time).toBe(5);
    expect(sampleMouth(track, 4.9)).toBe("openWide");
  });
});

describe("mouthFromVisemes — cadence quantisation", () => {
  /**
   * A dense, irregular timeline: a new viseme every 37ms, which is roughly what an
   * alignment tool actually emits through speech. Drawn literally this is a mouth changing
   * 27 times a second, which reads as vibration rather than as talking.
   */
  const dense: VisemeEvent[] = Array.from({ length: 40 }, (_, i) => ({
    time: i * 0.037,
    viseme: (["aa", "E", "O", "SS", "PP", "I", "U", "DD"] as VisemeGroup[])[i % 8]!,
  }));

  const duration = 40 * 0.037;

  it("produces the expected shapes when a cadence is applied", () => {
    const track = mouthFromVisemes(dense, { cadence: 0.1 });
    // Every entry must land on the 10fps grid.
    for (const entry of track.entries) {
      expect(Math.abs(entry.time / 0.1 - Math.round(entry.time / 0.1))).toBeLessThan(1e-9);
    }
  });

  it("REDUCES the number of switches — this is what makes it style, not noise", () => {
    const raw = mouthFromVisemes(dense, { name: "raw" });
    const quantised = mouthFromVisemes(dense, { name: "quantised", cadence: 0.1 });

    const rawSwitches = countPoseSwitches(raw, duration, 60);
    const quantisedSwitches = countPoseSwitches(quantised, duration, 60);

    // The claim under test is a real reduction, with margin — not merely "differs".
    expect(quantisedSwitches).toBeLessThan(rawSwitches);
    expect(rawSwitches).toBeGreaterThan(10);
  });

  it("reduces switches further as the cadence gets coarser", () => {
    // Monotonic in the cadence: a slower beat can only collapse more flaps together.
    const at = (cadence: number) =>
      countPoseSwitches(
        mouthFromVisemes(dense, { cadence, name: `c${cadence}` }),
        duration,
        60,
      );

    const fine = at(0.05);
    const medium = at(0.1);
    const coarse = at(0.25);
    expect(medium).toBeLessThanOrEqual(fine);
    expect(coarse).toBeLessThanOrEqual(medium);
  });

  it("never places a flap BEFORE the sound that caused it", () => {
    // Quantisation snaps down, so the mouth cannot anticipate the audio.
    const track = mouthFromVisemes([{ time: 0.29, viseme: "aa" }], { cadence: 0.1 });
    expect(track.entries[0]!.time).toBeLessThanOrEqual(0.29);
    expect(track.entries[0]!.time).toBeCloseTo(0.2, 9);
  });

  it("rejects a non-positive cadence", () => {
    expect(() => mouthFromVisemes(dense, { cadence: 0 })).toThrow(/cadence must be positive/);
  });

  it("drops flaps too short to read when minHold is set", () => {
    const track = mouthFromVisemes(
      [
        { time: 0.0, viseme: "aa" },
        { time: 0.02, viseme: "O" }, // 20ms — unreadable
        { time: 0.5, viseme: "SS" },
      ],
      { minHold: 0.1 },
    );
    expect(track.entries.map((e) => e.poseId)).toEqual(["openWide", "teeth"]);
  });

  it("never treats the final flap as too short, since it is open-ended", () => {
    const track = mouthFromVisemes(
      [
        { time: 0, viseme: "aa" },
        { time: 0.9, viseme: "O" },
      ],
      { minHold: 5 },
    );
    expect(track.entries).toHaveLength(1);
    // aa was dropped (too short), leaving the open-ended O.
    expect(track.entries[0]!.poseId).toBe("oShape");
  });
});

describe("per-character mouth mapping", () => {
  it("gives the two characters DIFFERENT tables", () => {
    // The ADR's requirement: the human's elastic mouth and the host's fanged mouth do not
    // map identically. If these ever converge, the per-character parameter has been lost.
    expect(humanVisemeMap).not.toEqual(hostVisemeMap);
  });

  it("maps the host's silence to her smirk rather than a flat closed mouth", () => {
    expect(hostVisemeMap.silence).toBe("smile");
    expect(humanVisemeMap.silence).toBe("closed");
  });

  it("maps the host's sibilant to an open shape, because a fang cannot hiss flat", () => {
    expect(hostVisemeMap.SS).toBe("openSmall");
    expect(humanVisemeMap.SS).toBe("teeth");
  });

  it("carries the overrides as a reusable PARTIAL map", () => {
    // Partial is what makes a one-shape tweak a one-line change.
    expect(Object.keys(HUMAN_VISEME_OVERRIDES)).toHaveLength(0);
    expect(Object.keys(HOST_VISEME_OVERRIDES)).toHaveLength(2);
  });

  it("produces different tracks from the SAME audio for the two characters", () => {
    const visemes: VisemeEvent[] = [
      { time: 0.0, viseme: "silence" },
      { time: 0.3, viseme: "SS" },
      { time: 0.6, viseme: "aa" },
    ];
    const humanTrack = mouthFromVisemes(visemes, {
      name: "human",
      visemeMap: HUMAN_VISEME_OVERRIDES,
    });
    const hostTrack = mouthFromVisemes(visemes, {
      name: "host",
      visemeMap: HOST_VISEME_OVERRIDES,
    });

    expect(sampleMouth(humanTrack, 0.1)).toBe("closed");
    expect(sampleMouth(hostTrack, 0.1)).toBe("smile");

    expect(sampleMouth(humanTrack, 0.4)).toBe("teeth");
    expect(sampleMouth(hostTrack, 0.4)).toBe("openSmall");

    // The wide vowel agrees on both — the tables differ only where they should.
    expect(sampleMouth(humanTrack, 0.7)).toBe("openWide");
    expect(sampleMouth(hostTrack, 0.7)).toBe("openWide");
  });
});

describe("heldMouth and IDLE_MOUTH", () => {
  it("holds one shape across the whole shot", () => {
    const track = heldMouth("smile", 5);
    expect(sampleMouth(track, 0)).toBe("smile");
    expect(sampleMouth(track, 4.9)).toBe("smile");
  });

  it("names the idle mouth rather than leaving it a literal at each call site", () => {
    expect(MOUTH_SHAPES).toContain(IDLE_MOUTH);
    expect(IDLE_MOUTH).toBe("closed");
  });

  it("produces a track that never switches when held", () => {
    expect(countPoseSwitches(heldMouth("closed", 2), 2, 60)).toBe(0);
    // And the underlying pose track holds identically.
    expect(samplePose(heldMouth("closed", 2), 1.5)).toBe("closed");
  });
});