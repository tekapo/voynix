#!/usr/bin/env node
// Tag the current version and push the tag, which triggers the "Build macOS"
// GitHub Actions workflow (.github/workflows/build-macos.yml) to build a
// macOS release artifact. Then it waits for that workflow to create the
// Release and runs scripts/release-android.mjs to build the signed APK
// locally and attach it (the release key stays on this machine).
//
//   npm run release            # tag, push, wait for CI, attach the APK
//   npm run release -- --no-android   # tag and push only
//   npm run release -- --dry-run

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = (p) => join(ROOT, p);

function run(cmd, args) {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" }).trim();
}

const dryRun = process.argv.includes("--dry-run");
const skipAndroid = process.argv.includes("--no-android");

// Every file version:bump touches must already agree.
try {
    run("node", [path("scripts/bump-version.mjs"), "--check"]);
} catch {
    console.error("Version mismatch across files — run `npm run version:bump` first.");
    process.exit(1);
}

const { version } = JSON.parse(readFileSync(path("package.json"), "utf8"));
const tag = `v${version}`;

const status = run("git", ["status", "--porcelain"]);
if (status) {
    console.error("Working tree is not clean — commit or stash changes first:");
    console.error(status);
    process.exit(1);
}

const existingTags = run("git", ["tag", "--list", tag]);
if (existingTags) {
    console.error(`Tag ${tag} already exists.`);
    process.exit(1);
}

console.log(`${dryRun ? "(dry run) " : ""}Tagging ${tag} and pushing to origin...`);
if (!dryRun) {
    run("git", ["tag", tag]);
    run("git", ["push", "origin", tag]);
}
console.log(`Watch the build: https://github.com/${repoSlug()}/actions/workflows/build-macos.yml`);

if (skipAndroid) {
    console.log("Skipping the Android APK (--no-android). Run `npm run release:android` after the Release exists.");
} else if (dryRun) {
    console.log("(dry run) Would wait for the workflow, then run `npm run release:android`.");
} else {
    await attachAndroid();
}

async function attachAndroid() {
    // A tag-push run has the tag as its head branch. It can take a few
    // seconds to show up after the push.
    let runId = "";
    for (let i = 0; i < 30 && !runId; i++) {
        const out = run("gh", [
            "run", "list", "--workflow", "build-macos.yml", "--branch", tag,
            "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId",
        ]);
        runId = out === "null" ? "" : out;
        if (!runId) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!runId) {
        console.error(`Could not find the Build macOS run for ${tag}. Run \`npm run release:android\` once the Release exists.`);
        process.exit(1);
    }
    console.log(`Waiting for the Build macOS workflow (run ${runId})...`);
    const watch = spawnSync("gh", ["run", "watch", runId, "--exit-status"], { cwd: ROOT, stdio: "inherit" });
    if (watch.status !== 0) {
        console.error("The Build macOS workflow failed; the Release was not created. Fix it, then run `npm run release:android`.");
        process.exit(1);
    }
    const apk = spawnSync("node", [path("scripts/release-android.mjs")], { cwd: ROOT, stdio: "inherit" });
    if (apk.status !== 0) process.exit(apk.status ?? 1);
    console.log(`Released ${tag}: https://github.com/${repoSlug()}/releases/tag/${tag}`);
}

function repoSlug() {
    try {
        const url = run("git", ["remote", "get-url", "origin"]);
        const m = /github\.com[:/](.+?)(\.git)?$/.exec(url);
        return m ? m[1] : "<owner>/<repo>";
    } catch {
        return "<owner>/<repo>";
    }
}
