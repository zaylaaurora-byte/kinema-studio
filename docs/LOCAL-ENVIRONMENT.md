# Local environment — verified facts

Recorded 2026-10-24 by direct inspection of the development machine. Update this file
when the environment changes; do not rely on memory.

## Machine

| | |
|---|---|
| OS | Windows |
| CPU | Intel Core i7-4790 @ 3.60GHz — 4 cores / 8 threads (Haswell, 2014) |
| RAM | 15.9 GB |
| GPU | NVIDIA GeForce RTX 2060, **6 GB VRAM** (+ Intel HD Graphics 4600 integrated) |
| Disk | `X:` "Spare" — 256 GB total, **~45 GB free** (project lives here) |

**Implication:** the RTX 2060's 6 GB VRAM is the hard ceiling for local AI. It is
comfortable for 7–9B language models at 4-bit quantisation, and adequate for
Stable Diffusion 1.5 / SDXL-Turbo image work. It is **not** sufficient for large
video models. Local video generation should not be a design assumption.

`X:` has the least free space of the three drives and is closest to full. Generated
media accumulates fast (a single 1080p PNG frame sequence is ~1–3 MB/frame, so a 60s
30fps render is 2–5 GB of intermediates). Intermediate frames belong in a temp
directory that is cleaned after every render, and the storage root should be
reconsiderable if the project grows.

## Verified toolchain

| Tool | Status | Notes |
|---|---|---|
| Node.js | ✅ v24.14.0 | Meets the `>=22` requirement. |
| git | ✅ 2.53.0.windows.1 | |
| GitHub CLI | ✅ 2.102.0 | Authenticated as `zaylaaurora-byte` (scopes: `repo`, `workflow`, `gist`, `read:org`). |
| Google Chrome | ✅ `C:\Program Files\Google\Chrome\Application\chrome.exe` | Used for frame capture. |
| winget | ✅ available | Use for installing FFmpeg and other prerequisites. |
| **Ollama** | ✅ installed, **not currently running** | `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` |
| **Docker** | ❌ **NOT INSTALLED** | See below — this is decisive. |
| **FFmpeg** | ❌ not found | Must be installed before export can work. |
| ComfyUI | ❌ not installed | Optional image-generation backend. |
| LM Studio / llama.cpp / vLLM | ❌ not installed | Optional. |

## Ollama models already available locally

These were found in `~\.ollama\models\manifests` and can be used immediately at zero cost:

| Model | Size class | Good for |
|---|---|---|
| `qwen3.5:9b` | 9B | Best available general reasoning; the default Director/script model. |
| `deepseek-r1:8b` | 8B | Reasoning-heavy planning and structured extraction. |
| `gemma3:4b` | 4B | Fast draft scripts, cheap iteration. |
| `qwen3.5:2b` | 2B | Very fast, low-VRAM tasks (classification, tagging, short rewrites). |
| `unrestricted-llama-3-1:Q4_K_M` | 8B | Uncensored third-party build; **not** a default — see note. |

> **Note on the third-party model.** `hf.co/hamaza7867/unrestricted-llama-3-1` is an
> unofficial, uncensored community fine-tune. It is not an official Meta release and
> carries no safety tuning. It must not be wired in as an app default, and any output
> from it should not be presented as proceeding from a vetted model. Kinema's content
> safety expectations should assume the user selects models deliberately.

## Decisions forced by these facts

### 1. Docker Compose cannot be required

Docker is not installed. A "just run `docker compose up`" quickstart would fail on this
machine immediately. Therefore:

- **The default local setup is native**: Node + pnpm + a local SQLite file + the
  filesystem for media + a database-backed job queue. No container runtime needed.
- Docker Compose is provided as an **optional** convenience profile for people who
  prefer PostgreSQL/Redis/MinIO, not as the primary path.
- This also removes Redis from the critical path (see the queue decision in the ADR).

### 2. SQLite is the default database

With no Docker and no native PostgreSQL, SQLite is the only zero-install option. The
schema must therefore stay portable: avoid SQLite-only constructs, use a migration tool
that targets both SQLite and PostgreSQL, and treat PostgreSQL as a later swap. Details
and the migration path are in the database ADR.

### 3. Ollama is the zero-cost backbone

Because five models are already present, the entire text side of the vertical slice —
brief → script → scene breakdown → Director planning — can run for free, offline,
today. This is the fastest route to a genuinely working end-to-end flow and it should
be the first provider adapter implemented after the Mock adapter.

### 4. Image and video generation need a real decision

Ollama is text-only. There is no local image generator installed, and 6 GB VRAM limits
what is practical. The options are: (a) a cloud image provider via BYOK, (b) ComfyUI
installed locally with SD1.5/SDXL-Turbo, or (c) a placeholder renderer for the first
slice. The vertical slice must not be blocked on this — see the slice plan.

### 5. FFmpeg must be installed before export works

`winget install Gyan.FFmpeg` is the quickest route, **but** Gyan's builds are GPLv3
(they bundle libx264). For local personal use that is fine and the reference commands
will work. For any future distribution, an LGPL build is required — see
[`LICENSING.md`](LICENSING.md). This distinction is recorded so it is not discovered
late.

## Reproducing this check

The facts above were gathered with read-only commands: `Get-Command`, `npm view`,
`Get-CimInstance Win32_VideoController`, and HTTP probes against the local provider
ports (`11434`, `8188`, `1234`). Re-run those probes rather than trusting this file if
something appears to be broken.