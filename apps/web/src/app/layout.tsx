import type { Metadata, Viewport } from "next";
import * as React from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { color } from "@/lib/tokens";

import "./globals.css";

/**
 * Root layout.
 *
 * `TooltipProvider` wraps the whole app because the honest-UI rule depends on it:
 * every disabled control must be able to explain itself, and Radix requires a
 * single provider above all tooltips.
 *
 * `color-scheme: dark` is set in globals.css rather than here so that the
 * scrollbars and native form controls follow the palette before React hydrates.
 */

export const metadata: Metadata = {
  title: "Kinema Studio",
  description:
    "An all-in-one AI-powered creative production studio for independent creators, YouTubers and animators.",
};

export const viewport: Viewport = {
  themeColor: color.canvas,
  // Desktop-first, per the spec: "optimise for 1440px+ desktop, adapt to tablets".
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="h-full antialiased">
        <TooltipProvider delayDuration={400} skipDelayDuration={200}>
          {children}
        </TooltipProvider>
      </body>
    </html>
  );
}