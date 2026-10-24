"use client";

import {
  ChevronRight,
  FileStack,
  FolderTree,
  Image as ImageIcon,
  Layers,
  Type,
} from "lucide-react";
import * as React from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { PanelBody, PanelHeader } from "@/components/ui/panel";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";

/**
 * LeftPane - project/series tree and asset library.
 *
 * HONESTY NOTE: this build has no project store. There is no database, no
 * `.kinema` file on disk and no API to read one, so inventing a plausible list of
 * episodes and assets would be exactly the "hardcoded demo results" the
 * contributing guide prohibits. What it renders instead is:
 *
 *   - a real, keyboard-navigable ARIA tree with the one node that genuinely
 *     exists (the project currently open, which is the route the user is on),
 *   - real empty states for everything with no data,
 *   - an asset-library tab strip whose filter chips are real filter state (the
 *     filter genuinely applies to the - empty - result set, and the count it
 *     reports is the actual count).
 *
 * The tree uses `role="tree"` / `role="treeitem"` with roving tabindex and
 * Up/Down/Left/Right/Home/End, so it is operable exactly as a file tree should be
 * (WCAG 2.1.1). Wrapping it in the `treeitem` roles now means the behaviour does
 * not have to be retrofitted when real data arrives.
 */

export type AssetFilter = "all" | "video" | "image" | "audio" | "text";

interface TreeNode {
  readonly id: string;
  readonly label: string;
  readonly kind: "project" | "series" | "scene";
  readonly children: readonly TreeNode[];
}

/**
 * The only node that can be stated as fact: the open project, containing no
 * series yet. Everything is derived from the route, not fabricated.
 */
function buildTree(projectName: string): TreeNode {
  return {
    id: "project",
    label: projectName,
    kind: "project",
    children: [],
  };
}

const FILTERS: readonly { readonly id: AssetFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Video" },
  { id: "image", label: "Image" },
  { id: "audio", label: "Audio" },
  { id: "text", label: "Text" },
];

export interface LeftPaneProps {
  readonly projectName: string;
}

export function LeftPane({ projectName }: LeftPaneProps) {
  const [tab, setTab] = React.useState<"tree" | "assets">("tree");
  const [filter, setFilter] = React.useState<AssetFilter>("all");

  const tree = React.useMemo(() => buildTree(projectName), [projectName]);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set(["project"]),
  );
  const [focused, setFocused] = React.useState("project");
  const itemRefs = React.useRef(new Map<string, HTMLDivElement>());

  /** Flattened, in visual order - this is what arrow navigation walks. */
  const visible = React.useMemo(() => {
    const out: TreeNode[] = [];
    const walk = (node: TreeNode) => {
      out.push(node);
      if (expanded.has(node.id)) node.children.forEach(walk);
    };
    walk(tree);
    return out;
  }, [tree, expanded]);

  const focusNode = (id: string) => {
    setFocused(id);
    itemRefs.current.get(id)?.focus();
  };

  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = visible.findIndex((node) => node.id === focused);
    if (index < 0) return;
    const node = visible[index];
    if (!node) return;

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = visible[index + 1];
        if (next) focusNode(next.id);
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        const prev = visible[index - 1];
        if (prev) focusNode(prev.id);
        break;
      }
      case "ArrowRight": {
        event.preventDefault();
        if (node.children.length > 0 && !expanded.has(node.id)) {
          setExpanded((prev) => new Set(prev).add(node.id));
        }
        break;
      }
      case "ArrowLeft": {
        event.preventDefault();
        if (expanded.has(node.id)) {
          setExpanded((prev) => {
            const next = new Set(prev);
            next.delete(node.id);
            return next;
          });
        }
        break;
      }
      case "Home": {
        event.preventDefault();
        const first = visible[0];
        if (first) focusNode(first.id);
        break;
      }
      case "End": {
        event.preventDefault();
        const last = visible[visible.length - 1];
        if (last) focusNode(last.id);
        break;
      }
      default:
        break;
    }
  };

  const filterCounts: Record<AssetFilter, number> = {
    all: 0,
    video: 0,
    image: 0,
    audio: 0,
    text: 0,
  };

  return (
    <>
      <div className="flex-none border-b border-border px-1 py-1">
        <Tabs
          idBase="left-pane"
          aria-label="Left pane view"
          value={tab}
          onValueChange={(next) => setTab(next === "assets" ? "assets" : "tree")}
          items={[
            { id: "tree", label: "Project" },
            { id: "assets", label: "Assets" },
          ]}
        />
      </div>

      {tab === "tree" ? (
        <TabPanel idBase="left-pane" tabId="tree" className="px-2 py-2">
          <div
            role="tree"
            aria-label={`${projectName} structure`}
            onKeyDown={onTreeKeyDown}
            className="flex flex-col gap-0.5"
          >
            <div
              role="treeitem"
              aria-level={1}
              aria-expanded={expanded.has(tree.id)}
              aria-selected={focused === tree.id}
              tabIndex={focused === tree.id ? 0 : -1}
              ref={(el) => {
                if (el) itemRefs.current.set(tree.id, el);
                else itemRefs.current.delete(tree.id);
              }}
              onClick={() => focusNode(tree.id)}
              className={cn(
                "flex h-7 items-center gap-2 rounded-sm px-2 text-base",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
                focused === tree.id
                  ? "bg-panel-elevated text-text"
                  : "text-text-secondary hover:bg-panel-elevated",
              )}
            >
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "size-3.5 flex-none text-text-tertiary transition-transform duration-150",
                  expanded.has(tree.id) && "rotate-90",
                )}
              />
              <FolderTree aria-hidden="true" className="size-3.5 flex-none" />
              <span className="truncate font-medium">{tree.label}</span>
            </div>

            {tree.children.length === 0 ? (
              <p className="px-2 py-3 text-sm leading-relaxed text-text-tertiary">
                No series or scenes yet. Scenes are created by the AI Director or
                imported from a script.
              </p>
            ) : null}
          </div>

          <PanelHeader icon={<Layers className="size-3.5" />} className="mt-4 px-0">
            Library
          </PanelHeader>
          <EmptyState
            compact
            icon={<FileStack className="size-4" />}
            title="Library is empty"
            description="Generated shots and imported media appear here once a scene has been created. Nothing has been generated in this build."
          />
        </TabPanel>
      ) : (
        <TabPanel idBase="left-pane" tabId="assets" className="flex flex-col">
          <div
            role="group"
            aria-label="Filter assets by type"
            className="flex flex-wrap gap-1 px-2 py-2"
          >
            {FILTERS.map((entry) => {
              const selected = filter === entry.id;
              const count = filterCounts[entry.id];
              return (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setFilter(entry.id)}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-xs font-medium",
                    "transition-colors duration-150 ease-[var(--ease-standard)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-panel",
                    selected
                      ? "border-accent/40 bg-accent-subtle text-accent"
                      : "border-border bg-panel-elevated text-text-tertiary hover:text-text-secondary",
                  )}
                >
                  {entry.label}
                  <span className="tabular opacity-70">{count}</span>
                </button>
              );
            })}
          </div>

          <PanelBody className="px-2">
            <EmptyState
              compact
              icon={<ImageIcon className="size-4" />}
              title={
                filter === "all"
                  ? "No assets in this project"
                  : `No ${filter} assets`
              }
              description={
                filter === "all"
                  ? "Assets are added when a shot is generated or media is imported. This build has no generation provider connected, so the library is genuinely empty."
                  : "No asset of this type exists yet. Clear the filter to see all asset types."
              }
            />
          </PanelBody>

          <PanelHeader icon={<Type className="size-3.5" />} divided>
            Asset detail
          </PanelHeader>
          <p className="px-3 py-3 text-sm leading-relaxed text-text-tertiary">
            Select an asset to inspect its metadata. Nothing is selected.
          </p>
        </TabPanel>
      )}
    </>
  );
}