/**
 * Blender Python script builder.
 *
 * ## Why this is typed operations instead of a template string
 *
 * The obvious implementation takes a scene description and interpolates it into a Python
 * source string. That is a command-injection hole with a direct path to code execution on
 * the user's machine: a material named
 *
 *     x"); import os; os.system("echo pwned"); ("
 *
 * closes the literal, ends the statement and runs whatever follows. Material names and
 * output paths are user-controlled — they come from prompts, from uploaded projects, from
 * an agent — so they are untrusted input by definition. ADR 0002 calls this exact risk out
 * ("a prompt-injection path straight to code execution") and forbids reaching
 * `execute_blender_code` with untrusted content.
 *
 * The fix is structural rather than a filter. Callers describe the scene with a closed set
 * of typed operations (`SceneOperation`); this module serialises them. There is no
 * general-purpose escape hatch, so there is no general-purpose way to inject. Every string
 * that does reach the generated source goes through {@link pythonStringLiteral}, which
 * emits a single-quoted literal with `\` and `'` escaped — the only two characters that can
 * terminate or extend a single-quoted Python literal.
 *
 * `script-builder.test.ts` proves this against a real parser (`ast.parse`) rather than by
 * pattern matching, and asserts the payload survives only as data inside a string literal.
 *
 * ## Why the script prints a machine-readable report
 *
 * Scraping human-readable Blender output is fragile: it changes between versions, it is
 * interleaved with progress bars on stderr, and "Render complete" tells us nothing about
 * what was actually built. Instead the generated script prints one JSON object between
 * `KINEMA_REPORT_START` / `KINEMA_REPORT_END` markers. That is how structured results come
 * back out of Blender without guessing. Markers are on their own lines so a JSON payload
 * containing the marker text cannot confuse the parser in `render.ts`.
 */

/**
 * The markers are part of the contract between the generated script, `render.ts` and the
 * tests. They are exported so nothing re-types the strings.
 */
export const REPORT_START_MARKER = "KINEMA_REPORT_START";
export const REPORT_END_MARKER = "KINEMA_REPORT_END";

/** Primitives Blender can add with `bpy.ops.mesh.primitive_*`. */
export type PrimitiveKind = "cube" | "sphere" | "plane" | "cylinder" | "cone" | "torus";

/** Light types Blender supports. Mapped to Blender's own enum identifiers below. */
export type LightKind = "point" | "sun" | "spot" | "area";

export interface Vector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface AddPrimitiveOperation {
  readonly op: "addPrimitive";
  readonly kind: PrimitiveKind;
  /** Object name in the scene. Untrusted: always escaped, never interpolated raw. */
  readonly name: string;
  readonly location?: Vector3 | undefined;
  /** Euler rotation in radians (XYZ), matching Blender's `rotation_euler`. */
  readonly rotation?: Vector3 | undefined;
  /** Uniform scale, or per-axis when a vector is given. */
  readonly scale?: number | Vector3 | undefined;
  /** Radius / size / major+minor radius depending on the primitive. */
  readonly size?: number | undefined;
  /**
   * Assign this material to the created object. Materials are declared by name and
   * resolved inside the script, so operations stay order-independent where it matters.
   */
  readonly material?: string | undefined;
}

export interface SetMaterialOperation {
  readonly op: "setMaterial";
  readonly name: string;
  /** `#RRGGBB` or `#RGB`. Converted to linear RGB inside the script. */
  readonly baseColor: string;
  readonly roughness?: number | undefined;
  readonly metallic?: number | undefined;
  /** Apply to these existing objects as well as to later primitives referring to it. */
  readonly applyTo?: readonly string[] | undefined;
}

export interface AddLightOperation {
  readonly op: "addLight";
  readonly kind: LightKind;
  readonly name: string;
  readonly location?: Vector3 | undefined;
  readonly rotation?: Vector3 | undefined;
  /** Watts. Blender's `light.energy` for point/spot/area. */
  readonly energy?: number | undefined;
  /** Area/spot size in metres. Ignored by sun and point, which have no size. */
  readonly size?: number | undefined;
}

export interface AddCameraOperation {
  readonly op: "addCamera";
  readonly name: string;
  readonly location?: Vector3 | undefined;
  /** Euler rotation in radians (XYZ). */
  readonly rotation?: Vector3 | undefined;
  /** Millimetres, matching Blender's `camera.lens`. */
  readonly focalLengthMm?: number | undefined;
  /** Make this the scene's active camera. The last camera to ask for it wins. */
  readonly makeActive?: boolean | undefined;
}

export interface SetRenderSettingsOperation {
  readonly op: "setRenderSettings";
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** Resolution percentage. 100 for full size. */
  readonly percentage?: number | undefined;
  readonly frameStart?: number | undefined;
  readonly frameEnd?: number | undefined;
  /**
   * Output path. Blender treats this as a prefix: for a still it appends the frame
   * number unless an extension is configured, so `render.ts` passes a path ending in
   * `.png`.
   */
  readonly outputPath?: string | undefined;
  /** `PNG`, `JPEG`, `OPEN_EXR`… Validated against `bpy.types.ImageFormatSettings`. */
  readonly fileFormat?: string | undefined;
  /**
   * Preferred engines, most-wanted first. Resolved against what this build actually
   * reports. See the EEVEE note in {@link buildSceneScript}.
   */
  readonly enginePreference?: readonly string[] | undefined;
  /** Cycles sample count when Cycles ends up selected. */
  readonly cyclesSamples?: number | undefined;
  /** Render on the CPU. Safer default in background mode without a configured GPU. */
  readonly cyclesDevice?: "CPU" | "GPU" | undefined;
}

export interface RenderOperation {
  readonly op: "render";
  /** Render the whole frame range to a sequence rather than a single still. */
  readonly animation?: boolean | undefined;
}

export type SceneOperation =
  | AddPrimitiveOperation
  | SetMaterialOperation
  | AddLightOperation
  | AddCameraOperation
  | SetRenderSettingsOperation
  | RenderOperation;

/**
 * Escape a string for use as a Python single-quoted literal.
 *
 * This is the security boundary of the whole module, so it is deliberately conservative:
 * it escapes every character that could terminate or extend the literal, not just the
 * obvious quote. Backslash MUST be escaped first — doing it in the other order would turn
 * `\'` into `\\'`, i.e. a literal backslash followed by a *closing* quote, which is a
 * working escape from the literal and a real injection.
 *
 * Control characters are escaped rather than passed through so a newline in a material
 * name cannot move the rest of the payload onto its own line where indentation rules stop
 * applying. Non-ASCII is left intact: the file is written as UTF-8 and Python 3 source is
 * UTF-8 by default, so escaping it would mangle legitimate names for no security gain.
 */
export function pythonStringLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\u0000/g, "\\x00")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (char) => {
      return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
    });

  return `'${escaped}'`;
}

/**
 * Render a finite number as a Python float literal.
 *
 * Rejects non-finite values instead of emitting them: `float('nan')` is valid Python but
 * silently poisons every downstream calculation in Blender (a NaN location makes geometry
 * disappear from the render with no error), and `Infinity` is not a Python literal at all,
 * so emitting it would produce a syntax error at runtime rather than at build time.
 */
export function pythonNumber(value: number, what: string): string {
  if (!Number.isFinite(value)) {
    throw new ScriptBuildError(`${what} must be a finite number, received ${String(value)}.`);
  }
  // `String(number)` produces a valid Python float/int literal for every finite double.
  return Object.is(value, -0) ? "0.0" : String(value);
}

export function pythonVector(value: Vector3, what: string): string {
  return `(${pythonNumber(value.x, `${what}.x`)}, ${pythonNumber(value.y, `${what}.y`)}, ${pythonNumber(value.z, `${what}.z`)})`;
}

/** Raised for a malformed operation. Thrown at build time, before Blender is launched. */
export class ScriptBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptBuildError";
  }
}

/** Blender's own identifiers for each primitive, so the mapping lives in one place. */
const PRIMITIVE_OPERATORS: Readonly<Record<PrimitiveKind, string>> = {
  cube: "bpy.ops.mesh.primitive_cube_add",
  sphere: "bpy.ops.mesh.primitive_uv_sphere_add",
  plane: "bpy.ops.mesh.primitive_plane_add",
  cylinder: "bpy.ops.mesh.primitive_cylinder_add",
  cone: "bpy.ops.mesh.primitive_cone_add",
  torus: "bpy.ops.mesh.primitive_torus_add",
};

const LIGHT_TYPES: Readonly<Record<LightKind, string>> = {
  point: "POINT",
  sun: "SUN",
  spot: "SPOT",
  area: "AREA",
};

/** `#RRGGBB` / `#RGB`, the only colour format accepted. */
const HEX_COLOUR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Parse a hex colour into 0–1 sRGB components.
 *
 * Validated here rather than in the generated script: a bad colour is a caller bug, and
 * failing at build time gives a stack trace pointing at the caller instead of a Blender
 * traceback pointing at generated code the caller never wrote.
 */
export function parseHexColour(hex: string): { r: number; g: number; b: number } {
  const match = HEX_COLOUR.exec(hex.trim());
  if (!match?.[1]) {
    throw new ScriptBuildError(
      `baseColor must be a hex colour like '#e6f55a', received ${JSON.stringify(hex)}.`,
    );
  }
  const digits = match[1];
  const expanded =
    digits.length === 3
      ? digits
          .split("")
          .map((d) => d + d)
          .join("")
      : digits;

  const r = Number.parseInt(expanded.slice(0, 2), 16) / 255;
  const g = Number.parseInt(expanded.slice(2, 4), 16) / 255;
  const b = Number.parseInt(expanded.slice(4, 6), 16) / 255;
  return { r, g, b };
}

/**
 * The runtime prelude injected into every generated script.
 *
 * It defines three helpers the operation bodies call:
 *
 *   - `_kinema_hex_to_linear` converts an sRGB hex colour to Blender's linear working
 *     space. Blender's `Base Color` input is linear, so feeding it sRGB values directly
 *     produces a visibly washed-out, too-bright material. The standard sRGB transfer
 *     function is applied here rather than in TypeScript so the conversion sits next to
 *     the assignment it feeds.
 *   - `_kinema_choose_engine` implements the EEVEE compatibility rule (see below).
 *   - `_kinema_set_base_color` implements the `use_nodes` compatibility guard.
 *
 * The leading underscore marks these as generated-script internals. They are plain
 * functions rather than `bpy` wrappers so a failed call raises a normal Python traceback
 * with a real line number in the generated file, which is what makes a Blender failure
 * diagnosable at all.
 */
const PRELUDE = `
def _kinema_hex_to_linear(hex_string):
    """Convert '#rrggbb' sRGB to Blender's linear RGB working space."""
    raw = hex_string.lstrip('#')
    channels = []
    for index in (0, 2, 4):
        srgb = int(raw[index:index + 2], 16) / 255.0
        # IEC 61966-2-1 sRGB transfer function. Skipping this is the single most common
        # reason a scripted material looks nothing like the colour that was asked for.
        if srgb <= 0.04045:
            channels.append(srgb / 12.92)
        else:
            channels.append(((srgb + 0.055) / 1.055) ** 2.4)
    return (channels[0], channels[1], channels[2], 1.0)


def _kinema_choose_engine(preferences):
    """Pick a render engine that THIS Blender build actually supports.

    Blender renames engines between releases: 4.2-5.0 reported 'BLENDER_EEVEE_NEXT' while
    5.1 reports 'BLENDER_EEVEE' again, and Blender 5.1 does not contain
    'BLENDER_EEVEE_NEXT' at all. Assigning an engine identifier that does not exist raises
    TypeError and aborts the whole script, so hardcoding a name is a version-dependent
    crash waiting to happen.

    Asking the RNA enum for the identifiers this build exposes is the only robust method.
    Returns (identifier, available_identifiers); the identifier is None when none of the
    preferences exist, in which case the caller keeps whatever engine is already set.
    """
    available = [
        item.identifier
        for item in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items
    ]
    for preferred in preferences:
        if preferred in available:
            return preferred, available
    return None, available


def _kinema_set_base_color(material, rgba, roughness, metallic):
    """Set a Principled BSDF, with a fallback for the use_nodes deprecation.

    'Material.use_nodes' is deprecated in 5.1 and scheduled for removal in Blender 6.0.
    Node materials remain the only way to set a Principled BSDF, so it must still be used
    - but guarded, with 'diffuse_color' (which the workbench engine and the material
    preview still honour) as the fallback. The exception is returned to the report rather
    than swallowed, so a silent loss of material fidelity is visible.
    """
    try:
        material.use_nodes = True
        tree = material.node_tree
        bsdf = tree.nodes.get('Principled BSDF') if tree is not None else None
        if bsdf is None:
            bsdf = tree.nodes.new('ShaderNodeBsdfPrincipled') if tree is not None else None
        if bsdf is None:
            raise RuntimeError('no Principled BSDF could be created')
        bsdf.inputs['Base Color'].default_value = rgba
        bsdf.inputs['Roughness'].default_value = roughness
        bsdf.inputs['Metallic'].default_value = metallic
        return None
    except Exception as exc:
        # Deprecated or removed: fall back to the flat viewport colour so the material is
        # still distinguishable, and report the reason.
        material.diffuse_color = rgba
        return str(exc)
`.trim();

/** Serialise one `addPrimitive` operation. */
function emitAddPrimitive(op: AddPrimitiveOperation, lines: string[]): void {
  const operator = PRIMITIVE_OPERATORS[op.kind];
  if (operator === undefined) {
    throw new ScriptBuildError(
      `Unsupported primitive kind ${JSON.stringify(op.kind)}. Supported: ${Object.keys(PRIMITIVE_OPERATORS).join(", ")}.`,
    );
  }

  const kwargs: string[] = [];
  if (op.location) kwargs.push(`location=${pythonVector(op.location, "location")}`);
  if (op.rotation) kwargs.push(`rotation=${pythonVector(op.rotation, "rotation")}`);
  if (op.scale !== undefined) {
    kwargs.push(
      `scale=${
        typeof op.scale === "number"
          ? pythonNumber(op.scale, "scale")
          : pythonVector(op.scale, "scale")
      }`,
    );
  }
  if (op.size !== undefined) {
    // Blender's mesh primitives disagree on the keyword for "how big": most take
    // `radius`, the plane takes `size`, and a torus takes `major_radius`. Spelling it
    // per primitive here is what lets one typed `size` field drive all six.
    const sizeKwarg = op.kind === "plane" ? "size" : op.kind === "torus" ? "major_radius" : "radius";
    kwargs.push(`${sizeKwarg}=${pythonNumber(op.size, "size")}`);
  }

  lines.push(`bpy.ops.${operator}(${kwargs.join(", ")})`);
  lines.push(`_object = bpy.context.active_object`);
  lines.push(`if _object is None:`);
  lines.push(`    _kinema_warnings.append('primitive ${op.kind} produced no active object')`);
  lines.push(`else:`);
  lines.push(`    _object.name = ${pythonStringLiteral(op.name)}`);
  if (op.material !== undefined) {
    lines.push(`    _kinema_material = bpy.data.materials.get(${pythonStringLiteral(op.material)})`);
    lines.push(`    if _kinema_material is None:`);
    lines.push(
      `        _kinema_warnings.append('material ' + ${pythonStringLiteral(op.material)} + ' not found for object ' + _object.name)`,
    );
    lines.push(`    else:`);
    lines.push(`        _object.data.materials.append(_kinema_material)`);
  }
  lines.push("");
}

/** Serialise one `setMaterial` operation. */
function emitSetMaterial(op: SetMaterialOperation, lines: string[]): void {
  const { r, g, b } = parseHexColour(op.baseColor);
  const roughness = op.roughness ?? 0.5;
  const metallic = op.metallic ?? 0.0;

  if (roughness < 0 || roughness > 1) {
    throw new ScriptBuildError(`roughness must be between 0 and 1, received ${roughness}.`);
  }
  if (metallic < 0 || metallic > 1) {
    throw new ScriptBuildError(`metallic must be between 0 and 1, received ${metallic}.`);
  }

  lines.push(`_kinema_material = bpy.data.materials.get(${pythonStringLiteral(op.name)})`);
  lines.push(`if _kinema_material is None:`);
  lines.push(`    _kinema_material = bpy.data.materials.new(name=${pythonStringLiteral(op.name)})`);
  lines.push(`_kinema_rgba = _kinema_hex_to_linear(${pythonStringLiteral(op.baseColor)})`);
  lines.push(`_kinema_warning = _kinema_set_base_color(`);
  lines.push(`    _kinema_material, _kinema_rgba,`);
  lines.push(`    ${pythonNumber(roughness, "roughness")}, ${pythonNumber(metallic, "metallic")})`);
  lines.push(`if _kinema_warning is not None:`);
  lines.push(
    `    _kinema_warnings.append('material ' + _kinema_material.name + ': ' + _kinema_warning)`,
  );
  lines.push(`_kinema_material.diffuse_color = _kinema_rgba`);

  for (const target of op.applyTo ?? []) {
    lines.push(`_kinema_target = bpy.data.objects.get(${pythonStringLiteral(target)})`);
    lines.push(`if _kinema_target is None:`);
    lines.push(
      `    _kinema_warnings.append('setMaterial target ' + ${pythonStringLiteral(target)} + ' does not exist')`,
    );
    lines.push(`elif _kinema_target.type != 'MESH':`);
    lines.push(
      `    _kinema_warnings.append('setMaterial target ' + _kinema_target.name + ' is not a mesh')`,
    );
    lines.push(`else:`);
    lines.push(`    _kinema_target.data.materials.clear()`);
    lines.push(`    _kinema_target.data.materials.append(_kinema_material)`);
  }
  lines.push("");
}

/** Serialise one `addLight` operation. */
function emitAddLight(op: AddLightOperation, lines: string[]): void {
  const lightType = LIGHT_TYPES[op.kind];
  if (lightType === undefined) {
    throw new ScriptBuildError(
      `Unsupported light kind ${JSON.stringify(op.kind)}. Supported: ${Object.keys(LIGHT_TYPES).join(", ")}.`,
    );
  }

  const kwargs: string[] = [`type='${lightType}'`];
  if (op.location) kwargs.push(`location=${pythonVector(op.location, "location")}`);
  if (op.rotation) kwargs.push(`rotation=${pythonVector(op.rotation, "rotation")}`);

  lines.push(`bpy.ops.object.light_add(${kwargs.join(", ")})`);
  lines.push(`_light = bpy.context.active_object`);
  lines.push(`if _light is None:`);
  lines.push(`    _kinema_warnings.append('light ${op.kind} produced no active object')`);
  lines.push(`else:`);
  lines.push(`    _light.name = ${pythonStringLiteral(op.name)}`);
  if (op.energy !== undefined) {
    if (op.energy < 0) {
      throw new ScriptBuildError(`energy must not be negative, received ${op.energy}.`);
    }
    lines.push(`    _light.data.energy = ${pythonNumber(op.energy, "energy")}`);
  }
  if (op.size !== undefined) {
    if (op.size <= 0) {
      throw new ScriptBuildError(`size must be greater than zero, received ${op.size}.`);
    }
    // Not every light type has a `size`; sun and point do not. Probe the RNA rather than
    // assuming, so a caller asking for a size on a sun gets a clear warning instead of an
    // AttributeError that aborts the whole build.
    lines.push(`    if hasattr(_light.data, 'size'):`);
    lines.push(`        _light.data.size = ${pythonNumber(op.size, "size")}`);
    lines.push(`    else:`);
    lines.push(
      `        _kinema_warnings.append('light ' + _light.name + ' has no size attribute; ignored')`,
    );
  }
  lines.push("");
}

/** Serialise one `addCamera` operation. */
function emitAddCamera(op: AddCameraOperation, lines: string[]): void {
  const kwargs: string[] = [];
  if (op.location) kwargs.push(`location=${pythonVector(op.location, "location")}`);
  if (op.rotation) kwargs.push(`rotation=${pythonVector(op.rotation, "rotation")}`);

  lines.push(`bpy.ops.object.camera_add(${kwargs.join(", ")})`);
  lines.push(`_camera = bpy.context.active_object`);
  lines.push(`if _camera is None:`);
  lines.push(`    _kinema_warnings.append('camera produced no active object')`);
  lines.push(`else:`);
  lines.push(`    _camera.name = ${pythonStringLiteral(op.name)}`);
  if (op.focalLengthMm !== undefined) {
    if (op.focalLengthMm <= 0) {
      throw new ScriptBuildError(
        `focalLengthMm must be greater than zero, received ${op.focalLengthMm}.`,
      );
    }
    lines.push(`    _camera.data.lens = ${pythonNumber(op.focalLengthMm, "focalLengthMm")}`);
  }
  if (op.makeActive) {
    lines.push(`    bpy.context.scene.camera = _camera`);
  }
  lines.push("");
}

/** Serialise one `setRenderSettings` operation. */
function emitSetRenderSettings(op: SetRenderSettingsOperation, lines: string[]): void {
  const positiveInts: [string, number | undefined, string][] = [
    ["width", op.width, "scene.render.resolution_x"],
    ["height", op.height, "scene.render.resolution_y"],
    ["percentage", op.percentage, "scene.render.resolution_percentage"],
    ["frameStart", op.frameStart, "scene.frame_start"],
    ["frameEnd", op.frameEnd, "scene.frame_end"],
  ];

  for (const [label, value, target] of positiveInts) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new ScriptBuildError(`${label} must be a positive integer, received ${String(value)}.`);
    }
    lines.push(`${target} = ${value}`);
  }

  if (op.frameStart !== undefined && op.frameEnd !== undefined && op.frameEnd < op.frameStart) {
    throw new ScriptBuildError(
      `frameEnd (${op.frameEnd}) must not be before frameStart (${op.frameStart}).`,
    );
  }

  if (op.outputPath !== undefined) {
    // Blender's filepath is a *prefix*. For a still it appends the frame number plus the
    // format's extension unless the path already ends in one, which is why the caller
    // passes something ending in `.png`. Escaped like every other string: an output path
    // is exactly the sort of value that arrives from a user.
    lines.push(`scene.render.filepath = ${pythonStringLiteral(op.outputPath)}`);
  }

  if (op.fileFormat !== undefined) {
    // Validate against the enum this build exposes rather than trusting the name. Same
    // reasoning as the engine: a name that does not exist raises on assignment.
    lines.push(`_kinema_formats = [`);
    lines.push(`    item.identifier`);
    lines.push(
      `    for item in bpy.types.ImageFormatSettings.bl_rna.properties['file_format'].enum_items`,
    );
    lines.push(`]`);
    lines.push(`if ${pythonStringLiteral(op.fileFormat)} in _kinema_formats:`);
    lines.push(`    scene.render.image_settings.file_format = ${pythonStringLiteral(op.fileFormat)}`);
    lines.push(`else:`);
    lines.push(
      `    _kinema_warnings.append('file format ' + ${pythonStringLiteral(op.fileFormat)} + ' is not available in this Blender build; available: ' + ', '.join(_kinema_formats))`,
    );
  }

  const preferences: readonly string[] =
    op.enginePreference ?? ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"];

  lines.push(`_kinema_engine, _kinema_engines_available = _kinema_choose_engine([`);
  for (const preference of preferences) {
    lines.push(`    ${pythonStringLiteral(preference)},`);
  }
  lines.push(`])`);
  lines.push(`if _kinema_engine is None:`);
  lines.push(
    `    _kinema_warnings.append('none of the preferred engines exist in this build; available: ' + ', '.join(_kinema_engines_available))`,
  );
  lines.push(`else:`);
  lines.push(`    scene.render.engine = _kinema_engine`);

  if (op.cyclesSamples !== undefined) {
    if (!Number.isInteger(op.cyclesSamples) || op.cyclesSamples <= 0) {
      throw new ScriptBuildError(
        `cyclesSamples must be a positive integer, received ${String(op.cyclesSamples)}.`,
      );
    }
    // Background (headless) renders have no configured GPU context, so Cycles defaults to
    // CPU anyway; setting it explicitly removes the ambiguity, and a low sample count is
    // the difference between a 5-second smoke render and a multi-minute one.
    lines.push(`if scene.render.engine == 'CYCLES':`);
    if (op.cyclesDevice !== undefined) {
      lines.push(`    scene.cycles.device = '${op.cyclesDevice}'`);
    }
    lines.push(`    scene.cycles.samples = ${op.cyclesSamples}`);
  } else if (op.cyclesDevice !== undefined) {
    lines.push(`if scene.render.engine == 'CYCLES':`);
    lines.push(`    scene.cycles.device = '${op.cyclesDevice}'`);
  }

  lines.push("");
}

/** Build the operation body. Split out so the prelude stays readable. */
function emitOperations(operations: readonly SceneOperation[]): string {
  const lines: string[] = [];

  for (const [index, operation] of operations.entries()) {
    lines.push(`# --- operation ${index + 1}: ${operation.op} ---`);
    switch (operation.op) {
      case "addPrimitive":
        emitAddPrimitive(operation, lines);
        break;
      case "setMaterial":
        emitSetMaterial(operation, lines);
        break;
      case "addLight":
        emitAddLight(operation, lines);
        break;
      case "addCamera":
        emitAddCamera(operation, lines);
        break;
      case "setRenderSettings":
        emitSetRenderSettings(operation, lines);
        break;
      case "render":
        lines.push(`_kinema_render_error = None`);
        lines.push(`try:`);
        lines.push(
          `    bpy.ops.render.render(${operation.animation === true ? "animation=True" : "write_still=True"})`,
        );
        lines.push(`    _kinema_report['render'] = 'ok'`);
        lines.push(`except Exception as _exc:`);
        lines.push(`    _kinema_render_error = str(_exc)`);
        lines.push(`    _kinema_report['render'] = 'failed: ' + _kinema_render_error`);
        lines.push(`    _kinema_warnings.append('render failed: ' + _kinema_render_error)`);
        lines.push("");
        break;
      default: {
        // Exhaustiveness: adding an operation to the union without handling it here is a
        // compile error, which is the point of a closed operation set.
        const unreachable: never = operation;
        throw new ScriptBuildError(`Unhandled operation: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * The report epilogue.
 *
 * The report is printed even when the build raised, because a partial scene plus a
 * traceback is far more useful than a traceback alone. It runs from a `finally` so no
 * code path can skip it.
 */
const EPILOGUE = `
_kinema_report['objects'] = sorted([_object.name for _object in bpy.data.objects])
_kinema_report['materials'] = sorted([_material.name for _material in bpy.data.materials])
_kinema_report['engine'] = scene.render.engine
_kinema_report['resolution'] = [scene.render.resolution_x, scene.render.resolution_y]
_kinema_report['resolutionPercentage'] = scene.render.resolution_percentage
_kinema_report['frameRange'] = [scene.frame_start, scene.frame_end]
_kinema_report['outputPath'] = scene.render.filepath
_kinema_report['fileFormat'] = scene.render.image_settings.file_format
_kinema_report['camera'] = scene.camera.name if scene.camera is not None else None
_kinema_report['warnings'] = _kinema_warnings
_kinema_report['elapsedMs'] = int((time.time() - _kinema_started) * 1000)

print('${REPORT_START_MARKER}')
print(json.dumps(_kinema_report))
print('${REPORT_END_MARKER}')
`.trim();

export interface BuildSceneScriptOptions {
  readonly operations: readonly SceneOperation[];
  /**
   * Start from an empty scene rather than Blender's default cube/light/camera.
   *
   * Default true. The default startup scene silently adds three objects the caller never
   * asked for, which makes "the report names exactly the objects I built" impossible to
   * assert and makes renders non-deterministic against a saved .blend.
   */
  readonly emptyScene?: boolean | undefined;
}

/**
 * Turn typed operations into a Blender Python script.
 *
 * The result is deterministic: the same operations always produce byte-identical source,
 * so a rendered asset can be reproduced from the recorded provenance.
 */
export function buildSceneScript(options: BuildSceneScriptOptions): string {
  const { operations } = options;
  const emptyScene = options.emptyScene ?? true;

  if (operations.length === 0) {
    throw new ScriptBuildError("At least one operation is required.");
  }

  const body = emitOperations(operations);

  return [
    "import bpy",
    "import json",
    "import time",
    "",
    "# Generated by @kinema/blender. Do not edit by hand: regenerate from the typed",
    "# operation list instead, so the escaping guarantees in script-builder.ts still hold.",
    "",
    "_kinema_started = time.time()",
    "_kinema_warnings = []",
    "_kinema_report = {}",
    "",
    "scene = bpy.context.scene",
    "",
    emptyScene
      ? [
          "# Start from a genuinely empty scene. Blender's factory startup adds a cube, a",
          "# light and a camera, which would appear in the report and in the render without",
          "# the caller ever asking for them.",
          "bpy.ops.wm.read_factory_settings(use_empty=True)",
          "scene = bpy.context.scene",
          "",
        ].join("\n")
      : "",
    PRELUDE,
    "",
    body,
    "",
    EPILOGUE,
    "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * The shape the generated script emits.
 *
 * `render.ts` parses stdout into this. Every field is defensive: a report that is missing
 * a field must not crash the parser, because the report is printed even from a failed
 * build and a partial report is still worth returning.
 */
export interface BlenderReport {
  readonly objects?: readonly string[];
  readonly materials?: readonly string[];
  readonly engine?: string;
  readonly resolution?: readonly number[];
  readonly resolutionPercentage?: number;
  readonly frameRange?: readonly number[];
  readonly outputPath?: string;
  readonly fileFormat?: string;
  readonly camera?: string | null;
  readonly warnings?: readonly string[];
  readonly render?: string;
  readonly elapsedMs?: number;
}

/** Frames per second the report's frame range is interpreted against. Blender's default. */
export const DEFAULT_FRAME_RATE = 24;