# Provider catalogue and settings design

Researched 2026-10-24 against live endpoints and official documentation. This is the
design record for the Settings → Providers surface and the provider list it must offer.

---

## The headline finding: ChatGPT OAuth cannot be added the way it sounds

"Add ChatGPT OAuth" is a reasonable thing to want, and it *does* exist as a product. But
it is **not** a drop-in alternative to pasting an API key, and for Kinema it is currently
**not obtainable at all**.

### What actually exists

OpenAI ships **Sign in with ChatGPT (SIWC)**, which lets a user authorise an app to use
their **ChatGPT plan** (Plus/Pro/Team) instead of paying per-token through an API key. The
mechanics are standard OAuth 2.0 Authorization Code with PKCE plus OpenID Connect, against
`auth.openai.com`.

### Why we cannot ship it

Three hard blockers, each independently disqualifying:

**1. It is gated to selected commercial partners.**

Verbatim from the official documentation:

> Sign in with ChatGPT is currently offered to a select group of commercial partners. To
> join the waitlist, complete the Sign in with ChatGPT interest form.

There is no self-service client registration. We cannot obtain a usable client ID by
building the integration. It requires a business relationship and approval.

**2. It is explicitly restricted to open-source clients and commercial partners.**

The docs describe the path as "Register an **open-source client**", and the client-ID page
confirms the commercial-partner gate. A commercial product like Kinema is not the intended
audience for self-registration.

**3. Even once authorised, it cannot do the things Kinema needs.**

This is the part that matters most, and it is easy to miss. From the preview limitations:

| Limitation | Consequence for Kinema |
|---|---|
| **Image generation is an unsupported tool** | We cannot generate scene images. This alone kills it — image generation is the core of the product. |
| `temperature`, `top_p`, `max_output_tokens` must be omitted | No creative control over generation |
| `previous_response_id` must be omitted over HTTP | No multi-turn character continuity, the mechanism we specifically wanted for consistent recurring characters |
| `store: false` required | No server-side state; full history must be resent every call |
| Files upload API and transcription API unsupported | No user asset upload, no audio transcription |
| Audio/video input unsupported | No reference video, no voice input |
| `moderation` and `safety_identifier` must be omitted | We cannot pass our own safety controls |

So it would give us **text-only chat** with reduced controls, which is roughly the least
valuable part of what we need.

### Decision

**Do not implement ChatGPT OAuth now.** Instead:

1. **Ship the API-key path properly** — it works today, needs no approval, supports image
   generation, and is what every serious tool does.
2. **Architect for OAuth behind the same interface.** The provider adapter already
   separates credentials from transport. Add an `authMode` field
   (`api_key` | `oauth`) so that if OpenAI opens the programme — or we are accepted from
   the waitlist — it is a configuration change rather than a refactor.
3. **Record the waitlist as a business action**, not an engineering task. If the owner
   wants it, submitting the interest form is the correct next step.

This is recorded prominently because the request is completely reasonable and the
disqualifying detail (no image generation) is buried in a limitations page rather than
stated where anyone would look.

---

## Verified provider data

All figures below were obtained live on 2026-10-24. Nothing here is from memory.

### OpenRouter — 469 models, no authentication required

`GET https://openrouter.ai/api/v1/models` returns the full catalogue **without an API
key** (792 KB). This is a genuinely useful property: the model picker can be real data
rather than a hand-maintained list.

Verified structure:

```
id                      e.g. "moonshotai/kimi-k3.1-pro"
context_length          1048576
architecture.input_modalities    ["text", "image", "video"]
architecture.output_modalities   ["text"]
pricing.prompt          "0.000002"   (USD per token, as a string)
pricing.completion      "0.00001"
pricing.input_cache_read "0.0000002"
```

Measured counts across the live catalogue:

| Capability | Models |
|---|---|
| Total | **469** |
| Accept image **input** | **308** |
| Produce image **output** | **12** |

The 308 image-input models are directly relevant: they are candidates for the visual QC
and continuity work, which needs a model that can *look* at two frames and judge whether a
character has drifted.

> **Pricing is per-token and returned as a string.** Parse to a number carefully — a naive
> `parseFloat` on a very small value is fine, but storing these as credits/cents without a
> defined unit will accumulate error. Keep the raw string alongside the parsed value for
> auditability.

### Other providers in the catalogue

| Provider | Auth | Notes |
|---|---|---|
| **OpenAI** | API key | Image generation via `gpt-image-2.5-sunburst` / `-flare`. May require organisation verification. |
| **OpenRouter** | API key | 469 models behind one key. Best single integration for breadth. |
| **Anthropic** | API key | Currently no image generation; text and vision. |
| **Google (Gemini)** | API key | Text, vision, and image generation (Imagen / Nano Banana family). |
| **ElevenLabs** | API key | Speech, voices, effects. The audio direction path. |
| **Ollama** | none (local) | Already installed on this machine with 5 models. Text only. |
| **ComfyUI** | none (local) | HTTP API on `:8188`. Local image generation. Not installed. |
| **LM Studio / llama.cpp / vLLM** | none (local) | Any OpenAI-compatible local server. |
| **Blender** | none (local) | 3D scene build and render. Verified working headlessly — see ADR 0002. |
| **Custom OpenAI-compatible** | key optional | Any base URL. The catch-all. |
| **ChatGPT OAuth** | OAuth | **Gated, and cannot generate images.** See above. |

Deliberately **excluded**: HyperFrames (owner rejected as a dependency risk). Remains
addable later as a plugin since the adapter interface is open.

---

## Settings → Providers: what the screen must do

### Connection list

Each row shows: provider name and logo, connection status
(`unvalidated` / `valid` / `invalid` / `expired`), **key fingerprint (last 4 characters
only — never the key)**, base URL where custom, last validated time, and the models
available through it.

### Adding a connection

1. Choose provider (or "Custom OpenAI-compatible").
2. Enter credentials. For custom endpoints, enter a base URL.
3. **Test connection** — a real call to a cheap endpoint, reporting the precise
   `NormalisedError` on failure (`invalid_credentials`, `insufficient_quota`,
   `rate_limited`, …) rather than a generic failure.
4. **Discover models** — for OpenRouter, fetch the live catalogue; for others, use the
   declared list.
5. Show what this connection actually enables, with honest capability flags.

### Rules the implementation must hold

- **Keys are never returned to the client.** The API returns a masked fingerprint only.
  This is already enforced by `toConnectionSummary` and covered by tests asserting the raw
  key is unreachable in the serialised output.
- **Keys never appear in logs.** Log redaction is a testable requirement, not a
  convention.
- **Keys are encrypted at rest** with AES-256-GCM envelope encryption (`VAULT_MASTER_KEY`).
- **Custom base URLs are an SSRF surface.** Warn on self-hosted URLs, validate TLS, and
  restrict redirects. This is flagged in `SECURITY.md` as not yet fully mitigated.
- **Capability honesty.** A provider that cannot use a reference image must report
  `supportsReferenceImage: false`, so the UI hides the control instead of silently
  dropping the user's intent. This is the rule already enforced by
  `validateRequest` in the mock adapter.

### Other settings to include

- **Defaults**: default text model, default image model, default voice, default local
  endpoint.
- **Spending**: per-project hard cap; warn when a price cannot be estimated reliably
  rather than inventing one.
- **Feature flags**: `FEATURE_LIVE_PROVIDERS`, `FEATURE_LOCAL_WORKER`,
  `FEATURE_AGENT_DIRECTOR` — surfaced so a user can see whether they are on mock adapters.
- **Local services**: detected status for Ollama, ComfyUI, LM Studio and Blender, with a
  one-click re-probe. Blender detection is implemented; the others need the same
  treatment.
- **Telemetry: off, with no in-app switch**, consistent with the decision in ADR 0002.

---

## Verification status

| Claim | How verified |
|---|---|
| OpenRouter returns 469 models unauthenticated | **Live request**, 2026-10-24 |
| 308 image-input / 12 image-output models | **Counted from the live response** |
| Pricing field shapes | **Read from the live response** |
| SIWC is gated to selected partners | **Official docs**, quoted verbatim |
| SIWC cannot do image generation | **Official preview-limitations page** |
| SIWC requires `store: false`, rejects `temperature`/`previous_response_id` | **Official preview-limitations page** |
| Ollama installed with 5 models | **Verified on this machine** |
| Blender 5.1 works headlessly | **Verified by spike**, see ADR 0002 |
| Demo numbers for other providers (Anthropic, Google, ElevenLabs) | **NOT verified live** — listed from general knowledge and must be confirmed against each provider's current docs before implementation |