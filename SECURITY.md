# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or contact the maintainer through their GitHub profile.

Please include what you did, what you expected, and what happened. A proof of concept
helps enormously. We aim to acknowledge within 72 hours.

## Scope

Kinema Studio stores users' creative work and, critically, **their AI provider API
keys**. The following are in scope and taken seriously:

- Credential leakage (keys exposed in logs, API responses, client bundles, error
  messages, or crash reports).
- Cross-workspace data access — one user reading another's projects or assets.
- Server-side request forgery through user-supplied provider base URLs.
- Arbitrary code execution, especially via the render pipeline, uploaded files, or
  workflow definitions.
- Path traversal in the asset store or the render frame directory.
- Payment or entitlement bypass.

## Security model, and its known weak points

Being honest about the design's risks is more useful than a vague promise.

### Provider credentials

Keys are encrypted at rest with AES-256-GCM envelope encryption and are **never**
returned to the client after storage — the API returns a masked fingerprint only. They
must never appear in logs; log redaction is a testable requirement, not a convention.

### Custom provider endpoints are an SSRF surface

Users may point Kinema at their own OpenAI-compatible endpoint. That means the server
makes outbound requests to a user-supplied URL, which is a classic SSRF vector.
Mitigations required: an allowlist/denylist for private address ranges, redirect
limits, TLS validation, timeouts, and an explicit warning when a user enters a
self-hosted URL. **This is not fully mitigated yet.**

### The render pipeline executes untrusted content

Rendering runs user-authored HTML/CSS/JS in a headless browser. This is the highest-risk
component in the system.

- The browser **must not** run with `--no-sandbox` in any shared or production context.
- Renders must be isolated per job, with no network access and a memory/CPU cap.
- A render must never be able to read the host filesystem or reach the API server.
- **Status: not implemented.** Until it is, treat the renderer as unsafe for
  untrusted input and do not expose it to other users.

### Remote local workers

Local processing nodes connect *outbound* with short-lived tokens. Their inference
ports must never be exposed to the public internet, and the cloud orchestrator must
send them only the assets a task is authorised to use.

### Content safety and consent

Voice cloning requires documented rights and consent, with provenance recorded and a
working deletion path. Impersonation is prohibited. Uploaded media may carry
third-party rights; the provenance of every asset is tracked for this reason.

## Supported versions

Pre-1.0: only the `main` branch is supported. Once released, the latest minor receives
security fixes.

## A note on dependencies

Dependency choices with licensing or security implications are recorded as ADRs. Two
matter for security specifically:

- **FFmpeg** is invoked via `child_process.spawn` with an explicit argument array —
  never a shell string — to eliminate command injection through filenames or user
  parameters.
- **`fluent-ffmpeg`** is avoided (dormant since 2024, and it adds a shell surface).