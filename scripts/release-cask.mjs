#!/usr/bin/env node
// Point the Homebrew cask in tekapo/homebrew-voynix at the DMG of the current
// version's GitHub Release (updates `version` and `sha256` and pushes it).
//
//   npm run release:cask            # update the tap
//   npm run release:cask -- --dry-run   # print the new cask, don't push
//
// Needs the Release (with the DMG) to exist and an authenticated `gh` CLI.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAP = "tekapo/homebrew-voynix";
const CASK_PATH = "Casks/voynix.rb";

function run(cmd, args, opts = {}) {
    return (execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts }) ?? "").trim();
}

const dryRun = process.argv.includes("--dry-run");

try {
    run("node", [join(ROOT, "scripts/bump-version.mjs"), "--check"]);
} catch {
    console.error("Version mismatch across files — run `npm run version:bump` first.");
    process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const tag = `v${version}`;

const dir = mkdtempSync(join(tmpdir(), "voynix-dmg-"));
try {
    run("gh", ["release", "download", tag, "--pattern", "*.dmg", "--dir", dir]);
} catch {
    console.error(`Could not download the DMG of Release ${tag}. Wait for the Build macOS workflow to create it.`);
    process.exit(1);
}
const [dmg] = readdirSync(dir);
const sha256 = createHash("sha256").update(readFileSync(join(dir, dmg))).digest("hex");

const file = JSON.parse(run("gh", ["api", `repos/${TAP}/contents/${CASK_PATH}`]));
const current = Buffer.from(file.content, "base64").toString("utf8");
const next = current
    .replace(/^(\s*version ").*(")$/m, `$1${version}$2`)
    .replace(/^(\s*sha256 ").*(")$/m, `$1${sha256}$2`);

if (next === current) {
    console.log(`Cask is already at ${version}.`);
    process.exit(0);
}
if (dryRun) {
    console.log(next);
    process.exit(0);
}

run("gh", [
    "api", "-X", "PUT", `repos/${TAP}/contents/${CASK_PATH}`,
    "-f", `message=Update voynix to ${version}`,
    "-f", `content=${Buffer.from(next).toString("base64")}`,
    "-f", `sha=${file.sha}`,
]);
console.log(`Updated ${TAP} to ${version} (sha256 ${sha256}).`);
