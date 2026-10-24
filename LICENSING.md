# Licensing

Kinema Studio's core is licensed **AGPL-3.0-or-later** (see [`LICENSE`](LICENSE)).

## Why AGPL

The core is public because a creative tool earns trust through inspectability, and
because the provider-adapter layer benefits enormously from community contributions —
every new provider is a plugin someone else can write.

AGPL is chosen over MIT/Apache so that if someone runs a modified version of Kinema
as a network service, they must offer their users the corresponding source. This keeps
the project's improvements in the commons.

### What this means for you

**You can, freely:**
- Self-host Kinema Studio for yourself, your studio, or your clients.
- Modify it for private use, including internal commercial use.
- Charge for your time installing, configuring, supporting or customising it.
- Publish forks and patches, provided you keep the same license.

**You must, if you run it as a network service for others:**
- Make the complete corresponding source of your modified version available to those
  users, including your modifications.

**You may not:**
- Rebrand it and resell it as a closed hosted product.

## Commercial licensing

A separate commercial license may be offered in future for organisations that need to
use the code in ways AGPL does not permit. Nothing about that changes your rights under
AGPL today.

## Third-party dependencies and their licenses

Every runtime dependency must be license-compatible with AGPL-3.0 distribution.
Decisions made so far, with the reasoning:

| Dependency | License | Note |
|---|---|---|
| Next.js, React, Tailwind | MIT | Fine. |
| shadcn/ui, Radix UI | MIT | Components are copied into the repo, so they are ours to modify. |
| Motion (framer-motion) | MIT | Fine. |
| `@xyflow/react` (React Flow) | **MIT** | Safe for commercial use. The paid "Pro" tier is optional support and pro examples, **not** a license requirement. |
| `@napi-rs/canvas` | MIT | Server-side Canvas2D. Prebuilt N-API binaries, so no native build tools required. |
| `puppeteer` | Apache-2.0 | Frame capture. |
| `wavesurfer.js` | BSD-3-Clause | Waveform rendering. |
| PostgreSQL, Drizzle ORM | PostgreSQL / Apache-2.0 | Fine. |
| **FFmpeg** | **LGPL-2.1+ build** | **See below — this matters.** |
| GSAP | proprietary "no charge" | Used only on the marketing site; replaceable. |

### FFmpeg — the one that needs care

FFmpeg is LGPL-2.1+ **only if built without `--enable-gpl` and `--enable-nonfree`**.
The commonly-recommended npm package `ffmpeg-static` is **GPL-3.0-or-later**, because
its binaries bundle **libx264**, which is itself GPL-2.0. Distributing a GPL FFmpeg
inside this project would place the whole combined work under GPL obligations.

**Rules for this repo:**

1. Do **not** add `ffmpeg-static` or `@ffmpeg-installer/ffmpeg` as a dependency.
   (The latter is additionally mislabeled: its top-level field says LGPL-2.1 while the
   Windows binary package is GPLv3 and dates from 2018.)
2. The render pipeline targets an **LGPL build** without libx264, or a
   **user-supplied system FFmpeg** that we do not distribute.
3. Prefer `child_process.spawn` with an explicit argument array over `fluent-ffmpeg`
   (which is dormant since 2024 and adds a shell-injection surface).

> **H.264 patent licensing is a separate matter from open-source licensing.** An LGPL
> build grants no patent rights. Any commercial distribution of H.264 content at scale
> should take legal advice. Recorded here so the decision isn't rediscovered later.

### Dependencies deliberately rejected

- **Remotion** — not an OSI-approved license; free only for organisations of ≤3
  employees, otherwise a per-render fee with a monthly floor. Unsuitable as a
  foundational dependency. The render pipeline is built on Puppeteer + FFmpeg instead.
- **HyperFrames** — rejected by the project owner as an external dependency risk to
  application stability. The provider-adapter interface is designed so it could be
  added later as a plugin without core changes.

## Questions

If you are unsure whether your intended use is permitted, open a GitHub Discussion
before building on it.