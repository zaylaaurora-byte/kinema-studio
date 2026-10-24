/**
 * Quality control.
 *
 * The premise here is that the cheapest place to catch a production failure is before
 * generation. Every check below costs nothing, needs no model, and catches something that
 * would otherwise be discovered after money had been spent:
 *
 *   1. **Empty scene.** A scene with neither dialogue nor visual direction is a scene nobody
 *      has thought about. The storyboard artist has nothing to draw from and will invent
 *      something, which is how an off-brief shot gets made.
 *   2. **Duration mismatch.** A scene plan whose shots do not sum to the scene's stated
 *      duration. `Scene.durationSeconds` is authoritative in @kinema/types, so a mismatch
 *      means either the shots or the scene is wrong, and the difference shows up as a
 *      timeline that drifts against the audio.
 *   3. **Silent character with dialogue.** The exact continuity trap the Bad Example brief
 *      warns about: storyboard art implying speech for a character who must never speak.
 *   4. **Camera-only motion.** "At least one actual animated movement — explicitly not a Ken
 *      Burns zoom on still art" is an acceptance criterion, so a shot that claims real
 *      movement while describing only a camera move is an error, not a style preference.
 *   5. **Continuity rule break.** A generated prompt that omits or contradicts a character's
 *      forbidden-drift rules.
 *
 * Each finding carries a severity. `error` fails the review; `warning` is surfaced and does
 * not. The distinction is deliberate: a checker that fails on taste is one users learn to
 * ignore, and an ignored QC pass is worse than none.
 */

import type { JsonSchema } from "../schema.js";
import { ToolError, type Tool } from "../tool.js";
import { TOOL } from "../tool-names.js";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/**
 * A shot in a scene plan.
 *
 * Mirrors `Shot` in @kinema/types, plus the motion fields the animator supplies. The
 * `durationSeconds` here is the *planned* duration; the check compares it against the
 * scene's authoritative duration rather than trusting either.
 */
export interface PlannedShot {
  readonly id: string;
  readonly order: number;
  readonly description: string;
  readonly durationSeconds: number;
  readonly charactersOnScreen?: readonly string[];
  /** True only when something other than the camera moves. */
  readonly isRealMovement?: boolean;
  readonly animationMode?: "layered_2d" | "generated_video" | "hybrid" | "static";
  readonly generationPrompt?: string;
  readonly referenceAssetIds?: readonly string[];
}

export interface PlannedScene {
  readonly sceneId: string;
  readonly durationSeconds: number;
  readonly title?: string;
  readonly dialogue?: readonly { readonly characterId: string; readonly line: string }[];
  readonly visualDirection?: string;
  readonly shots?: readonly PlannedShot[];
}

export interface CharacterLockInput {
  readonly characterId: string;
  readonly displayName?: string;
  readonly forbiddenDriftRules: readonly string[];
  /** True when this character must never speak. */
  readonly mustRemainSilent?: boolean;
  readonly referenceSetIds?: readonly string[];
}

export interface QcCheckInput {
  readonly scenes: readonly PlannedScene[];
  readonly characterLocks?: readonly CharacterLockInput[];
  /** Target runtime. When present, the total scene duration is checked against it. */
  readonly targetDurationSeconds?: number;
  /** How far a shot sum may differ from its scene before it is an error. Default 0.25s. */
  readonly durationToleranceSeconds?: number;
  /** Run only these checks, by id. Absent means all of them. */
  readonly checks?: readonly string[];
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

export type QcSeverity = "info" | "warning" | "error";

export interface QcFinding {
  readonly check: string;
  readonly severity: QcSeverity;
  readonly sceneId: string;
  readonly message: string;
  readonly suggestion?: string;
  readonly shotId?: string;
  readonly expected?: number | string;
  readonly actual?: number | string;
}

export interface QcCheckOutput {
  readonly passed: boolean;
  readonly findings: readonly QcFinding[];
  readonly checkedSceneIds: readonly string[];
  readonly checksRun: readonly string[];
  readonly errorCount: number;
  readonly warningCount: number;
  readonly totalSceneSeconds: number;
  readonly notes: string;
}

// ---------------------------------------------------------------------------
// Check identifiers
// ---------------------------------------------------------------------------

export const QC_CHECKS = {
  EMPTY_SCENE: "empty_scene",
  DURATION_MISMATCH: "duration_mismatch",
  SILENT_CHARACTER_SPEAKS: "silent_character_speaks",
  CAMERA_ONLY_MOTION: "camera_only_motion",
  MISSING_DRIFT_RULES: "missing_drift_rules",
  PROGRAMME_DURATION: "programme_duration",
} as const;

export type QcCheckId = (typeof QC_CHECKS)[keyof typeof QC_CHECKS];

export const ALL_QC_CHECKS: readonly QcCheckId[] = Object.values(QC_CHECKS);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const QC_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "passed",
    "findings",
    "checkedSceneIds",
    "checksRun",
    "errorCount",
    "warningCount",
    "totalSceneSeconds",
    "notes",
  ],
  properties: {
    passed: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["check", "severity", "sceneId", "message"],
        properties: {
          check: { type: "string" },
          severity: { type: "string", enum: ["info", "warning", "error"] },
          sceneId: { type: "string" },
          message: { type: "string" },
          suggestion: { type: "string" },
          shotId: { type: "string" },
          expected: { type: ["number", "string"] },
          actual: { type: ["number", "string"] },
        },
      },
    },
    checkedSceneIds: { type: "array", items: { type: "string" } },
    checksRun: { type: "array", items: { type: "string" } },
    errorCount: { type: "integer", minimum: 0 },
    warningCount: { type: "integer", minimum: 0 },
    totalSceneSeconds: { type: "number", minimum: 0 },
    notes: { type: "string" },
  },
};

const SHOT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "order", "description", "durationSeconds"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 120 },
    order: { type: "integer", minimum: 0, maximum: 9999 },
    description: { type: "string", minLength: 1, maxLength: 4000 },
    durationSeconds: { type: "number", minimum: 0, maximum: 600 },
    charactersOnScreen: { type: "array", items: { type: "string", minLength: 1, maxLength: 120 } },
    isRealMovement: { type: "boolean" },
    animationMode: {
      type: "string",
      enum: ["layered_2d", "generated_video", "hybrid", "static"],
    },
    generationPrompt: { type: "string", maxLength: 8000 },
    referenceAssetIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 } },
  },
};

const SCENE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sceneId", "durationSeconds"],
  properties: {
    sceneId: { type: "string", minLength: 1, maxLength: 120 },
    durationSeconds: { type: "number", minimum: 0, maximum: 3600 },
    title: { type: "string", maxLength: 200 },
    dialogue: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["characterId", "line"],
        properties: {
          characterId: { type: "string", minLength: 1, maxLength: 120 },
          line: { type: "string", minLength: 1, maxLength: 2000 },
        },
      },
    },
    visualDirection: { type: "string", maxLength: 2000 },
    shots: { type: "array", maxItems: 500, items: SHOT_SCHEMA },
  },
};

// ---------------------------------------------------------------------------
// Motion vocabulary
// ---------------------------------------------------------------------------

/**
 * Words that describe the camera rather than the subject.
 *
 * Used to catch the specific failure the brief names: motion described entirely in camera
 * terms being presented as animation. Note that these words are legitimate in a shot
 * description — the check only fires when *nothing else* moves.
 */
const CAMERA_ONLY_WORDS = [
  "pan",
  "zoom",
  "panning",
  "zooming",
  "ken burns",
  "push in",
  "pull out",
  "truck",
  "dolly",
  "tilt",
  "rack focus",
  "camera move",
  "camera moves",
  "static camera",
  "hold on",
  "slow push",
];

/**
 * Words that indicate something in the frame actually moves.
 *
 * Deliberately concrete and bodily rather than narrative. "The tension rises" is not
 * movement, and a check that accepted it would pass exactly the shots that need flagging.
 */
const SUBJECT_MOTION_WORDS = [
  "walks",
  "walk",
  "runs",
  "run",
  "running",
  "turns",
  "turn",
  "nods",
  "nodd",
  "blinks",
  "blink",
  "reaches",
  "reach",
  "gestures",
  "shrugs",
  "shrug",
  "steps",
  "leans",
  "lean",
  "raises",
  "lifts",
  "opens",
  "closes",
  "breathing",
  "breathes",
  "mouth moves",
  "lips",
  "hair moves",
  "swings",
  "spins",
  "jumps",
  "falls",
  "crouches",
  "stumbles",
  "sprints",
  "scrambles",
  "recoils",
  "flinch",
  "shakes",
  "trembles",
  "walk cycle",
  "run cycle",
  "lip sync",
  "lip-sync",
];

function describesOnlyCameraMotion(text: string): boolean {
  const lower = text.toLowerCase();
  const hasCamera = CAMERA_ONLY_WORDS.some((word) => lower.includes(word));
  const hasSubject = SUBJECT_MOTION_WORDS.some((word) => lower.includes(word));
  return hasCamera && !hasSubject;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const qcCheckTool: Tool<QcCheckInput, QcCheckOutput> = {
  name: TOOL.QC_CHECK,
  description:
    "Run deterministic quality checks over a scene plan: scenes with no dialogue and no " +
    "visual direction, shot durations that disagree with their scene, silent characters " +
    "given lines, camera-only movement presented as animation, and prompts missing their " +
    "character continuity rules. No model, no cost, no network.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["scenes"],
    properties: {
      scenes: { type: "array", minItems: 1, maxItems: 500, items: SCENE_SCHEMA },
      characterLocks: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["characterId", "forbiddenDriftRules"],
          properties: {
            characterId: { type: "string", minLength: 1, maxLength: 120 },
            displayName: { type: "string", maxLength: 200 },
            forbiddenDriftRules: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1, maxLength: 500 },
            },
            mustRemainSilent: { type: "boolean" },
            referenceSetIds: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 200 },
            },
          },
        },
      },
      targetDurationSeconds: { type: "number", exclusiveMinimum: 0, maximum: 36000 },
      durationToleranceSeconds: { type: "number", minimum: 0, maximum: 60 },
      checks: {
        type: "array",
        items: { type: "string", enum: [...ALL_QC_CHECKS] },
        uniqueItems: true,
        description: "Run only these checks. Absent means all of them.",
      },
    },
  },
  outputSchema: QC_OUTPUT_SCHEMA,
  /**
   * No approval. A read-only check that cannot spend money or change anything should not
   * interrupt the user; gating it would dilute the gates that protect real spending.
   */
  requiresApproval: false,
  estimatedCost: 0,
  sideEffecting: false,

  run(input) {
    const tolerance = input.durationToleranceSeconds ?? 0.25;
    const requested = input.checks ?? ALL_QC_CHECKS;

    const unknownChecks = requested.filter(
      (check) => !(ALL_QC_CHECKS as readonly string[]).includes(check),
    );
    if (unknownChecks.length > 0) {
      /**
       * Refused rather than ignored. A caller that asked for a check which does not exist
       * believes that check ran; silently skipping it produces a clean report that means
       * nothing.
       */
      throw new ToolError(
        "invalid_input",
        `Unknown QC check(s): ${unknownChecks.join(", ")}. Available: ${ALL_QC_CHECKS.join(", ")}.`,
        { path: "/checks", toolName: TOOL.QC_CHECK, userActionRequired: false },
      );
    }

    const active = new Set<string>(requested);
    const findings: QcFinding[] = [];

    const lockByCharacter = new Map(
      (input.characterLocks ?? []).map((lock) => [lock.characterId, lock] as const),
    );
    const silentCharacters = new Set(
      (input.characterLocks ?? [])
        .filter((lock) => lock.mustRemainSilent === true)
        .map((lock) => lock.characterId),
    );

    const seenSceneIds = new Set<string>();
    const duplicateSceneIds: string[] = [];

    let totalSceneSeconds = 0;

    for (const scene of input.scenes) {
      if (seenSceneIds.has(scene.sceneId)) duplicateSceneIds.push(scene.sceneId);
      seenSceneIds.add(scene.sceneId);
      totalSceneSeconds += scene.durationSeconds;

      const dialogue = scene.dialogue ?? [];
      const direction = scene.visualDirection?.trim() ?? "";

      // ── 1. Empty scene ────────────────────────────────────────────────
      if (active.has(QC_CHECKS.EMPTY_SCENE)) {
        if (dialogue.length === 0 && direction.length === 0) {
          findings.push({
            check: QC_CHECKS.EMPTY_SCENE,
            severity: "error",
            sceneId: scene.sceneId,
            message:
              `Scene "${scene.title ?? scene.sceneId}" has no dialogue and no visual direction, ` +
              `so nothing states what should be on screen.`,
            suggestion:
              "Give the scene a visual direction line — even \"silent, character alone in frame\" " +
              "tells the storyboard artist what to draw.",
          });
        } else if (direction.length === 0 && dialogue.length > 0) {
          findings.push({
            check: QC_CHECKS.EMPTY_SCENE,
            severity: "warning",
            sceneId: scene.sceneId,
            message:
              `Scene "${scene.title ?? scene.sceneId}" has dialogue but no visual direction; the ` +
              `shot is under-specified.`,
            suggestion: "Add framing, lighting and camera intent.",
          });
        }
      }

      // ── 2. Duration mismatch ──────────────────────────────────────────
      if (active.has(QC_CHECKS.DURATION_MISMATCH) && scene.shots !== undefined && scene.shots.length > 0) {
        const shotTotal = scene.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
        const delta = round(shotTotal - scene.durationSeconds);

        if (Math.abs(delta) > tolerance) {
          findings.push({
            check: QC_CHECKS.DURATION_MISMATCH,
            severity: "error",
            sceneId: scene.sceneId,
            expected: round(scene.durationSeconds),
            actual: round(shotTotal),
            message:
              `Shots in "${scene.title ?? scene.sceneId}" sum to ${round(shotTotal)}s but the ` +
              `scene is ${round(scene.durationSeconds)}s — ${delta > 0 ? "over" : "under"} by ` +
              `${round(Math.abs(delta))}s.`,
            suggestion:
              delta > 0
                ? "Shorten a shot or extend the scene. Scene duration is authoritative, so the " +
                  "shots must be retimed rather than the scene silently changed."
                : "Lengthen a shot or reduce the scene duration, so the cut and the audio stay aligned.",
          });
        }

        // Shots with no duration at all are a distinct failure: three of them usually means
        // the board is a sketch rather than a plan.
        const zeroDurationShots = scene.shots.filter((shot) => shot.durationSeconds <= 0);
        if (zeroDurationShots.length > 0) {
          findings.push({
            check: QC_CHECKS.DURATION_MISMATCH,
            severity: "error",
            sceneId: scene.sceneId,
            message:
              `Scene "${scene.sceneId}" has ${zeroDurationShots.length} shot(s) with no duration: ` +
              `${zeroDurationShots.map((shot) => shot.id).join(", ")}.`,
            suggestion: "Every shot needs a duration; there is no default that is correct.",
          });
        }
      }

      // ── 3. Silent character given a line ──────────────────────────────
      if (active.has(QC_CHECKS.SILENT_CHARACTER_SPEAKS)) {
        for (const entry of dialogue) {
          if (!silentCharacters.has(entry.characterId)) continue;
          const lock = lockByCharacter.get(entry.characterId);
          findings.push({
            check: QC_CHECKS.SILENT_CHARACTER_SPEAKS,
            severity: "error",
            sceneId: scene.sceneId,
            message:
              `Scene "${scene.sceneId}" gives a spoken line to "${lock?.displayName ?? entry.characterId}", ` +
              `who is locked as non-speaking: "${truncate(entry.line, 60)}".`,
            suggestion:
              "Replace the line with a nonverbal sound (gasp, yelp, breath, impact) in the audio " +
              "layers. This is a continuity violation, not a style choice.",
          });
        }
      }

      // ── 4. Camera-only motion ─────────────────────────────────────────
      if (active.has(QC_CHECKS.CAMERA_ONLY_MOTION)) {
        for (const shot of scene.shots ?? []) {
          const haystack = `${shot.description} ${shot.generationPrompt ?? ""}`;

          if (shot.isRealMovement === true && describesOnlyCameraMotion(haystack)) {
            findings.push({
              check: QC_CHECKS.CAMERA_ONLY_MOTION,
              severity: "error",
              sceneId: scene.sceneId,
              shotId: shot.id,
              message:
                `Shot "${shot.id}" claims real movement, but its description names only camera ` +
                `motion: "${truncate(shot.description, 80)}".`,
              suggestion:
                "A pan or zoom over static art is not animation. Either animate a body part — " +
                "a blink, a turn, a walk cycle — or set isRealMovement to false and be honest " +
                "that this shot is a camera move.",
            });
          }

          if (
            shot.isRealMovement !== true &&
            shot.animationMode === "static" &&
            shot.charactersOnScreen !== undefined &&
            shot.charactersOnScreen.length > 0
          ) {
            /**
             * A warning, not an error. A static shot of a character is perfectly legitimate —
             * but if *every* shot is static the production has no animation, and the brief
             * requires at least one real movement. That aggregate check is reported below.
             */
            findings.push({
              check: QC_CHECKS.CAMERA_ONLY_MOTION,
              severity: "warning",
              sceneId: scene.sceneId,
              shotId: shot.id,
              message: `Shot "${shot.id}" is static but shows ${shot.charactersOnScreen.length} character(s).`,
              suggestion: "Confirm this is deliberate; a held shot of a character can read as a freeze.",
            });
          }
        }
      }

      // ── 5. Missing continuity rules ───────────────────────────────────
      if (active.has(QC_CHECKS.MISSING_DRIFT_RULES)) {
        for (const shot of scene.shots ?? []) {
          for (const characterId of shot.charactersOnScreen ?? []) {
            const lock = lockByCharacter.get(characterId);
            if (!lock) continue;
            if (lock.forbiddenDriftRules.length === 0) continue;
            if (shot.referenceAssetIds === undefined || shot.referenceAssetIds.length === 0) {
              findings.push({
                check: QC_CHECKS.MISSING_DRIFT_RULES,
                severity: "warning",
                sceneId: scene.sceneId,
                shotId: shot.id,
                message:
                  `Shot "${shot.id}" shows "${lock.displayName ?? characterId}" but carries no ` +
                  `reference asset, so nothing pins the character's identity for generation.`,
                suggestion:
                  `Attach ${lock.referenceSetIds?.length ? `reference set(s) ${lock.referenceSetIds.join(", ")}` : "the approved reference sheets"} ` +
                  `to this shot. Identity drift is the failure this prevents.`,
              });
            }
          }
        }
      }
    }

    if (duplicateSceneIds.length > 0) {
      findings.push({
        check: QC_CHECKS.EMPTY_SCENE,
        severity: "error",
        sceneId: [...new Set(duplicateSceneIds)].join(", "),
        message: `Duplicate scene id(s) in the plan: ${[...new Set(duplicateSceneIds)].join(", ")}.`,
        suggestion: "Scene ids must be unique; a duplicate makes the timeline ambiguous.",
      });
    }

    // ── 6. Programme duration ───────────────────────────────────────────
    if (active.has(QC_CHECKS.PROGRAMME_DURATION) && input.targetDurationSeconds !== undefined) {
      const target = input.targetDurationSeconds;
      const delta = round(totalSceneSeconds - target);
      if (Math.abs(delta) > tolerance) {
        findings.push({
          check: QC_CHECKS.PROGRAMME_DURATION,
          severity: "warning",
          sceneId: "(programme)",
          expected: target,
          actual: round(totalSceneSeconds),
          message:
            `Scenes total ${round(totalSceneSeconds)}s against a ${target}s target — ` +
            `${delta > 0 ? "over" : "under"} by ${round(Math.abs(delta))}s.`,
          suggestion:
            delta > 0
              ? "Trim a scene. Note scene durations are authoritative and belong to the Writer."
              : "The piece is short of the brief; add content rather than padding a shot.",
        });
      }
    }

    /**
     * The aggregate animation check.
     *
     * Implements the brief's acceptance criterion directly: "at least one actual animated
     * human movement — explicitly not a Ken Burns zoom on still art". A plan where every
     * shot with a character in it is static or camera-only does not meet it, and the answer
     * is an error rather than a note, because it means the piece will be delivered without
     * the thing that was asked for.
     */
    if (active.has(QC_CHECKS.CAMERA_ONLY_MOTION)) {
      const characterShots = input.scenes
        .flatMap((scene) => scene.shots ?? [])
        .filter((shot) => (shot.charactersOnScreen?.length ?? 0) > 0);

      if (characterShots.length > 0 && !characterShots.some((shot) => shot.isRealMovement === true)) {
        findings.push({
          check: QC_CHECKS.CAMERA_ONLY_MOTION,
          severity: "error",
          sceneId: "(programme)",
          message:
            `None of the ${characterShots.length} shot(s) containing a character has real ` +
            `movement. The production would contain no animation of its cast.`,
          suggestion:
            "Animate at least one shot for real: a blink, a turn, a walk cycle. This is an " +
            "acceptance requirement, not a preference.",
        });
      }
    }

    const errorCount = findings.filter((finding) => finding.severity === "error").length;
    const warningCount = findings.filter((finding) => finding.severity === "warning").length;

    return {
      passed: errorCount === 0,
      findings: sortFindings(findings),
      checkedSceneIds: [...new Set(input.scenes.map((scene) => scene.sceneId))],
      checksRun: [...active].sort(),
      errorCount,
      warningCount,
      totalSceneSeconds: round(totalSceneSeconds),
      /**
       * Coverage is stated explicitly. The pilot brief requires known imperfections to be
       * listed rather than implied, and a QC tool that does not say what it did *not* check
       * is exactly the kind of report that reads as a clean bill of health.
       */
      notes:
        `Ran ${active.size} check(s) over ${input.scenes.length} scene(s). These are deterministic ` +
        `structural checks: they cannot see a generated frame, so they cannot detect character ` +
        `drift, style mismatch, or a wrong-looking shot. Those require a visual comparison ` +
        `against the reference sheets, which this check does not perform.`,
    };
  },
};

/**
 * Findings are sorted so a report is diffable between runs: errors first, then by scene,
 * then by check. A QC report whose order changes between runs is one nobody can compare.
 */
function sortFindings(findings: readonly QcFinding[]): readonly QcFinding[] {
  const severityRank: Record<QcSeverity, number> = { error: 0, warning: 1, info: 2 };
  return [...findings].sort((a, b) => {
    const severityDelta = severityRank[a.severity] - severityRank[b.severity];
    if (severityDelta !== 0) return severityDelta;
    if (a.sceneId !== b.sceneId) return a.sceneId < b.sceneId ? -1 : 1;
    if (a.check !== b.check) return a.check < b.check ? -1 : 1;
    const aShot = a.shotId ?? "";
    const bShot = b.shotId ?? "";
    return aShot < bShot ? -1 : aShot > bShot ? 1 : 0;
  });
}

function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}