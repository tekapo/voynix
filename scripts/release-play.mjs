#!/usr/bin/env node
// Build the signed release App Bundle and upload it to Google Play's internal
// testing track with Gradle Play Publisher (publishReleaseBundle). The release
// notes are this version's docs/CHANGELOG.md entry. Promoting a release to
// production is done by hand in Play Console.
//
//   npm run release:play                    # build + upload to internal testing
//   npm run release:play -- --dry-run       # print the release notes only
//   npm run release:play -- --if-configured # skip quietly without a Play key (used by `npm run release`)
//
// Needs the release keystore and a Play service account key, both configured
// in android-native/local.properties (see android-native/README.md).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = (p) => join(ROOT, p);

// Play rejects release notes longer than this.
const MAX_NOTES = 500;
// The default store listing language. Release notes need at least it.
const NOTES_LANGUAGE = "ja-JP";

function run(cmd, args, opts = {}) {
    return (execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts }) ?? "").trim();
}

const dryRun = process.argv.includes("--dry-run");
const ifConfigured = process.argv.includes("--if-configured");

try {
    run("node", [path("scripts/bump-version.mjs"), "--check"]);
} catch {
    console.error("Version mismatch across files — run `npm run version:bump` first.");
    process.exit(1);
}

const { version } = JSON.parse(readFileSync(path("package.json"), "utf8"));

const localPropsPath = path("android-native/local.properties");
const localProps = existsSync(localPropsPath) ? readFileSync(localPropsPath, "utf8") : "";
const hasPlayKey = /^voynix\.play\.serviceAccountCredentials=/m.test(localProps)
    || Boolean(process.env.ANDROID_PUBLISHER_CREDENTIALS);
if (!hasPlayKey) {
    const msg = "The Play service account key is not configured in android-native/local.properties (see android-native/README.md).";
    if (ifConfigured) {
        console.log(`Skipping the Google Play upload. ${msg}`);
        process.exit(0);
    }
    console.error(msg);
    process.exit(1);
}
if (!/^voynix\.release\.storeFile=/m.test(localProps)) {
    console.error("Release keystore is not configured in android-native/local.properties (see android-native/README.md).");
    process.exit(1);
}

const notes = releaseNotes(version);
console.log(`Release notes (${NOTES_LANGUAGE}):\n${notes}\n`);
if (dryRun) {
    console.log("(dry run) Would run `./gradlew publishReleaseBundle` to upload to internal testing.");
    process.exit(0);
}

const notesDir = path(`android-native/app/src/main/play/release-notes/${NOTES_LANGUAGE}`);
mkdirSync(notesDir, { recursive: true });
writeFileSync(join(notesDir, "default.txt"), notes + "\n");

console.log("Building the signed AAB and uploading it to internal testing...");
run("./gradlew", ["publishReleaseBundle"], { cwd: path("android-native"), stdio: "inherit" });
console.log(`Uploaded ${version} to Google Play internal testing.`);

// This version's CHANGELOG bullets as plain text, cut to Play's limit.
function releaseNotes(version) {
    const changelog = readFileSync(path("docs/CHANGELOG.md"), "utf8");
    const lines = changelog.split("\n");
    const start = lines.findIndex((l) => l.startsWith(`## ${version} `));
    if (start === -1) {
        console.error(`docs/CHANGELOG.md has no entry for ${version}.`);
        process.exit(1);
    }
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    const text = lines.slice(start + 1, end === -1 ? undefined : end)
        .map((l) => l.replace(/[`*]/g, "").trimEnd())
        .filter((l) => l.trim())
        .join("\n");
    return text.length <= MAX_NOTES ? text : text.slice(0, MAX_NOTES - 1).trimEnd() + "…";
}
