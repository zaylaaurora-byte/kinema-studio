import { it } from "vitest";
it("pipeline smoke: scene -> rasterise -> FFmpeg -> MP4", async () => {
  await import("./pipeline-smoke.js");
}, 180000);
