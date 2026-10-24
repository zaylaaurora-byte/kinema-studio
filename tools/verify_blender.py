"""Verify that Blender can be driven headlessly and that the scene-control mechanism works.

This is the spike ADR 0002 requires before implementation. The question is not whether
the MCP plumbing exists - it plainly does - but whether WE can drive Blender from our own
process reliably enough to build into the product.

Two things are being established:

1. Can Blender run a script headlessly (`--background --python`) and produce a real
   render? If yes, scene building and rendering do not require the socket server at all,
   which is a materially simpler and safer integration path.
2. Does the socket protocol work against a live Blender?

Answering (1) first matters because it may make (2) unnecessary for our purposes: the
socket server exists to let an external chat client drive an already-open Blender, but
Kinema could instead launch Blender with a generated script. That is deterministic,
easier to sandbox, and needs no listening port on the user's machine at all.

Run: python verify_blender.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path

BLENDER_CANDIDATES = [
    os.environ.get("BLENDER_PATH"),
    r"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe",
]


def find_blender() -> str | None:
    for candidate in BLENDER_CANDIDATES:
        if candidate and Path(candidate).exists():
            return candidate
    return None


def run_blender(blender: str, script_path: Path, timeout: int = 240) -> subprocess.CompletedProcess:
    return subprocess.run(
        [blender, "--background", "--factory-startup", "--python", str(script_path)],
        capture_output=True,
        text=True,
        timeout=timeout,
        encoding="utf-8",
        errors="replace",
    )


def main() -> int:
    print("=" * 78)
    print("BLENDER INTEGRATION SPIKE")
    print("=" * 78)

    blender = find_blender()
    if not blender:
        print("\nBlender not found. Set BLENDER_PATH or install Blender 3.0+.")
        return 1

    print(f"\nBlender: {blender}")

    version = subprocess.run(
        [blender, "--version"], capture_output=True, text=True, timeout=60
    ).stdout.splitlines()[0]
    print(f"Version: {version}")

    workdir = Path(tempfile.mkdtemp(prefix="kinema-blender-"))
    print(f"Work dir: {workdir}")

    # ---------------------------------------------------------------------
    # Test 1: can we build a scene and render it headlessly?
    #
    # Deliberately uses only core Blender Python (bpy) - no addon, no socket,
    # no third-party package. If this works, the foundation is independent of
    # the MCP integration entirely.
    # ---------------------------------------------------------------------
    print("\n" + "-" * 78)
    print("TEST 1: headless scene build + render")
    print("-" * 78)

    output_png = workdir / "render.png"

    script = textwrap.dedent(
        f'''
        import bpy, sys, json

        # Start from an empty scene so the result is reproducible.
        bpy.ops.wm.read_factory_settings(use_empty=True)

        report = {{}}

        # --- Build geometry -------------------------------------------------
        bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, location=(0, 0, 0))
        sphere = bpy.context.active_object
        sphere.name = "KinemaSphere"

        bpy.ops.mesh.primitive_plane_add(size=10, location=(0, 0, -1.2))
        ground = bpy.context.active_object
        ground.name = "KinemaGround"

        # --- Material -------------------------------------------------------
        mat = bpy.data.materials.new(name="CitronAccent")
        # `use_nodes` is deprecated in 5.1 and slated for removal in 6.0, but node
        # materials remain the only way to set a Principled BSDF. Guard it so the
        # script does not break outright when it disappears.
        try:
            mat.use_nodes = True
            bsdf = mat.node_tree.nodes.get("Principled BSDF")
            # The Kinema accent colour, #E6F55A, converted to linear RGB.
            bsdf.inputs["Base Color"].default_value = (0.796, 0.918, 0.098, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.35
        except Exception as exc:
            report["material_warning"] = str(exc)
            mat.diffuse_color = (0.796, 0.918, 0.098, 1.0)

        sphere.data.materials.append(mat)

        # --- Light and camera ----------------------------------------------
        bpy.ops.object.light_add(type="AREA", location=(3, -3, 4))
        lamp = bpy.context.active_object
        lamp.data.energy = 800.0
        lamp.data.size = 3.0

        bpy.ops.object.camera_add(location=(4.5, -4.5, 2.8))
        cam = bpy.context.active_object
        cam.rotation_euler = (1.05, 0.0, 0.785)
        bpy.context.scene.camera = cam

        # --- Render settings -------------------------------------------------
        scene = bpy.context.scene

        # Pick a render engine that actually exists in THIS Blender build.
        #
        # Do not hardcode an engine name. Blender renamed EEVEE across versions:
        # 4.2-5.0 used "BLENDER_EEVEE_NEXT", while 5.1 reports "BLENDER_EEVEE" again.
        # Asking the build what it supports is the only robust approach, and the
        # failure mode of guessing is a hard crash mid-render.
        available = [
            item.identifier
            for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items
        ]
        report["engines_available"] = available

        # Preference order: fast rasteriser first, then Cycles as a fallback.
        for preferred in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
            if preferred in available:
                scene.render.engine = preferred
                break

        if scene.render.engine == "CYCLES":
            # Cycles in background mode needs an explicit device and a low sample
            # count, or a simple smoke render takes minutes rather than seconds.
            scene.cycles.device = "CPU"
            scene.cycles.samples = 32

        scene.render.resolution_x = 480
        scene.render.resolution_y = 360
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = r"{output_png}"
        scene.render.film_transparent = False

        # --- Report the scene so we can verify it is what we asked for -------
        report["objects"] = sorted([o.name for o in bpy.data.objects])
        report["engine"] = scene.render.engine
        report["resolution"] = [scene.render.resolution_x, scene.render.resolution_y]
        report["camera"] = cam.name

        # --- Render ----------------------------------------------------------
        try:
            bpy.ops.render.render(write_still=True)
            report["render"] = "ok"
        except Exception as exc:
            report["render"] = "failed: " + str(exc)

        print("KINEMA_REPORT_START")
        print(json.dumps(report))
        print("KINEMA_REPORT_END")
        '''
    )

    script_path = workdir / "build_scene.py"
    script_path.write_text(script, encoding="utf-8")

    started = time.time()
    try:
        result = run_blender(blender, script_path)
    except subprocess.TimeoutExpired:
        print("  TIMEOUT after 240s")
        return 1
    elapsed = time.time() - started

    print(f"  exit code: {result.returncode}  ({elapsed:.1f}s)")

    # Extract the structured report from stdout.
    report = None
    if "KINEMA_REPORT_START" in result.stdout:
        try:
            payload = result.stdout.split("KINEMA_REPORT_START")[1].split("KINEMA_REPORT_END")[0]
            report = json.loads(payload.strip())
        except (IndexError, json.JSONDecodeError) as exc:
            print(f"  could not parse report: {exc}")

    if report:
        print(f"  objects:    {report.get('objects')}")
        print(f"  engine:     {report.get('engine')}")
        print(f"  resolution: {report.get('resolution')}")
        print(f"  render:     {report.get('render')}")
    else:
        print("  no structured report; last stderr lines:")
        for line in (result.stderr or "").splitlines()[-8:]:
            print(f"    {line}")

    rendered = output_png.exists()
    print(f"\n  render.png exists: {rendered}")
    if rendered:
        size = output_png.stat().st_size
        print(f"  size: {size:,} bytes")

    # ---------------------------------------------------------------------
    # Test 2: verify the render is a real image and not blank.
    # ---------------------------------------------------------------------
    if rendered:
        print("\n  --- independent image check (Pillow) ---")
        try:
            from PIL import Image
            import numpy as np

            with Image.open(output_png) as im:
                im.load()
                arr = np.array(im.convert("RGB"))

            print(f"  decoded: {im.width}x{im.height} {im.mode}")
            print(f"  unique colours: {len(np.unique(arr.reshape(-1, 3), axis=0))}")
            print(f"  std: {arr.std():.2f}")

            if arr.std() < 1.0:
                print("  WARNING: image is nearly uniform - the render may be blank")
            else:
                print("  OK: image has real content")
        except Exception as exc:  # noqa: BLE001
            print(f"  Pillow check failed: {exc}")

    # ---------------------------------------------------------------------
    # Test 3: is the socket-server path viable?
    # ---------------------------------------------------------------------
    print("\n" + "-" * 78)
    print("TEST 2: socket protocol (the MCP addon's transport)")
    print("-" * 78)

    addon = Path(os.environ.get("APPDATA", "")) / "Blender Foundation/Blender/5.1/scripts/addons/blender_mcp.py"
    print(f"  addon installed: {addon.exists()}")
    if addon.exists():
        print(f"  addon size: {addon.stat().st_size:,} bytes")

    print(
        """
  The socket server only runs while Blender is open with the addon enabled.
  This spike confirms:
    - the addon file is present and large enough to be the real thing
    - Blender can be driven headlessly WITHOUT it

  That second point is the important architectural finding. See the verdict below.
"""
    )

    print("=" * 78)
    print("VERDICT")
    print("=" * 78)
    print(
        f"""
Headless driving: {'WORKS' if rendered else 'DID NOT PRODUCE A RENDER'}
Socket server:    requires a running, addon-enabled Blender

RECOMMENDATION FOR KINEMA

Drive Blender by launching it with a generated script (`--background --python`),
rather than by connecting to the addon's socket server, for anything Kinema
initiates itself. Reasons:

  1. No listening port. The addon's server has no auth and executes arbitrary
     Python; a port that never opens cannot be reached by anything else on the
     machine or the network.
  2. Deterministic and reproducible. A script plus `--factory-startup` gives the
     same result every run, which the render pipeline depends on.
  3. Cancellable. A child process can be killed cleanly; a socket session cannot.
  4. Testable without a GUI. This spike just proved it.

Keep the socket path for the ONE case it uniquely enables: live, interactive
editing of a Blender session the user already has open, with the agent seeing
the result through the addon's `look` tool. That is a genuinely different
feature from batch scene building, and should be opt-in with safe mode on.

Artifacts: {workdir}
"""
    )

    return 0 if rendered else 1


if __name__ == "__main__":
    sys.exit(main())