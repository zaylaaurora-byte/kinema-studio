import type { Metadata } from "next";
import * as React from "react";

import { WorkspaceShell } from "@/components/workspace/workspace-shell";

/**
 * The workspace route.
 *
 * The project identity below is the only thing that is not read from a store: it
 * is the name of the workspace you are currently in, which the app knows because
 * it is the route. There is no project file to read, so no series or scenes are
 * invented to fill the tree - see `left-pane.tsx` for why.
 */

export const metadata: Metadata = {
  title: "Workspace · Kinema Studio",
};

const PROJECT_NAME = "Untitled project";
const SERIES_NAME = "No series";
const SCENE_NAME = "No scene selected";

export default function WorkspacePage() {
  return (
    <WorkspaceShell
      projectName={PROJECT_NAME}
      seriesName={SERIES_NAME}
      sceneName={SCENE_NAME}
    />
  );
}