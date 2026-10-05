#!/usr/bin/env node
// Tag the current version and push the tag, which triggers the "Build macOS"
// GitHub Actions workflow (.github/workflows/build-macos.yml) to build a
// macOS release artifact.
//
//   npm run release            # tag v<version from package.json> and push it
//   npm run release -- --dry-run

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = (p) => join(ROOT, p);

function run(cmd, args) {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" }).trim();
}

const dryRun = process.argv.includes("--dry-run");

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
console.log(`Done. Watch the build: https://github.com/${repoSlug()}/actions/workflows/build-macos.yml`);

function repoSlug() {
    try {
        const url = run("git", ["remote", "get-url", "origin"]);
        const m = /github\.com[:/](.+?)(\.git)?$/.exec(url);
        return m ? m[1] : "<owner>/<repo>";
    } catch {
        return "<owner>/<repo>";
    }
}
