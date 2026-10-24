import Link from "next/link";
import * as React from "react";

import { buttonVariants } from "@/components/ui/button-variants";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/cn";
import { typography } from "@/lib/tokens";

/**
 * Landing route.
 *
 * Deliberately short. It is not a marketing page - it is the one screen that says
 * what the app is, what genuinely works today, and where to go. The "What works"
 * list is the honest status table CONTRIBUTING.md requires for unfinished
 * features, rendered instead of buried in the README.
 */
export default function HomePage() {
  const working = [
    "Four-region workspace layout with drag- and keyboard-resizable panes",
    "Pane sizes and workspace mode persist across reloads",
    "Keyboard-operable tabs, project tree, canvas zoom and timeline playhead",
    "Design tokens consumed directly from @kinema/config",
  ];

  const notWorking = [
    { label: "Project store", reason: "No database or project file is read yet." },
    { label: "AI Director", reason: "No model endpoint is connected." },
    { label: "Render and Export", reason: "FFmpeg is not installed on this machine." },
    { label: "Media playback", reason: "No scene exists to play back." },
  ];

  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-label text-text-tertiary">
        Kinema Studio
      </p>

      {/*
       * The one oversized editorial moment on this screen. `typography.size.display`
       * is used sparingly per the token module - here, and nowhere in the workspace,
       * where it would consume the timeline's vertical space.
       */}
      <h1
        className="mt-3 font-display font-semibold text-text"
        style={{
          fontSize: typography.size.display,
          letterSpacing: typography.tracking.display,
          lineHeight: typography.leading.tight,
        }}
      >
        Cut, direct and
        <br />
        render with AI.
      </h1>

      <p className="mt-5 max-w-xl text-md leading-relaxed text-text-secondary">
        A production studio for independent creators. This build ships the
        workspace shell: the surface, the panes and the interaction model. The
        generation pipeline behind it is not wired up, and nothing on this page
        pretends otherwise.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link href="/workspace" className={cn(buttonVariants({ variant: "primary", size: "lg" }))}>
          Open the workspace
        </Link>
        <StatusBadge tone="warning" label="Pipeline not connected" />
      </div>

      <div className="mt-12 grid gap-8 border-t border-border pt-8 md:grid-cols-2">
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-label text-text-secondary">
            Working today
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {working.map((item) => (
              <li key={item} className="flex gap-2 text-base leading-relaxed text-text-secondary">
                <span aria-hidden="true" className="mt-2 size-1 flex-none rounded-full bg-mint" />
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="text-xs font-semibold uppercase tracking-label text-text-secondary">
            Not implemented
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {notWorking.map((item) => (
              <li
                key={item.label}
                className="flex flex-col gap-0.5 border-b border-border pb-2 last:border-b-0"
              >
                <span className="text-base font-medium text-text-tertiary line-through decoration-danger/60">
                  {item.label}
                </span>
                <span className="text-sm text-text-tertiary">{item.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}