# Contributing to Kinema Studio

Thanks for wanting to help. This guide is short on ceremony and long on the two things
that actually matter here: **do not break the app, and do not fake functionality.**

## The one rule

**Everything you ship must genuinely work.**

This project has an explicit prohibition on the things that make AI-generated software
useless:

- ❌ Decorative buttons that do nothing.
- ❌ Fake progress bars or animations that simulate work.
- ❌ Hardcoded demo results presented as real output.
- ❌ "Coming soon" pages masquerading as features.
- ❌ Screens wired to endpoints that do not exist.

If something is unfinished, mark it in the README status table and leave a `TODO` with
a linked issue. An honest stub is fine. A convincing fake is not.

## Getting set up

```bash
git clone https://github.com/zaylaaurora-byte/kinema-studio.git
cd kinema-studio
pnpm install
cp .env.example .env
pnpm dev
```

No API keys are needed. See [`docs/LOCAL-ENVIRONMENT.md`](docs/LOCAL-ENVIRONMENT.md).

## Before you open a pull request

```bash
pnpm typecheck    # must pass
pnpm lint         # must pass
pnpm test         # must pass
pnpm build        # must pass
```

A pull request that fails any of these will not be reviewed. Fix it first.

## What we look for

**Test the behaviour, not the implementation.** A test that asserts a component
renders is nearly worthless. A test that asserts *reordering a storyboard card changes
the timeline and the export in the same way* is valuable. The spec's own test matrix
in §14 is the standard.

**Every feature needs its failure states.** Not just the happy path:

- **Loading** — what does the user see while a 2-minute image generation runs?
- **Empty** — what does a project with no scenes look like?
- **Error** — what happens when a provider rejects the request, times out, or blocks a
  prompt for moderation?
- **Cancellation** — can a queued job actually be stopped?
- **Cost** — is the user warned before spending, and is there a hard cap?

**Keyboard and screen-reader access is not optional.** The canvas and timeline must be
keyboard-operable with visible focus rings. This is a WCAG 2.2 AA target project.

## Code conventions

- **TypeScript strict.** `any` requires a comment explaining why.
- **No new runtime dependency without an ADR.** Especially anything touching
  rendering, video, or state. Several obvious choices were rejected for licensing or
  stability reasons — read [`LICENSING.md`](LICENSING.md) and
  [`docs/adr/`](docs/adr) before adding a package. In particular: **do not add
  `ffmpeg-static`** (GPL-3.0, would relicense the combined work) or **Remotion** (not
  open source).
- **Types are shared, not duplicated.** If the API and the frontend both need a shape,
  it belongs in `packages/types`.
- **Never commit a secret.** Keys go in `.env` (gitignored) or through the UI. If you
  think you have committed one, rotate it immediately — do not just delete the commit.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(storyboard): reorder cards updates the linked timeline
fix(providers): stop leaking the API key into debug logs
docs(adr): record the local-first database decision
```

## Architecture decisions

If your change affects the shape of the system — a new dependency, a data model change,
a different rendering approach — write an ADR in `docs/adr/` using the existing
template. The reasoning is as valuable as the decision; future contributors need to
know *why*, especially where the obvious choice was rejected.

## Licensing and the CLA

Contributions are accepted under **AGPL-3.0-or-later**.

By submitting a pull request you agree to a lightweight Contributor License Agreement:
you grant the project the right to use your contribution, including in separately
licensed commercial editions of Kinema Studio. You retain copyright to your work. This
is what keeps the project sustainable — it is the same model used by Grafana,
Mattermost and Nextcloud.

If that is not acceptable to you, please still open an issue with your idea; a
maintainer may implement it independently.

## Reporting bugs

Include: what you did, what you expected, what happened, and the relevant log lines.
**Redact API keys and tokens.** For anything security-related, follow
[`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## Code of conduct

Be straightforward, be kind, assume good faith. Technical criticism is welcome and
expected; personal criticism is not.