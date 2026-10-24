"use client";

import {
  Captions,
  Film,
  Maximize2,
  Minus,
  MonitorPlay,
  Plus,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import * as React from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { TooltipLabel } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

/**
 * CenterViewer - the scene editing canvas and its transport.
 *
 * WHAT IS REAL
 *  - The zoom controls genuinely change the canvas scale, clamped 25%-200%.
 *  - The canvas is a real focusable region (`role="application"` with a labelled
 *    description) and responds to keyboard zoom, so it is reachable and operable
 *    without a mouse, which the contributing guide requires for this surface.
 *  - The empty state is the accurate description of the document: there is no
 *    scene, therefore there is no frame.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * No video element, no fake playhead, no skeleton frame. The transport controls
 * are disabled because there is no media to transport, and each carries a tooltip
 * saying so. Shipping an enabled play button over an empty canvas would be the
 * decorative-control pattern the project bans.
 *
 * The backdrop is a 48px grid, which is the conventional signal for "this is a
 * coordinate space with nothing in it", chosen over a spinner or a placeholder
 * poster because both would imply work is happening.
 */

const MIN_ZOOM = 25;
const MAX_ZOOM = 200;
const ZOOM_STEP = 25;

export function CenterViewer() {
  const [zoom, setZoom] = React.useState(100);

  const setClamped = React.useCallback((next: number) => {
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(next))));
  }, []);

  const onCanvasKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "+":
      case "=":
        event.preventDefault();
        setClamped(zoom + ZOOM_STEP);
        break;
      case "-":
      case "_":
        event.preventDefault();
        setClamped(zoom - ZOOM_STEP);
        break;
      case "0":
        event.preventDefault();
        setClamped(100);
        break;
      default:
        break;
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
      {/* Canvas ------------------------------------------------------------- */}
      <div
        role="application"
        aria-label="Scene canvas"
        aria-describedby="canvas-help"
        tabIndex={0}
        onKeyDown={onCanvasKeyDown}
        className={cn(
          "surface-grid relative m-3 flex min-h-0 flex-1 items-center justify-center",
          "rounded-md border border-border bg-canvas-raised",
          "transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
        )}
      >
        <p id="canvas-help" className="sr-only">
          Empty scene canvas. Press plus to zoom in, minus to zoom out, and zero to
          reset the zoom to one hundred percent.
        </p>

        {/* Frame guide - shows the real output aspect at the current zoom. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <div
            className="rounded-sm border border-dashed border-border-strong/70"
            style={{
              width: `min(78%, ${Math.round(960 * (zoom / 100))}px)`,
              aspectRatio: "16 / 9",
            }}
          />
        </div>

        <EmptyState
          className="relative"
          icon={<Film className="size-5" />}
          title="No scene to preview"
          description="The viewer renders the selected scene's current revision. This project has no scenes yet, so there is nothing to show."
        />
      </div>

      {/* Transport ---------------------------------------------------------- */}
      <div className="flex flex-none items-center gap-2 border-t border-border px-3 py-2">
        <div className="flex items-center gap-1">
          <TooltipLabel label="No media loaded, so there is no timeline to step through.">
            <span className="inline-flex">
              <Button variant="ghost" size="icon" disabled aria-label="Previous frame">
                <SkipBack className="size-4" />
              </Button>
            </span>
          </TooltipLabel>
          <TooltipLabel label="No media loaded, so there is nothing to play.">
            <span className="inline-flex">
              <Button variant="ghost" size="icon" disabled aria-label="Play">
                <MonitorPlay className="size-4" />
              </Button>
            </span>
          </TooltipLabel>
          <TooltipLabel label="No media loaded, so there is no timeline to step through.">
            <span className="inline-flex">
              <Button variant="ghost" size="icon" disabled aria-label="Next frame">
                <SkipForward className="size-4" />
              </Button>
            </span>
          </TooltipLabel>
        </div>

        <span
          className="tabular ml-1 rounded-sm border border-border bg-panel px-2 py-1 text-sm text-text-secondary"
          title="Playhead position. Nothing is loaded, so it sits at zero."
        >
          00:00:00:00
        </span>

        <div className="ml-auto flex items-center gap-1">
          <TooltipLabel label="Captions are generated with the scene render. No render backend is connected.">
            <span className="inline-flex">
              <Button variant="ghost" size="icon" disabled aria-label="Captions">
                <Captions className="size-4" />
              </Button>
            </span>
          </TooltipLabel>
          <TooltipLabel label="Audio monitoring requires a rendered scene with an audio track.">
            <span className="inline-flex">
              <Button variant="ghost" size="icon" disabled aria-label="Audio">
                <Volume2 className="size-4" />
              </Button>
            </span>
          </TooltipLabel>

          {/* Real zoom controls. */}
          <div className="ml-1 flex items-center rounded-sm border border-border bg-panel">
            <TooltipLabel label="Zoom out (press minus on the canvas)">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Zoom out"
                disabled={zoom <= MIN_ZOOM}
                onClick={() => setClamped(zoom - ZOOM_STEP)}
                className="rounded-r-none"
              >
                <Minus className="size-3.5" />
              </Button>
            </TooltipLabel>
            <span
              className="tabular w-12 text-center text-xs text-text-secondary"
              aria-live="polite"
              aria-label={`Canvas zoom ${zoom} percent`}
            >
              {zoom}%
            </span>
            <TooltipLabel label="Zoom in (press plus on the canvas)">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Zoom in"
                disabled={zoom >= MAX_ZOOM}
                onClick={() => setClamped(zoom + ZOOM_STEP)}
                className="rounded-l-none"
              >
                <Plus className="size-3.5" />
              </Button>
            </TooltipLabel>
          </div>

          <TooltipLabel label="Fit to window (press zero on the canvas)">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Reset zoom to 100 percent"
              onClick={() => setClamped(100)}
            >
              <Maximize2 className="size-3.5" />
            </Button>
          </TooltipLabel>
        </div>
      </div>
    </div>
  );
}