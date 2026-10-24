# ADR 0001 — Image generation provider, and why Codex is not one

- **Status:** Accepted
- **Date:** 2026-10-24
- **Deciders:** Project owner, implementation agent

## Context

The project owner asked to wire up "Codex image gen" as the first real model to test
the pipeline against. Before building an adapter, the claim needed verifying, because
the product specification warns about it twice:

> "Codex: distinguish Codex as an agent/development workflow from a generic generation
> endpoint. Integrate through officially supported SDK/API/CLI pathways and authorised
> local execution, not an assumed universal Codex API." — spec §10

> "Codex is a coding-agent integration path, not automatically an interchangeable
> video-generation model." — spec v1.1 addendum, architecture gate

## Findings

### Codex is a coding agent and cannot generate images

Verified by inspecting the locally installed CLI (`codex-cli 0.163.0`):

```
-i, --image <FILE>...   Optional image(s) to attach to the initial prompt
```

`--image` is an **input** path — it attaches an existing file to a coding prompt. The
available subcommands are `exec`, `review`, `mcp`, `plugin`, `apply`, `sandbox`,
`resume`, `agents`, `app-server`. There is no image-generation command, and
`@openai/codex` (0.164.0) is distributed as a coding-agent harness, not a model
endpoint.

**Conclusion: there is no "Codex image generation API". The premise is incorrect.**

### The real image generation API

Verified against OpenAI's current documentation:
<https://developers.openai.com/api/docs/guides/image-generation>

| | |
|---|---|
| Models | `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare` |
| Endpoints | `POST /v1/images/generations`, `POST /v1/images/edits` |
| Alternative | Responses API with a built-in `image_generation` tool |
| Sizes | `1024x1024`, `1536x1024`, `1024x1536`; custom `WIDTHxHEIGHT` where both are multiples of 16, aspect ratio 1:3–3:1, max edge 3840 |
| Quality | `low`, `medium`, `high`, `xhigh`, `max`, `auto` |
| Formats | `png` (default), `jpeg`, `webp`; `output_compression` 0–100 |
| Background | `transparent` supported with png/webp |
| Auth | `OPENAI_API_KEY`; may require API Organization Verification |

## Decision

1. **Do not build a Codex adapter.** Codex is out of scope for generation. It may
   reappear later as a *development-workflow* integration (an agent that writes code
   for the user), which is a different feature entirely and is not on the vertical
   slice.

2. **Build an `openai-images` provider adapter** against the Image API, covering both
   `generations` and `edits`. This is the first *real* provider implemented, after the
   Mock adapter.

3. **Prefer the Responses API path for character work.** Its multi-turn editing
   (`previous_response_id` plus `action: "generate" | "edit"`) is the strongest
   available mechanism for keeping a recurring character visually stable, which is a
   core product requirement. The Image API path remains available for single-shot
   generation.

4. **The adapter must expose provider limitations honestly.** OpenAI's own docs state
   the models "may occasionally struggle to maintain visual consistency for recurring
   characters or brand elements across multiple generations" and that complex prompts
   can take up to two minutes. Both belong in the capability descriptor so the UI can
   warn before spending, rather than surprising the user afterwards.

5. **Moderation is a first-class failure mode.** `error.type =
   "image_generation_user_error"` with `error.code = "moderation_blocked"` is
   user-correctable and must **not** be auto-retried. It carries
   `moderation_details.{moderation_stage, categories}` for developer logs, but the
   end-user message should stay generic.

## Consequences

- The provider interface must model both a synchronous single-shot call and a
  long-running conversational edit, since the two APIs differ in shape.
- Latency of up to two minutes means image generation must run through the durable job
  queue, never inline in a request handler. This confirms the queue is needed in the
  very first slice.
- Because output is returned as base64 rather than a URL, the adapter must normalise
  results into stored assets immediately — which is another argument for building the
  asset store early.
- Prompt-moderation blocks are a routine, expected outcome. The scene editor needs a
  clear "this prompt was rejected, edit and retry" state, not a generic error toast.

## Verification status

- Codex CLI behaviour: **verified directly** on this machine.
- Image API details: **verified** against current official documentation, 2026-10-24.
- Exact pricing per image: **not verified** — pricing changes and was explicitly
  deprioritised by the owner. Must be confirmed before any cost-estimation feature
  claims accuracy.