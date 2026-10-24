# Kinema Studio

**An all-in-one AI creative production studio for independent creators, YouTubers and
animators.** Go from a one-line idea to a finished, editable animated episode or
faceless video — directing AI tools rather than being locked into one ecosystem.

> **Status: early development.** The application does not work end to end yet. This
> README tracks what is real, what is stubbed, and what is not started. There is no
> fake progress here: if a stage is not implemented, it says so.

---

## What Kinema is

A visual production workspace where a creator can:

- **Describe an idea** and have an AI Director plan the production.
- **Build a workflow** on a node canvas, choosing which model does what.
- **Generate a script**, then a **storyboard** of scene cards.
- **Create characters** that stay consistent across episodes.
- **Direct dialogue and performance**, including pacing and emotion.
- **Arrange everything on a multitrack timeline** and **export a video**.
- **Bring any model** — cloud APIs, local inference, or custom OpenAI-compatible
  endpoints — with bring-your-own-key.

The product promise: *make an entire animated episode or faceless video in one
creative workspace, and fix one bad shot instead of starting over.*

## Design direction

Near-black charcoal surfaces, oversized editorial typography, generous negative space,
restrained electric-citron and mint accents, rounded controls, understated motion.
Desktop-first (1440px+), keyboard-operable, WCAG 2.2 AA target.

Design tokens live in [`packages/config`](packages/config). The two reference images
that define the art direction are in [`docs/reference/`](docs/reference).

---

## Implementation status

Honest accounting. Update this table as work lands.

| Area | Status |
|---|---|
| Repository, tooling, TypeScript config | 🟡 In progress |
| Architecture decisions | 🟡 In progress — see [`docs/adr/`](docs/adr) |
| Design tokens and workspace shell | ⬜ Not started |
| Provider adapter system | ⬜ Not started |
| Mock provider adapter | ⬜ Not started |
| OpenAI image adapter | ⬜ Not started |
| Local model adapters (Ollama, ComfyUI) | ⬜ Not started |
| Project + scene data model | ⬜ Not started |
| AI Director | ⬜ Not started |
| Storyboard | ⬜ Not started |
| Scene editor | ⬜ Not started |
| Character studio | ⬜ Not started |
| Audio studio | ⬜ Not started |
| Timeline | ⬜ Not started |
| Render + export | ⬜ Not started |

**Legend:** ⬜ not started · 🟡 in progress · ✅ working and tested

---

## Getting started

Requirements, in order of what actually blocks you:

| Requirement | Why | Notes |
|---|---|---|
| **Node.js ≥ 22** | Everything | Verified working on v24.14.0. |
| **pnpm** | Workspace manager | `corepack enable pnpm` |
| **FFmpeg** | Video export | Not yet required — export is not built. Install before that milestone. |

```bash
git clone https://github.com/zaylaaurora-byte/kinema-studio.git
cd kinema-studio
pnpm install
cp .env.example .env
pnpm dev
```

> **No API keys are required to run Kinema.** With no keys configured the app uses
> Mock adapters and still completes the full workflow. This is deliberate: development
> must never depend on paid calls.

Full setup, troubleshooting and health-check instructions are in
[`docs/LOCAL-ENVIRONMENT.md`](docs/LOCAL-ENVIRONMENT.md), which also records the exact
verified state of the development machine.

---

## Connecting real models

Providers are pluggable. The first real integration is the **OpenAI Image API**
(`gpt-image-2.5-sunburst` / `gpt-image-2.5-flare`) for scene imagery.

> **A note on Codex:** Codex is a *coding agent*, not an image generator. Its
> `--image` flag attaches an input file to a coding prompt; it has no generation
> endpoint. The product specification warns about conflating the two, and this repo
> does not. See [`docs/adr/0001`](docs/adr/0001-image-provider-and-codex.md).

Planned providers, none of which are implemented yet:

| Provider | Kind | Status |
|---|---|---|
| Mock | offline, zero-cost | ⬜ |
| OpenAI Image API | cloud, BYOK | ⬜ |
| OpenAI-compatible (custom base URL) | cloud, BYOK | ⬜ |
| OpenRouter | cloud, BYOK | ⬜ |
| Ollama | local | ⬜ |
| ComfyUI | local | ⬜ |
| ElevenLabs-compatible | cloud, BYOK | ⬜ |

API keys are encrypted at rest and never written to logs. Keys are entered through the
UI, not committed to `.env`.

---

## Architecture

Monorepo, pnpm workspaces:

```
apps/web               Next.js workspace application
apps/marketing         Public site (separate from the production critical path)
apps/api               HTTP API
apps/worker            Durable job execution: generation, rendering
apps/local-companion   Optional desktop worker for local GPU processing
packages/ui            Design system components
packages/types         Shared domain types and schemas
packages/provider-sdk  Provider adapter interface + implementations
packages/scene-model   Scene graph, the single source of truth
packages/workflow-engine  DAG execution, caching, retries
packages/audio         Audio direction, alignment, mixing
packages/render        Frame capture + FFmpeg encoding
packages/agent-tools   Director and specialist agent tools
packages/config        Design tokens and shared config
```

**The key consistency rule:** storyboard, timeline, scene canvas and workflow editor
are all *projections* over versioned project data. None of them may store contradictory
scene order, duration, or approved-asset pointers.

Decisions and their reasoning are recorded as ADRs in [`docs/adr/`](docs/adr).

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Contributions are accepted under
AGPL-3.0-or-later.

## License

[AGPL-3.0-or-later](LICENSE). See [`LICENSING.md`](LICENSING.md) for what that means in
practice, and for why certain dependencies (notably FFmpeg and Remotion) are handled
the way they are.