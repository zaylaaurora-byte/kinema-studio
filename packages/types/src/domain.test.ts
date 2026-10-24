import { describe, expect, it } from "vitest";

import type {
  ProjectId,
  Scene,
  SceneId,
  SceneRevision,
  StoryboardCard,
  TimelineClip,
  TimelineProjection,
} from "./domain.js";

/**
 * These tests enforce the specification's key consistency rule at the type level:
 *
 *   "Storyboard, timeline, scene canvas and workflow editor are projections over
 *    versioned project data. They must not independently store contradictory scene
 *    order, duration or approved asset pointers."
 *
 * TypeScript cannot prevent every runtime mistake, but it CAN prevent a projection from
 * carrying its own copy of authoritative data. The tests below assert that with compile
 * -time checks: if someone adds `durationSeconds` back onto `StoryboardCard`, the
 * `@ts-expect-error` assertions start failing because the error disappears.
 */

const projectId = "proj-1" as ProjectId;
const sceneId = "scene-1" as SceneId;

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: sceneId,
    projectId,
    order: 1,
    durationSeconds: 4.5,
    aspectRatio: "16:9",
    title: "Opening shot",
    scriptSegmentIds: ["seg-1"],
    cast: [],
    props: [],
    animationMode: "layered_2d",
    referenceSetIds: [],
    shotList: [],
    voiceCues: [],
    audioLayers: [],
    status: "draft",
    candidateIds: [],
    ...overrides,
  };
}

describe("key consistency rule", () => {
  it("StoryboardCard does not carry its own duration", () => {
    const card: StoryboardCard = {
      sceneId,
      displayTitle: "Opening shot",
    };

    // If a `durationSeconds` field were added to StoryboardCard, this line would stop
    // erroring and the @ts-expect-error would itself become a compile error. That is
    // the guard: it fails loudly in the direction that matters.
    // @ts-expect-error projections must not store authoritative duration
    const duration = card.durationSeconds;

    expect(duration).toBeUndefined();
    expect(card.sceneId).toBe(sceneId);
  });

  it("StoryboardCard does not carry its own order", () => {
    const card: StoryboardCard = { sceneId, displayTitle: "Opening shot" };

    // @ts-expect-error projections must not store authoritative order
    const order = card.order;

    expect(order).toBeUndefined();
  });

  it("TimelineClip does not carry its own duration", () => {
    const clip: TimelineClip = {
      id: "clip-1",
      trackId: "track-video",
      sceneId,
      startSeconds: 0,
    };

    // Duration is injected by the timeline layout, never stored - otherwise trimming a
    // clip could silently desynchronise the storyboard.
    // @ts-expect-error duration is derived from the linked scene
    const duration = clip.durationSeconds;

    expect(duration).toBeUndefined();
  });

  it("TimelineClip keeps startSeconds, which is a legitimate layout position", () => {
    // startSeconds is NOT authoritative scene data: the same scene may appear at
    // several points on the timeline, so position genuinely belongs to the clip.
    const clip: TimelineClip = {
      id: "clip-2",
      trackId: "track-video",
      sceneId,
      startSeconds: 12.5,
    };

    expect(clip.startSeconds).toBe(12.5);
  });
});

describe("timeline projection", () => {
  it("computes total duration from scenes rather than storing it independently", () => {
    const scenes = [
      makeScene({ id: "s1" as SceneId, order: 1, durationSeconds: 4 }),
      makeScene({ id: "s2" as SceneId, order: 2, durationSeconds: 6 }),
      makeScene({ id: "s3" as SceneId, order: 3, durationSeconds: 2.5 }),
    ];

    const clips: TimelineClip[] = [];
    let cursor = 0;
    for (const scene of scenes) {
      clips.push({
        id: `clip-${scene.id}`,
        trackId: "track-video",
        sceneId: scene.id,
        startSeconds: cursor,
      });
      cursor += scene.durationSeconds;
    }

    const timeline: TimelineProjection = {
      projectId,
      tracks: [
        { id: "track-video", kind: "video", name: "Video", muted: false, locked: false },
      ],
      clips,
      // Derived, never authored.
      durationSeconds: scenes.reduce((total, s) => total + s.durationSeconds, 0),
    };

    expect(timeline.durationSeconds).toBe(12.5);
    expect(timeline.clips).toHaveLength(3);
    // Clip positions must agree with the accumulated scene durations.
    expect(timeline.clips[1]!.startSeconds).toBe(4);
    expect(timeline.clips[2]!.startSeconds).toBe(10);
    expect(cursor).toBe(timeline.durationSeconds);
  });

  it("changing one scene duration changes the derived total automatically", () => {
    // The point of the rule: there is exactly one place to edit.
    const scenes = [
      makeScene({ id: "s1" as SceneId, durationSeconds: 4 }),
      makeScene({ id: "s2" as SceneId, durationSeconds: 6 }),
    ];

    const totalOf = (list: Scene[]): number =>
      list.reduce((sum, s) => sum + s.durationSeconds, 0);

    expect(totalOf(scenes)).toBe(10);

    const edited = [scenes[0]!, { ...scenes[1]!, durationSeconds: 8 }];
    expect(totalOf(edited)).toBe(12);
  });
});

describe("revision immutability", () => {
  it("an approved revision records which assets it froze", () => {
    const revision: SceneRevision = {
      id: "rev-1" as SceneRevision["id"],
      sceneId,
      revisionNumber: 1,
      assetIds: ["asset-1" as never, "asset-2" as never],
      createdAt: "2026-10-24T00:00:00.000Z",
      provenance: { providerId: "mock", modelId: "mock-image-v1" },
      approved: true,
    };

    expect(revision.approved).toBe(true);
    expect(revision.assetIds).toHaveLength(2);
    // A repair must produce a NEW revision rather than mutating this one, which is what
    // makes "fix one shot without losing approved work" possible.
    expect(revision.revisionNumber).toBe(1);
  });
});