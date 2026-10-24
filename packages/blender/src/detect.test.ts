import { describe, expect, it } from "vitest";

import {
  MINIMUM_SUPPORTED_MAJOR,
  MINIMUM_SUPPORTED_MINOR,
  compareInstallDirs,
  detectBlender,
  executableName,
  extractVersionFromDirName,
  isSupported,
  parseBlenderVersion,
  parseVersionParts,
  standardInstallCandidates,
  windowsInstallCandidates,
} from "./detect.js";

/**
 * Detection tests.
 *
 * Two halves, deliberately separated:
 *
 *   1. Pure functions — version parsing and install-directory ordering. These are the
 *      parts that are easy to get subtly wrong and impossible to notice, and they run
 *      everywhere, including CI with no Blender.
 *   2. A live probe against whatever Blender is actually installed. This SKIPS rather
 *      than fails when Blender is absent, so the suite stays green on a machine without
 *      it — but when Blender *is* present the assertions run for real, because "detection
 *      returns a path" is only meaningful if the path runs.
 */

describe("parseBlenderVersion", () => {
  it("reads the version from real `--version` output", () => {
    // The exact first line Blender 5.1.0 prints on this machine.
    expect(parseBlenderVersion("Blender 5.1.0\n\tbuild date: 2026-03-17")).toBe("5.1.0");
  });

  it("accepts two-component versions", () => {
    expect(parseBlenderVersion("Blender 4.2\n")).toBe("4.2");
  });

  it("ignores build metadata that looks like a version", () => {
    // A banner full of numbers must not be mistaken for the version. Anchoring on the
    // word "Blender" is what keeps `build hash: adfe2921` and the build date out.
    const banner = [
      "Blender 5.1.0",
      "\tbuild date: 2026-03-17",
      "\tbuild hash: adfe2921d5f3",
      "\tbuild platform: Windows",
    ].join("\n");
    expect(parseBlenderVersion(banner)).toBe("5.1.0");
  });

  it("handles pre-release suffixes without inventing components", () => {
    expect(parseBlenderVersion("Blender 4.2.0 Alpha")).toBe("4.2.0");
  });

  it("returns null for output with no version at all", () => {
    expect(parseBlenderVersion("command not found")).toBeNull();
  });
});

describe("parseVersionParts", () => {
  it("fills missing components with zero", () => {
    expect(parseVersionParts("4.2")).toEqual({
      major: 4,
      minor: 2,
      patch: 0,
      hasPatch: false,
    });
  });
});

describe("isSupported", () => {
  it("accepts the integration's floor and everything above it", () => {
    expect(isSupported("3.0")).toBe(true);
    expect(isSupported("3.0.0")).toBe(true);
    expect(isSupported("5.1.0")).toBe(true);
    expect(isSupported("10.0.0")).toBe(true);
  });

  it("rejects anything below the floor", () => {
    expect(isSupported("2.93")).toBe(false);
    expect(isSupported("2.9")).toBe(false);
  });

  it("treats an unknown version as unsupported rather than assuming it is fine", () => {
    // The honest reading: we could not read the version, so we cannot assert the API
    // surface we depend on exists. Saying "probably fine" is how a render fails deep
    // inside Blender with an unhelpful traceback.
    expect(isSupported(null)).toBe(false);
    expect(isSupported("garbage")).toBe(false);
  });

  it("agrees with the exported constants", () => {
    expect(isSupported(`${MINIMUM_SUPPORTED_MAJOR}.${MINIMUM_SUPPORTED_MINOR}`)).toBe(true);
    expect(isSupported(`${MINIMUM_SUPPORTED_MAJOR - 1}.999`)).toBe(false);
  });
});

describe("install directory ordering", () => {
  it("orders Blender 10 above Blender 5, which string sorting gets backwards", () => {
    // This is the whole point of the numeric comparison. As strings, "Blender 10.0" sorts
    // BEFORE "Blender 5.1", so a naive `sort()` picks the older install on a machine that
    // has both — a silent downgrade.
    const dirs = ["Blender 5.1", "Blender 10.0", "Blender 4.2"];
    const byString = [...dirs].sort();
    expect(byString[0]).toBe("Blender 10.0"); // proves the naive approach is wrong

    const byVersion = [...dirs].sort(compareInstallDirs);
    expect(byVersion).toEqual(["Blender 4.2", "Blender 5.1", "Blender 10.0"]);
  });

  it("orders by minor before patch", () => {
    expect(["Blender 5.10", "Blender 5.2"].sort(compareInstallDirs)).toEqual([
      "Blender 5.2",
      "Blender 5.10",
    ]);
  });

  it("ranks an unversioned directory below any known version", () => {
    expect(["Blender", "Blender 3.0"].sort(compareInstallDirs)).toEqual(["Blender", "Blender 3.0"]);
  });

  it("picks the highest version, not the first alphabetically", () => {
    const candidates = windowsInstallCandidates(
      "C:\\Program Files\\Blender Foundation",
      () => ["Blender 4.2", "Blender 10.0", "Blender 5.1"],
      (...segments) => segments.join("/"),
    );

    expect(candidates[0]).toBe("C:/Program Files/Blender Foundation/Blender 10.0/blender.exe");
    expect(candidates).toHaveLength(3);
  });

  it("ignores directories that carry no Blender version", () => {
    const candidates = windowsInstallCandidates(
      "C:\\Program Files\\Blender Foundation",
      () => ["Blender 5.1", "Uninstall", "Docs"],
      (...segments) => segments.join("/"),
    );
    expect(candidates).toEqual(["C:/Program Files/Blender Foundation/Blender 5.1/blender.exe"]);
  });

  it("returns nothing when the install root does not exist", () => {
    const candidates = windowsInstallCandidates(
      "C:\\Nope",
      () => {
        throw new Error("ENOENT");
      },
      (...segments) => segments.join("/"),
    );
    expect(candidates).toEqual([]);
  });
});

describe("auxiliary probes", () => {
  it("extracts a version from a directory name", () => {
    expect(extractVersionFromDirName("Blender 5.1")).toBe("5.1");
    expect(extractVersionFromDirName("blender-4.2.0")).toBe("4.2.0");
    expect(extractVersionFromDirName("Blender Foundation")).toBeNull();
  });

  it("uses the platform's executable name", () => {
    expect(executableName("win32")).toBe("blender.exe");
    expect(executableName("linux")).toBe("blender");
    expect(executableName("darwin")).toBe("blender");
  });

  it("offers standard locations for each platform", () => {
    expect(standardInstallCandidates("linux", () => [])).toContain("/usr/bin/blender");
    expect(standardInstallCandidates("darwin", () => [])).toContain(
      "/Applications/Blender.app/Contents/MacOS/blender",
    );
    expect(standardInstallCandidates("win32", () => ["Blender 5.1"])).toHaveLength(1);
  });

  it("honours BLENDER_PATH as the first probe", async () => {
    const result = await detectBlender({
      env: { BLENDER_PATH: "C:\\custom\\blender.exe" },
      platform: "win32",
      probeVersion: false,
    });
    expect(result.install?.source).toBe("BLENDER_PATH");
    expect(result.install?.path).toBe("C:\\custom\\blender.exe");
  });

  it("falls through to PATH when BLENDER_PATH is unset", async () => {
    const result = await detectBlender({
      env: {},
      platform: "linux",
      probeVersion: false,
    });
    expect(result.install?.source).toBe("PATH");
    expect(result.install?.path).toBe("blender");
  });
});

/**
 * Live detection.
 *
 * `describe.skip` rather than a conditional assertion so the skip is visible in the
 * report: on a machine without Blender it prints as skipped, not as a silent pass.
 */
const liveDetection = await detectBlender();
const maybeLive = liveDetection.install !== null ? describe : describe.skip;

maybeLive("detection against the machine's real Blender", () => {
  it("finds the installed Blender and reads a version from it", async () => {
    const { install, attempts } = await detectBlender();

    expect(install).not.toBeNull();
    // The path exists and Blender answered `--version`, so this is not a lucky filesystem
    // hit on a stale directory.
    expect(install?.versionVerified).toBe(true);
    expect(install?.version).toMatch(/^\d+\.\d+/);

    // The version must satisfy the integration's own requirement, since that is what the
    // adapter gates submission on.
    expect(isSupported(install?.version ?? null)).toBe(true);
    expect(install?.supported).toBe(true);

    // Every candidate we tried is recorded, so a failure here would be explainable.
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.some((attempt) => attempt.found)).toBe(true);
  }, 60_000);
});