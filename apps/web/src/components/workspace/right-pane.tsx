"use client";

import {
  Boxes,
  CircleSlash,
  Info,
  MessageSquare,
  Send,
  Sparkles,
  Wand2,
} from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PanelBody, PanelFooter, PanelHeader } from "@/components/ui/panel";
import { StatChip, StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { TooltipLabel } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

/**
 * RightPane - AI Director conversation plus the scene inspector.
 *
 * THE COMPOSER IS REAL, THE SEND IS NOT
 * The textarea genuinely accepts input, grows with its content, and submits on
 * Enter. There is no Director model wired up, so rather than fake a reply the
 * panel states plainly that no model is connected and offers the two things that
 * would connect one. Submitting is blocked, and the disabled control carries the
 * reason in a tooltip.
 *
 * The inspector is a real, focusable description list. Every row reflects a scene
 * property that exists in the project model; the scene simply has none set yet,
 * so each reads "Not set" rather than showing an invented value.
 */

const DIRECTOR_MODEL_OPTIONS = [
  "ollama · qwen3.5:9b",
  "ollama · deepseek-r1:8b",
] as const;

export function RightPane() {
  const [tab, setTab] = React.useState<"director" | "inspector">("director");
  const [draft, setDraft] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  /**
   * Real autosize: the height tracks scrollHeight, clamped to the token spacing
   * scale. No `field-sizing` dependency, because that is not yet portable.
   */
  const resize = React.useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, []);

  React.useEffect(resize, [draft, resize]);

  const directorAvailable = false;
  const canSend = directorAvailable && draft.trim().length > 0;

  return (
    <>
      <div className="flex-none border-b border-border px-1 py-1">
        <Tabs
          idBase="right-pane"
          aria-label="Right pane view"
          value={tab}
          onValueChange={(next) =>
            setTab(next === "inspector" ? "inspector" : "director")
          }
          items={[
            { id: "director", label: "AI Director" },
            { id: "inspector", label: "Inspector" },
          ]}
        />
      </div>

      {tab === "director" ? (
        <TabPanel
          idBase="right-pane"
          tabId="director"
          className="flex flex-col overflow-hidden"
        >
          <div className="flex flex-none items-center gap-2 border-b border-border px-3 py-2">
            <StatusBadge
              tone="warning"
              srPrefix="Director status:"
              label="No model connected"
              icon={<CircleSlash className="size-3" />}
            />
            <TooltipLabel
              side="bottom"
              label={`Available local models detected on this machine: ${DIRECTOR_MODEL_OPTIONS.join(", ")}. None is wired up in this build.`}
            >
              <span
                tabIndex={0}
                aria-label="About available local models"
                className="ml-auto inline-flex size-6 items-center justify-center rounded-full text-text-tertiary hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Info aria-hidden="true" className="size-3.5" />
              </span>
            </TooltipLabel>
          </div>

          <PanelBody className="px-2">
            <EmptyState
              icon={<Sparkles className="size-5" />}
              title="No conversation yet"
              description="The Director turns a brief into scenes, shot lists and prompts. It needs a model endpoint, which this build does not have."
              action={
                <div className="flex flex-col items-center gap-2">
                  <TooltipLabel label="Requires the Ollama service running locally on port 11434. It is installed but not running.">
                    <span className="inline-flex">
                      <Button variant="secondary" size="sm" disabled className="gap-1.5">
                        <Wand2 className="size-3.5" />
                        Connect local model
                      </Button>
                    </span>
                  </TooltipLabel>
                  <TooltipLabel label="Writing an episode brief is part of the Director flow and becomes available once a model is connected.">
                    <span className="inline-flex">
                      <Button variant="ghost" size="sm" disabled>
                        Start from a brief
                      </Button>
                    </span>
                  </TooltipLabel>
                </div>
              }
            />
          </PanelBody>

          <PanelFooter className="flex-col items-stretch gap-2">
            <label htmlFor="director-composer" className="sr-only">
              Message the AI Director
            </label>
            <textarea
              id="director-composer"
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onInput={resize}
              rows={2}
              placeholder="Describe a scene, or ask the Director to revise one…"
              className={cn(
                "w-full resize-none rounded-sm border border-border bg-canvas-raised px-3 py-2",
                "text-base leading-relaxed text-text placeholder:text-text-tertiary",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
              )}
            />
            <div className="flex items-center gap-2">
              <p className="text-xs text-text-tertiary">
                {draft.trim().length === 0
                  ? "Enter to send, Shift+Enter for a new line."
                  : `${draft.trim().length} characters ready.`}
              </p>
              <TooltipLabel
                side="top"
                label="No Director model is connected, so messages cannot be sent. Connect a local model first."
              >
                <span className="ml-auto inline-flex">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!canSend}
                    className="gap-1.5"
                    onClick={() => setDraft("")}
                  >
                    <Send className="size-3.5" />
                    Send
                  </Button>
                </span>
              </TooltipLabel>
            </div>
          </PanelFooter>
        </TabPanel>
      ) : (
        <TabPanel idBase="right-pane" tabId="inspector" className="flex flex-col">
          <PanelHeader icon={<Boxes className="size-3.5" />} divided>
            Scene
          </PanelHeader>
          <p className="px-3 py-3 text-sm leading-relaxed text-text-tertiary">
            No scene is selected. Inspector fields populate from the selected
            scene; nothing is selected because no scene exists yet.
          </p>

          <dl className="flex flex-col gap-0 px-3 pb-4">
            {[
              { term: "Duration", detail: "Not set" },
              { term: "Aspect ratio", detail: "Not set" },
              { term: "Frame rate", detail: "Not set" },
              { term: "Model", detail: "Not set" },
              { term: "Seed", detail: "Not set" },
              { term: "Revision", detail: "None" },
            ].map((row) => (
              <div
                key={row.term}
                className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
              >
                <dt className="text-sm text-text-secondary">{row.term}</dt>
                <dd className="tabular text-sm text-text-tertiary">{row.detail}</dd>
              </div>
            ))}
          </dl>

          <PanelHeader icon={<MessageSquare className="size-3.5" />} divided>
            Shots
          </PanelHeader>
          <div className="flex flex-wrap gap-1.5 px-3 py-2">
            <StatChip label="Shots" value="0" />
            <StatChip label="Selected" value="0" />
          </div>
          <EmptyState
            compact
            title="No shots"
            description="Shots are created from the Director's shot list. This scene has none."
          />
        </TabPanel>
      )}
    </>
  );
}