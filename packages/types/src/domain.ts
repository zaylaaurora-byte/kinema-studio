/**
 * Core domain model.
 *
 * THE KEY CONSISTENCY RULE (product spec §12):
 *
 *   "Storyboard, timeline, scene canvas and workflow editor are projections over
 *    versioned project data. They must not independently store contradictory scene
 *    order, duration or approved asset pointers."
 *
 * That rule is encoded structurally here: `Scene` is the single source of truth for
 * order and duration. `StoryboardCard` and `TimelineClip` carry no independent
 * duration or order of their own — they reference a scene and derive everything else.
 * A card cannot disagree with its scene, because it has nothing to disagree with.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Branded ids. Prevents accidentally passing a project id where a scene id is due. */
export type ProjectId = string & { readonly __brand: "ProjectId" };
export type SceneId = string & { readonly __brand: "SceneId" };
export type CharacterId = string & { readonly __brand: "CharacterId" };
export type AssetId = string & { readonly __brand: "AssetId" };
export type RevisionId = string & { readonly __brand: "RevisionId" };
export type JobId = string & { readonly __brand: "JobId" };
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------

export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly createdAt: string;
}

export interface Project {
  readonly id: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly format: ProjectFormat;
  readonly brief: string;
  readonly status: ProjectStatus;
  /** Series grouping, for reusing a cast and voice across episodes. */
  readonly seriesId?: string;
  readonly aspectRatio: AspectRatio;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The two confirmed formats. Both are 2D; a 3D suite is explicitly out of scope.
 */
export type ProjectFormat = "2d_animation" | "faceless_video";

export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:5" | "2.39:1";

/**
 * Project lifecycle. Mirrors the spec's state machine.
 *
 * Note that `approved` assets are immutable and failures are retryable without losing
 * prior approval — that guarantee lives in the revision model below.
 */
export type ProjectStatus =
  | "draft"
  | "planned"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "candidates_ready"
  | "selected"
  | "qc_review"
  | "approved"
  | "exported"
  | "failed";

// ---------------------------------------------------------------------------
// Scenes — the source of truth
// ---------------------------------------------------------------------------

/**
 * A scene is the atomic unit of production and the single source of truth for order
 * and duration. Storyboard cards and timeline clips project from it.
 */
export interface Scene {
  readonly id: SceneId;
  readonly projectId: ProjectId;
  /**
   * Authoritative ordering. Fractional or sparse integers allow a reorder to touch
   * one row instead of renumbering the whole project.
   */
  readonly order: number;
  /** Authoritative duration in seconds. */
  readonly durationSeconds: number;
  readonly aspectRatio: AspectRatio;

  readonly title: string;
  /** Which slice of the script this scene covers. */
  readonly scriptSegmentIds: readonly string[];

  readonly cast: readonly SceneCastMember[];
  readonly props: readonly string[];
  readonly background?: string;
  readonly camera?: CameraSpec;
  readonly lighting?: string;
  readonly animationMode: AnimationMode;
  readonly referenceSetIds: readonly string[];
  readonly shotList: readonly Shot[];

  readonly voiceCues: readonly VoiceCue[];
  readonly audioLayers: readonly AudioLayer[];

  readonly status: SceneStatus;
  /**
   * The approved revision. Immutable once set — a repair creates a new revision rather
   * than mutating this one.
   */
  readonly approvedRevisionId?: RevisionId;
  readonly candidateIds: readonly string[];
}

export type AnimationMode = "layered_2d" | "generated_video" | "hybrid" | "static";

export type SceneStatus =
  | "draft"
  | "generating"
  | "candidates_ready"
  | "approved"
  | "failed";

export interface SceneCastMember {
  readonly characterId: CharacterId;
  /** Overrides for this scene only; never mutates the character's canonical design. */
  readonly outfitId?: string;
  readonly expressionId?: string;
  readonly poseId?: string;
  readonly silent?: boolean;
}

export interface Shot {
  readonly id: string;
  readonly order: number;
  readonly description: string;
  readonly durationSeconds: number;
}

export interface CameraSpec {
  readonly move: "static" | "pan" | "zoom" | "truck" | "tilt";
  readonly easing?: string;
  readonly from?: { x: number; y: number; scale: number };
  readonly to?: { x: number; y: number; scale: number };
}

// ---------------------------------------------------------------------------
// Projections (must not store their own order or duration)
// ---------------------------------------------------------------------------

/**
 * A storyboard card.
 *
 * Note what is absent: no `durationSeconds`, no `order`. Both are read from the scene.
 * Adding them here would recreate exactly the inconsistency the spec forbids.
 */
export interface StoryboardCard {
  readonly sceneId: SceneId;
  readonly thumbnailAssetId?: AssetId;
  /** Cached presentation strings. Regenerated from the scene; never authoritative. */
  readonly displayTitle: string;
  readonly displayDialogue?: string;
}

/**
 * A timeline clip.
 *
 * `startSeconds` is a layout position within the timeline, which is legitimately not
 * a property of the scene — the same scene could appear at several points. Duration is
 * NOT stored: it comes from the scene, so trimming a clip cannot desynchronise the
 * storyboard.
 */
export interface TimelineClip {
  readonly id: string;
  readonly trackId: string;
  readonly sceneId: SceneId;
  readonly startSeconds: number;
  readonly assetId?: AssetId;
}

export interface Track {
  readonly id: string;
  readonly kind: "video" | "dialogue" | "music" | "sfx" | "captions";
  readonly name: string;
  readonly muted: boolean;
  readonly locked: boolean;
}

/** The whole timeline, derived. Never persisted as independent truth. */
export interface TimelineProjection {
  readonly projectId: ProjectId;
  readonly tracks: readonly Track[];
  readonly clips: readonly TimelineClip[];
  /** Total duration, computed by summing scenes. Never stored. */
  readonly durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

/**
 * An immutable revision of a scene's rendered output.
 *
 * The spec requires that "approved assets remain immutable" and that a single
 * problematic shot can be fixed without rerendering everything. Revisions are how:
 * regenerating produces a new revision, leaving the approved one untouched until the
 * user explicitly promotes it.
 */
export interface SceneRevision {
  readonly id: RevisionId;
  readonly sceneId: SceneId;
  readonly revisionNumber: number;
  readonly assetIds: readonly AssetId[];
  readonly createdAt: string;
  readonly provenance: Readonly<Record<string, unknown>>;
  /** True once approved. Immutable from that point. */
  readonly approved: boolean;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export interface Character {
  readonly id: CharacterId;
  readonly workspaceId: WorkspaceId;
  readonly displayName: string;
  readonly designBible: string;
  /** Immutable approved reference sheets. */
  readonly referenceSetIds: readonly string[];
  readonly traitProfile?: VisualTraitProfile;
  readonly voiceProfileId?: string;
  readonly pronunciationDictionary?: Readonly<Record<string, string>>;
  readonly rigManifestId?: string;
  readonly createdAt: string;
}

/**
 * Visual traits used by the continuity tracker.
 *
 * `forbiddenDriftRules` is the practically important part: rather than only describing
 * what a character *is*, it records what must never change — the horns, the palette,
 * the silhouette. Those are what a QC pass can actually check.
 */
export interface VisualTraitProfile {
  readonly silhouette?: string;
  readonly palette: readonly string[];
  readonly proportions?: string;
  readonly faceLandmarks?: readonly string[];
  readonly accessories?: readonly string[];
  readonly lineWeight?: string;
  readonly texture?: string;
  readonly forbiddenDriftRules: readonly string[];
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export interface VoiceCue {
  readonly id: string;
  readonly sceneId: SceneId;
  readonly line: string;
  readonly characterId?: CharacterId;
  readonly startSeconds: number;
  /** Performance direction: pacing, intensity, warmth, pauses. */
  readonly direction?: PerformanceDirection;
  readonly takeIds: readonly string[];
  readonly selectedTakeId?: string;
}

export interface PerformanceDirection {
  readonly emotion?: string;
  readonly intensity?: number;
  readonly pace?: "slow" | "measured" | "natural" | "brisk" | "fast";
  readonly pauseBeforeMs?: number;
  readonly pauseAfterMs?: number;
  readonly emphasis?: readonly string[];
}

export interface AudioLayer {
  readonly id: string;
  readonly kind: "dialogue" | "music" | "sfx" | "ambience";
  readonly assetId: AssetId;
  readonly startSeconds: number;
  readonly gainDb: number;
  readonly fadeInMs?: number;
  readonly fadeOutMs?: number;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * An immutable stored asset plus its derived proxies.
 *
 * Originals are never mutated: thumbnails, waveforms and previews are separate
 * derived assets. This makes "replace one asset without destroying approved work"
 * achievable.
 */
export interface Asset {
  readonly id: AssetId;
  readonly workspaceId: WorkspaceId;
  readonly kind: "image" | "audio" | "video" | "document" | "template";
  readonly mimeType: string;
  readonly byteSize: number;
  /** Content hash, for deduplication and cache keys. */
  readonly contentHash: string;
  readonly storageKey: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly provenance?: AssetProvenance;
  readonly createdAt: string;
}

export interface AssetProvenance {
  readonly providerId: string;
  readonly modelId: string;
  readonly prompt?: string;
  readonly seed?: number;
  readonly generatedAt: string;
  /** Licensing/consent note for uploaded or cloned media. */
  readonly licenceNote?: string;
  readonly consentRecordId?: string;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type JobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Job {
  readonly id: JobId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly kind: JobKind;
  readonly state: JobState;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly sceneId?: SceneId;
  /** Idempotency key: the same logical request must not run twice. */
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly estimatedCost?: number;
  readonly actualCost?: number;
  readonly error?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export type JobKind =
  | "generate_script"
  | "generate_image"
  | "generate_video"
  | "generate_audio"
  | "align_audio"
  | "render_export"
  | "qc_check";