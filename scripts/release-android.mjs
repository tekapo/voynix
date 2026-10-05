#!/usr/bin/env node
// Build the signed release APK locally and attach it to the GitHub Release
// for the current version (the Release itself is created by the "Build macOS"
// workflow when `npm run release` pushes the v<version> tag).
//
//   npm run release:android            # build + upload voynix-<version>.apk
//   npm run release:android -- --dry-run   # build only, skip the upload
//
// Needs the release keystore configured in android-native/local.properties
// (see android-native/README.md) and an authenticated `gh` CLI.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = (p) => join(ROOT, p);

function run(cmd, args, opts = {}) {
    // stdio: "inherit" / "ignore" make execFileSync return null.
    return (execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts }) ?? "").trim();
}

const dryRun = process.argv.includes("--dry-run");

try {
    run("node", [path("scripts/bump-version.mjs"), "--check"]);
} catch {
    console.error("Version mismatch across files — run `npm run version:bump` first.");
    process.exit(1);
}

const { version } = JSON.parse(readFileSync(path("package.json"), "utf8"));
const tag = `v${version}`;

const localProps = path("android-native/local.properties");
if (!existsSync(localProps) || !/^voynix\.release\.storeFile=/m.test(readFileSync(localProps, "utf8"))) {
    console.error("Release keystore is not configured in android-native/local.properties (see android-native/README.md).");
    process.exit(1);
}

if (!dryRun) {
    try {
        run("gh", ["release", "view", tag], { stdio: "ignore" });
    } catch {
        console.error(`GitHub Release ${tag} does not exist yet. Push the tag with \`npm run release\` and wait for the`);
        console.error("Build macOS workflow to create it, then run this again.");
        process.exit(1);
    }
}

console.log("Building signed release APK...");
run("./gradlew", ["assembleRelease"], { cwd: path("android-native"), stdio: "inherit" });

const built = path("android-native/app/build/outputs/apk/release/app-release.apk");
if (!existsSync(built)) {
    console.error(`Signed APK not found at ${built} (an unsigned build is named app-release-unsigned.apk).`);
    process.exit(1);
}

const asset = path(`android-native/app/build/outputs/apk/release/voynix-${version}.apk`);
copyFileSync(built, asset);
console.log(`APK: ${asset}`);

if (dryRun) {
    console.log("(dry run) Skipping upload.");
} else {
    run("gh", ["release", "upload", tag, asset, "--clobber"], { stdio: "inherit" });
    console.log(`Uploaded to release ${tag}.`);
}
