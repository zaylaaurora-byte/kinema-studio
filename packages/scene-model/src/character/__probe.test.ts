import { describe, expect, it } from "vitest";

import { evaluate, type SceneDocument } from "../scene.js";
import { buildHumanRig, FIGURE_HEIGHT, HEAD_DIAMETER } from "./human-rig.js";

function sceneWith(rig: ReturnType<typeof buildHumanRig>): SceneDocument {
  return {
    id: "probe",
    name: "probe",
    width: 400,
    height: 400,
    fps: 30,
    durationSeconds: 1,
    layers: [{ id: "l", name: "l", zIndex: 0, visible: true, opacity: 1, rig }],
  };
}

describe("proportion probe (temporary)", () => {
  it("reports resolved geometry", () => {
    const frame = evaluate(sceneWith(buildHumanRig()), 0);
    const lines = frame.parts.map(
      (p) => `${p.id.padEnd(16)} e=${p.world.e.toFixed(2)} f=${p.world.f.toFixed(2)}`,
    );
    console.log(lines.join("\n"));
    console.log("FIGURE_HEIGHT", FIGURE_HEIGHT, "HEAD_DIAMETER", HEAD_DIAMETER);
    expect(frame.parts.length).toBeGreaterThan(0);
  });
});