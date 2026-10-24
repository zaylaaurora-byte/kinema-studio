/**
 * @kinema/scene-model — the deterministic 2D scene graph.
 *
 * The source of truth for what a frame looks like. Everything downstream (rasterising,
 * encoding, preview, timeline) reads from here rather than storing its own copy.
 */

export * from "./scene.js";