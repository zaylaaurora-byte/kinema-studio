# ADR 0002 — Blender integration via MCP

- **Status:** Accepted (integration deferred to a phase after the pilot gate)
- **Date:** 2026-10-24
- **Deciders:** Project owner, implementation agent

## Context

The owner asked for a native Blender connection so users can build 3D scenes locally and
have an AI make real-time edits through chat — change a rig, build a scene, trigger a
render.

This is a good fit for the product: the spec's orientation is 2D animation and faceless
video, but a 3D path adds genuinely new capability (real cameras, real lighting, real
depth) without replacing the 2D pipeline. Blender is free, open source, scriptable, and
already installed on the development machine (**Blender 5.1.0**, build 2026-03-17).

## Findings

### The tool exists and is mature

`ahujasid/blender-mcp` — renamed on PyPI from `blender-mcp` to **`mcp-for-blender`**
(v2.0.0). MIT licensed. Actively maintained, with a Discord, a website, sponsorship and a
large user base. The rename is handled transparently: `uvx blender-mcp` still works, and
no config change is required for existing setups.

**Important for us:** we should depend on the current name, `mcp-for-blender`, and note
the alias so a reader is not confused by the older references elsewhere.

### Architecture

Two components:

1. **A Blender addon** that opens a TCP **socket server on port 9876** (default) inside
   Blender, and executes commands it receives.
2. **An MCP server** (Python, via `uvx`) that speaks MCP to the client on one side and
   this JSON-over-TCP protocol to the addon on the other.

Configuration is by environment variable: `BLENDER_HOST` (default `localhost`),
`BLENDER_PORT` (default `9876`).

### Capability surface — nine MCP tools

| Tool | Relevance to Kinema |
|---|---|
| `execute_blender_code` | Run arbitrary Blender Python in the user's live session. The core mechanism. |
| `look` | **Visual verification** — viewport, camera, multi-angle sheets, animation strips, in solid/material/rendered/wireframe/xray. This is what lets an agent check its own work. |
| `get_scene_info` | Compact scene summary with selectable fields. |
| `generate_3d` | Text/image → 3D via Tripo, Hunyuan3D, Hyper3D Rodin, Meshy. **Paid, third-party, optional.** |
| `search_assets` / `import_asset` | Poly Haven (CC0 HDRIs/textures/models), Sketchfab, Poly Pizza (low-poly). |
| `get_addon_status` | Blender/addon versions and which libraries are enabled. |
| `disable_telemetry`, `record_trajectory_feedback` | Data controls. |

The `look` tool matters most for our use case: an AI that can *see* what it built is the
difference between an agent that iterates to a correct result and one that fires blind
commands. It is also the tool that makes "real-time chat edits" credible rather than
hopeful.

### Licensing — clean

- The MCP integration itself is **MIT**. Compatible with this project's AGPL-3.0 core.
- **Poly Haven assets are CC0** — no attribution required, commercial or otherwise. Safe.
- **Poly Pizza is mixed**: roughly 69% of the catalogue is CC-BY, which *requires*
  crediting the creator wherever the model appears. The integration writes a
  ready-formatted credit line onto each imported object as `polypizza_attribution`, so the
  obligation is at least machine-trackable. **We must surface this in the UI and record it
  in our own asset provenance** rather than relying on a custom property inside a .blend.
- Sketchfab models carry their own per-asset licences and need review case by case.
- AI 3D generators (Meshy, Tripo, Hunyuan3D, Hyper3D Rodin) are **paid third-party
  services** with their own terms, and the addon's "Premium" tier resells access without
  the user bringing a key. We should support BYOK and decline to resell.

## Decisions

### 1. Integrate as a local capability, not a hosted dependency

Blender runs on the user's machine, unchanged. We drive it. This fits the project's
local-first requirement and means the feature works with no cloud account, exactly like
the rest of the app.

We will **not** bundle or wrap Blender. We detect it, and if absent we say so plainly and
offer the download link. Bundling a 108 MB+ application would be an enormous dependency
and a licensing distraction.

### 2. Implement our own MCP client rather than shelling out to an agent

The integration's own installer wires Blender into third-party chat clients (Claude
Desktop, Codex, Cursor…). That is not our product. We need Blender to be a **provider
inside Kinema**, so that:

- Blender-generated assets land in our asset library with our provenance records.
- Our Director agent can delegate to Blender as one tool among many.
- Our approval, cost and audit model applies.
- The user does not have to install and configure a separate AI chat client.

So: we implement an MCP client that speaks to `mcp-for-blender`, and expose its tools
through our existing `ProviderAdapter`/agent-tool abstraction. The user still needs the
addon installed in Blender — we detect and guide that — but not a separate AI client.

### 3. Two distinct integration modes

These have very different risk and cost profiles and must not be conflated:

| Mode | What it does | Cost | Risk |
|---|---|---|---|
| **Scene control** | Drive the user's open Blender: build geometry, materials, lights, cameras, trigger renders | Free | High — see security |
| **Asset generation** | Text/image → 3D model via Meshy/Tripo/Hunyuan3D/Rodin | Paid, per model | Low — just an API call |

Scene control is the headline feature the owner asked for and the higher-risk half. Asset
generation is a straightforward paid adapter.

### 4. Security — the significant finding

**The addon's socket server has no authentication and no encryption.** Its own
documentation states this plainly:

> the addon's socket server has no authentication or encryption, so anyone who can reach
> that port can run Python inside Blender

`execute_blender_code` runs **arbitrary Python** in the user's Blender process. That is
equivalent to arbitrary code execution on the user's machine at their privilege level.

This is acceptable for a local, single-user tool where the user is deliberately driving
their own Blender. It is **not** acceptable to expose casually. Required mitigations:

1. **Never expose the Blender port beyond localhost.** No port forwarding, no `0.0.0.0`
   binding, no relay through our API.
2. **Offer safe mode.** The integration ships `BLENDER_MCP_SAFE_MODE=1`, which validates
   scripts before execution and blocks file I/O, subprocess execution, network access and
   persistent code installation. **Kinema should default safe mode ON** for any
   agent-generated code, and require an explicit, explained opt-out for the user's own
   scripts.
3. **Show the code before it runs** where practical, at least in an audit log. The user
   must be able to see what was executed on their machine after the fact, with a diff
   where a previous version exists.
4. **Treat the port as a trust boundary.** Verify the thing on the other end is Blender
   before sending commands, and never send user-uploaded content to an unverified port.
5. **Never auto-run agent-generated Blender code from an untrusted source.** Content that
   came from a web page, an uploaded file or a shared project is untrusted input and must
   not reach `execute_blender_code` without human review. This is a prompt-injection path
   straight to code execution.

### 5. Telemetry — disabled

The integration collects a minimal anonymous usage record by default, and can be turned
off entirely with `DISABLE_TELEMETRY=true`. It is opt-in for content (prompts, code,
screenshots, scene data) but the basic record is on unless disabled.

**Kinema will set `DISABLE_TELEMETRY=true` by default** and offer no in-app switch. A
creative tool should not report the user's activity to a third party by default, and our
own security documentation promises auditability. Users who want to send that data can
configure the standalone server themselves.

### 6. Rendering

Two viable routes, and we should support both:

- **In-Blender render** (Cycles or EEVEE) to an image or image sequence, driven through
  the existing `execute_blender_code` and `look` tools. Correct for anything
  photorealistic, and uses the user's GPU properly. The RTX 2060's 6 GB VRAM makes EEVEE
  the pragmatic default and Cycles viable for modest scenes.
- **Blender as a scene source for our own pipeline** — export geometry, cameras and
  animation, then composite in our 2D pipeline. Useful for hybrid shots where a 3D
  background sits behind 2D characters.

The second is the more interesting integration for this product, since the pilot is 2D.
Recording both options prevents the assumption that 3D must mean a fully Blender-rendered
shot.

### 7. Detecting the install

Per the verified environment record: Blender lives at
`C:\Program Files\Blender Foundation\Blender 5.1\blender.exe` on the development machine,
and version 5.1.0 satisfies the integration's "Blender 3.0 or newer" requirement.

Detection must not hardcode that path. Probe, in order: the `BLENDER_PATH` environment
variable, `blender` on `PATH`, then the platform's standard install locations, and let the
user point at a custom location.

## Consequences

- Blender becomes a **provider**, so it should be registered in the provider registry like
  any other — with an honest capability descriptor. Crucially, it must declare what it
  *cannot* do: it is not a 2D animation tool, and it cannot guarantee any particular
  stylistic match to the reference sheets.
- The **pilot gate comes first.** The 2D pipeline must produce a real MP4 with the locked
  characters before 3D work begins. Adding Blender now would split effort across two
  unfinished pipelines and risk delivering neither — precisely the failure the pilot pack
  warns about by insisting on a rendered clip as the definition of done.
- Blender integration therefore sits **after** the pilot in the milestone order, and this
  ADR exists so the design thinking is captured and the security decisions are not
  rediscovered late.

## Verification status

- Blender version and path: **verified directly** on this machine.
- Package identity, licence, architecture, tool list, environment variables and the
  security warning: **verified** against the official repository README, 2026-10-24.
- `blender_mcp.py` is **already installed** at
  `%APPDATA%\Blender Foundation\Blender\5.1\scripts\addons\blender_mcp.py` (270,889 bytes,
  addon v1.8), and `uv`/`uvx` are present at `%USERPROFILE%\.local\bin`.
- Poly Haven CC0 status and the Poly Pizza CC-BY proportion: **as documented by the
  integration**; the underlying licences should be confirmed at the source before any
  commercial launch.

### Spike results (run 2026-10-24, `tools/verify_blender.py`)

**Headless scene build and render: WORKS.** Blender 5.1.0 was driven with
`--background --factory-startup --python <script>`; it built geometry, a material, a light
and a camera, and rendered a 480x360 PNG in **5.3 seconds**. The output was decoded
independently with Pillow: 480x360 RGBA, 1,898 unique colours, std 71.5 — real content,
not a blank frame. Visual inspection confirms a correctly lit sphere with shadow on a
ground plane.

**Socket server: not exercised**, because it requires a running, addon-enabled Blender.
That is precisely the point: the headless path needs no GUI and no listening port.

### Two Blender 5.1 incompatibilities found, both now handled

These are recorded because they will recur and the failure mode is a hard crash:

1. **The EEVEE engine enum was renamed back.** `BLENDER_EEVEE_NEXT` (used in 4.2–5.0) does
   not exist in 5.1, which reports `('BLENDER_EEVEE', 'BLENDER_WORKBENCH', 'CYCLES')`.
   Assigning an unknown engine raises `TypeError` and aborts the script. **Never hardcode
   an engine name** — query
   `bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items` and choose the first
   supported preference.
2. **`Material.use_nodes` is deprecated**, scheduled for removal in Blender 6.0. Node
   materials are still the only way to set a Principled BSDF, so it must be used but
   guarded, with a `diffuse_color` fallback.

Both are handled in the spike script, which is a reusable reference for the real
implementation.

### Architectural conclusion — the significant finding

**Kinema should drive Blender headlessly (`--background --python`) for anything it
initiates itself, and treat the socket server as a separate, opt-in feature.**

The socket server exists to let an *external chat client* drive an *already-open*
Blender. Kinema does not need that indirection for batch work, and gains real advantages
by launching Blender directly:

| | Headless script | Socket server |
|---|---|---|
| Listening port | **None** | 9876, no auth, arbitrary Python |
| Determinism | High (`--factory-startup`) | Depends on session state |
| Cancellation | Kill the child process | No clean cancellation |
| Testable without a GUI | Yes (proved above) | No |
| Speed | 5.3s for build + render | Extra hop, plus requires a user's open app |

The socket path remains valuable for exactly one thing it uniquely enables: **live,
interactive editing of a Blender session the user already has open**, with the agent
checking its own work through the addon's `look` tool. That is a genuinely different
feature from batch scene building, and should be opt-in with safe mode on.

This reverses the naive approach of wiring up the MCP server and calling it done. The
MCP server is still the right abstraction for the *interactive* mode — and it is worth
using there rather than reimplementing its protocol — but it is not required for the
core capability.