"use client";

import {
  AudioLines,
  Captions,
  Film,
  Layers,
  Magnet,
  Music,
  Scissors,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PanelHeader } from "@/components/ui/panel";
import { TooltipLabel } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

/**
 * Timeline - the multitrack strip along the bottom.
 *
 * WHAT IS REAL
 *  - The track headers are real focusable elements in a `role="list"`; the whole
 *    strip is reachable by Tab and operable by Enter/Space.
 *  - The playhead is a genuine position in seconds, moved by the arrow keys on
 *    the ruler (Home/End jump to the ends). It is NOT an animated fake: it only
 *    moves when the user moves it, and it is reported to assistive tech as a
 *    slider with a real value.
 *  - The horizontal zoom genuinely changes the pixel-per-second scale, which
 *    really changes the width of the ruler.
 *  - The audio and captions tracks are present because the project model defines
 *    them; they are empty because nothing has been rendered.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * No clips, no waveforms, no animated "rendering" shimmer. Empty tracks are drawn
 * as empty lanes with a dashed baseline, which is the truthful depiction of a
 * project with no media.
 *
 * The ruler is a slider, not a plain region: `role="slider"` is what gives
 * arrow-key operation and an announced value for free, and it is exactly the
 * semantics a playhead should carry.
 */

const MIN_PPS = 8;
const MAX_PPS = 240;

export type TrackKind = "video" | "audio" | "captions";

interface TrackDefinition {
  readonly id: string;
  readonly name: string;
  readonly kind: TrackKind;
  readonly icon: React.ReactNode;
}

const TRACKS: readonly TrackDefinition[] = [
  { id: "v1", name: "Video 1", kind: "video", icon: <Film className="size-3.5" /> },
  { id: "a1", name: "Audio 1", kind: "audio", icon: <Music className="size-3.5" /> },
  {
    id: "c1",
    name: "Captions",
    kind: "captions",
    icon: <Captions className="size-3.5" />,
  },
];

/** Ruler spans 60 seconds. Nothing longer exists, and nothing shorter is defined. */
const DURATION_SECONDS = 60;

function formatTimecode(seconds: number): string {
  const whole = Math.floor(seconds);
  const mm = String(Math.floor(whole / 60)).padStart(2, "0");
  const ss = String(whole % 60).padStart(2, "0");
  const ff = String(Math.floor((seconds - whole) * 30)).padStart(2, "0");
  return `00:${mm}:${ss}:${ff}`;
}

export function Timeline() {
  const [pps, setPps] = React.useState(32);
  const [playhead, setPlayhead] = React.useState(0);
  const [focusedTrack, setFocusedTrack] = React.useState<string | null>(null);

  const setClampedPps = (next: number) =>
    setPps(Math.min(MAX_PPS, Math.max(MIN_PPS, Math.round(next))));

  const contentWidth = DURATION_SECONDS * pps;
  /** One tick per second; labels every 5s unless the zoom is too tight for them. */
  const ticks = React.useMemo(
    () => Array.from({ length: DURATION_SECONDS + 1 }, (_, index) => index),
    [],
  );
  const labelEvery = pps >= 24 ? 5 : 10;

  const onRulerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 5 : 1;
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        setPlayhead((t) => Math.min(DURATION_SECONDS, t + step));
        break;
      case "ArrowLeft":
        event.preventDefault();
        setPlayhead((t) => Math.max(0, t - step));
        break;
      case "Home":
        event.preventDefault();
        setPlayhead(0);
        break;
      case "End":
        event.preventDefault();
        setPlayhead(DURATION_SECONDS);
        break;
      default:
        break;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas-raised">
      {/* Toolbar ------------------------------------------------------------ */}
      <div className="flex h-9 flex-none items-center gap-2 border-b border-border px-3">
        <h2 className="text-xs font-semibold uppercase tracking-label text-text-secondary">
          Timeline
        </h2>

        <span className="tabular ml-2 text-sm text-text-tertiary">
          {formatTimecode(playhead)}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <TooltipLabel label="Snapping applies to clip edges. There are no clips to snap.">
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="icon"
                disabled
                aria-label="Toggle snapping"
              >
                <Magnet className="size-3.5" />
              </Button>
            </span>
          </TooltipLabel>
          <TooltipLabel label="Trimming requires a clip on the timeline. The timeline is empty.">
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="icon"
                disabled
                aria-label="Trim clip at playhead"
              >
                <Scissors className="size-3.5" />
              </Button>
            </span>
          </TooltipLabel>

          <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

          {/* Real zoom controls. */}
          <TooltipLabel label="Zoom out of the timeline">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Zoom timeline out"
              disabled={pps <= MIN_PPS}
              onClick={() => setClampedPps(pps / 1.5)}
            >
              <ZoomOut className="size-3.5" />
            </Button>
          </TooltipLabel>
          <span className="tabular w-16 text-center text-xs text-text-tertiary">
            {pps} px/s
          </span>
          <TooltipLabel label="Zoom into the timeline">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Zoom timeline in"
              disabled={pps >= MAX_PPS}
              onClick={() => setClampedPps(pps * 1.5)}
            >
              <ZoomIn className="size-3.5" />
            </Button>
          </TooltipLabel>
        </div>
      </div>

      {/* Track headers + lanes ---------------------------------------------- */}
      <div className="flex min-h-0 flex-1">
        {/* Headers */}
        <div className="flex w-44 flex-none flex-col border-r border-border">
          <div className="h-6 flex-none border-b border-border" aria-hidden="true" />
          <ul
            role="list"
            aria-label="Timeline tracks"
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            {TRACKS.map((track) => {
              const isFocused = focusedTrack === track.id;
              return (
                <li key={track.id} className="flex-none">
                  <div
                    role="button"
                    tabIndex={isFocused || focusedTrack === null ? 0 : -1}
                    aria-pressed={isFocused}
                    aria-label={`${track.name}, empty track`}
                    onFocus={() => setFocusedTrack(track.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setFocusedTrack(track.id);
                      }
                    }}
                    className={cn(
                      "flex h-12 w-full items-center gap-2 border-b border-border px-3 text-left",
                      "transition-colors duration-150 ease-[var(--ease-standard)]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
                      isFocused
                        ? "bg-panel-elevated text-text"
                        : "text-text-secondary hover:bg-panel",
                    )}
                  >
                    <span aria-hidden="true" className="text-text-tertiary">
                      {track.icon}
                    </span>
                    <span className="truncate text-sm font-medium">{track.name}</span>
                    <span className="tabular ml-auto text-xs text-text-tertiary">
                      0
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Lanes */}
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <div style={{ width: contentWidth, minWidth: "100%" }}>
            {/* Ruler: a real slider. */}
            <div
              role="slider"
              aria-label="Timeline playhead"
              aria-valuemin={0}
              aria-valuemax={DURATION_SECONDS}
              aria-valuenow={playhead}
              aria-valuetext={`${formatTimecode(playhead)}, ${playhead} seconds`}
              aria-orientation="horizontal"
              tabIndex={0}
              onKeyDown={onRulerKeyDown}
              className={cn(
                "relative h-6 flex-none border-b border-border bg-canvas",
                "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
              )}
            >
              {ticks.map((second) => {
                const isLabelled = second % labelEvery === 0;
                return (
                  <span
                    key={second}
                    aria-hidden="true"
                    className="absolute bottom-0 top-0 flex flex-col justify-end"
                    style={{ left: second * pps }}
                  >
                    <span
                      className={cn(
                        "block w-px",
                        isLabelled ? "h-2.5 bg-border-strong" : "h-1.5 bg-border",
                      )}
                    />
                    {isLabelled ? (
                      <span className="tabular absolute -top-0.5 left-1 text-[10px] text-text-tertiary">
                        {second}s
                      </span>
                    ) : null}
                  </span>
                );
              })}
            </div>

            {/* Lanes - drawn empty because they are empty. */}
            <div className="relative">
              {TRACKS.map((track) => (
                <div
                  key={track.id}
                  className="relative h-12 border-b border-border"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(to right, rgba(37,42,46,0.5) 0 1px, transparent 1px 32px)",
                  }}
                >
                  <div className="pointer-events-none absolute inset-x-2 top-1/2 -translate-y-1/2 border-t border-dashed border-border-strong/50" />
                </div>
              ))}

              {/* Playhead: positioned from real state only. */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 z-10 w-px bg-accent"
                style={{ left: playhead * pps }}
              >
                <span className="absolute -left-[3px] -top-px size-[7px] rounded-b-sm bg-accent" />
              </div>
            </div>
          </div>

          <EmptyState
            compact
            icon={<Layers className="size-4" />}
            title="No clips on the timeline"
            description="Clips appear here when a scene has rendered revision. Nothing has been generated, so every track is empty. Move the playhead with the arrow keys."
          />
        </div>
      </div>

      {/* Footer summary ------------------------------------------------------ */}
      <div className="flex flex-none items-center gap-3 border-t border-border px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs text-text-tertiary">
          <AudioLines aria-hidden="true" className="size-3" />
          No audio analysed
        </span>
        <span className="text-xs text-text-tertiary">
          {TRACKS.length} tracks · 0 clips
        </span>
        <TooltipLabel
          side="top"
          label="Adding a track requires a project store. This build reads no project file."
        >
          <span className="ml-auto inline-flex">
            <Button variant="ghost" size="sm" disabled className="h-6 text-xs">
              Add track
            </Button>
          </span>
        </TooltipLabel>
      </div>
    </div>
  );
}