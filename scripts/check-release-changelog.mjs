import { readFileSync } from "node:fs";
import { extractUnreleased } from "./prepare-release.mjs";

/**
 * Pre-flight check for the publish workflow.
 *
 * - New releases require non-empty ## [Unreleased] (prepare-release bumps version).
 * - Empty Unreleased → recovery mode (retry npm/tag/release for package.json version).
 * - Fails early if the operator asked for a new bump (patch/minor/major/x.y.z) but
 *   Unreleased is empty.
 */

const releaseSpec = (process.env.RELEASE_SPEC ?? "").trim().toLowerCase();
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const changelog = readFileSync("CHANGELOG.md", "utf8");
const unreleased = extractUnreleased(changelog);

if (!unreleased.trim()) {
  console.log(
    `::notice title=Recovery mode::[Unreleased] is empty. This run will only complete publishing/tagging for ${manifest.version} (no version bump).`,
  );
  if (releaseSpec && !["", "auto", manifest.version].includes(releaseSpec)) {
    console.error(
      `::error::Cannot cut a new release: [Unreleased] has no entries but version input is "${releaseSpec}". Add notes under ## [Unreleased] or leave the input blank to retry ${manifest.version}.`,
    );
    process.exit(1);
  }
} else {
  console.log(
    `::notice title=New release::[Unreleased] has changes; prepare-release will bump from ${manifest.version}.`,
  );
}
