#!/usr/bin/env node
// Build the signed release Android App Bundle (.aab) for Google Play and
// copy it to voynix-<version>.aab next to the Gradle output. The AAB is signed
// with the release key, which Play uses as the upload key (Play App Signing).
// It is for a manual upload in Play Console (Testing → Internal testing);
// `npm run release:play` builds and uploads it automatically. It is not
// attached to the GitHub Release.
//
//   npm run build:android-aab

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = (p) => join(ROOT, p);

function run(cmd, args, opts = {}) {
    return (execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts }) ?? "").trim();
}

try {
    run("node", [path("scripts/bump-version.mjs"), "--check"]);
} catch {
    console.error("Version mismatch across files — run `npm run version:bump` first.");
    process.exit(1);
}

const { version } = JSON.parse(readFileSync(path("package.json"), "utf8"));

const localProps = path("android-native/local.properties");
if (!existsSync(localProps) || !/^voynix\.release\.storeFile=/m.test(readFileSync(localProps, "utf8"))) {
    console.error("Release keystore is not configured in android-native/local.properties (see android-native/README.md).");
    process.exit(1);
}

console.log("Building signed release AAB...");
run("./gradlew", ["bundleRelease"], { cwd: path("android-native"), stdio: "inherit" });

const built = path("android-native/app/build/outputs/bundle/release/app-release.aab");
if (!existsSync(built)) {
    console.error(`Signed AAB not found at ${built}.`);
    process.exit(1);
}

const aab = path(`android-native/app/build/outputs/bundle/release/voynix-${version}.aab`);
copyFileSync(built, aab);
console.log(`AAB: ${aab}`);
