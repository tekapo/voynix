#!/usr/bin/env node
// Bump the app version across every file that carries it. Nothing else about
// the tree changes: no git commit, no tag, no android/tauri.properties (that's
// regenerated from tauri.conf.json by `tauri android build` itself).
//
//   npm run version:bump -- patch          # 0.7.0 -> 0.7.1
//   npm run version:bump -- minor          # 0.7.0 -> 0.8.0
//   npm run version:bump -- major          # 0.7.0 -> 1.0.0
//   npm run version:bump -- 1.2.3          # set explicitly
//   npm run version:bump -- patch --dry-run
//   npm run version:bump -- --check        # verify all files agree, bump nothing
//
// Files kept in sync (all currently read the same version, per the plan this
// script came out of):
//   package.json                        "version"
//   package-lock.json                   top-level "version" + packages[""].version
//   src-tauri/tauri.conf.json           "version"
//   src-tauri/Cargo.toml                [package].version (the voynix crate itself)
//   src-tauri/Cargo.lock                the "voynix" package entry only
//   android-native/app/build.gradle.kts versionName (kept in step with the
//                                        others); versionCode is bumped by 1
//                                        each run since it's a separate,
//                                        Android-only monotonic counter

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = (p) => join(ROOT, p);

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function parseSemver(v) {
    const m = SEMVER_RE.exec(v);
    if (!m) throw new Error(`not a semver x.y.z: ${v}`);
    return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function bump(current, kind) {
    if (SEMVER_RE.test(kind)) return kind; // explicit version
    const { major, minor, patch } = parseSemver(current);
    if (kind === "major") return `${major + 1}.0.0`;
    if (kind === "minor") return `${major}.${minor + 1}.0`;
    if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
    throw new Error(`unknown bump kind: ${kind} (use patch|minor|major|x.y.z)`);
}

// --- Each target: how to read its current version and how to rewrite it. ---

function jsonFile(relPath, { extra } = {}) {
    const full = path(relPath);
    const raw = readFileSync(full, "utf8");
    const data = JSON.parse(raw);
    return {
        path: relPath,
        read: () => data.version,
        write: (next) => {
            data.version = next;
            if (extra) extra(data, next);
            // Preserve npm's own formatting habits: 2-space indent, trailing newline.
            writeFileSync(full, JSON.stringify(data, null, 2) + "\n");
        },
    };
}

function cargoToml(relPath) {
    const full = path(relPath);
    return {
        path: relPath,
        read: () => {
            const raw = readFileSync(full, "utf8");
            const m = /^version = "([^"]+)"/m.exec(raw);
            if (!m) throw new Error(`no top-level version in ${relPath}`);
            return m[1];
        },
        write: (next) => {
            const raw = readFileSync(full, "utf8");
            const updated = raw.replace(/^version = "[^"]+"/m, `version = "${next}"`);
            writeFileSync(full, updated);
        },
    };
}

// Cargo.lock's [[package]] entries aren't ordered/keyed simply enough for a
// one-line regex; find the "voynix" package block specifically and only touch
// the version line inside it.
function cargoLockVoynix(relPath) {
    const full = path(relPath);
    const findBlock = (raw) => {
        const nameIdx = raw.indexOf('name = "voynix"');
        if (nameIdx === -1) throw new Error(`no "voynix" package in ${relPath}`);
        const versionIdx = raw.indexOf("version = \"", nameIdx);
        const lineEnd = raw.indexOf("\n", versionIdx);
        return { versionIdx, lineEnd };
    };
    return {
        path: relPath,
        read: () => {
            const raw = readFileSync(full, "utf8");
            const { versionIdx, lineEnd } = findBlock(raw);
            const m = /version = "([^"]+)"/.exec(raw.slice(versionIdx, lineEnd));
            return m[1];
        },
        write: (next) => {
            const raw = readFileSync(full, "utf8");
            const { versionIdx, lineEnd } = findBlock(raw);
            const before = raw.slice(0, versionIdx);
            const after = raw.slice(lineEnd);
            writeFileSync(full, `${before}version = "${next}"${after}`);
        },
    };
}

// android-native has its own applicationId/version lineage (versionCode is a
// separate monotonic integer Android requires); we only keep versionName in
// step with everything else and bump versionCode by 1 alongside it.
function androidBuildGradle(relPath) {
    const full = path(relPath);
    return {
        path: relPath,
        read: () => {
            const raw = readFileSync(full, "utf8");
            const m = /versionName = "([^"]+)"/.exec(raw);
            if (!m) throw new Error(`no versionName in ${relPath}`);
            return m[1];
        },
        write: (next) => {
            const raw = readFileSync(full, "utf8");
            const codeMatch = /versionCode = (\d+)/.exec(raw);
            if (!codeMatch) throw new Error(`no versionCode in ${relPath}`);
            const nextCode = Number(codeMatch[1]) + 1;
            const updated = raw
                .replace(/versionName = "[^"]+"/, `versionName = "${next}"`)
                .replace(/versionCode = \d+/, `versionCode = ${nextCode}`);
            writeFileSync(full, updated);
        },
    };
}

const targets = [
    jsonFile("package.json"),
    jsonFile("package-lock.json", {
        extra: (data, next) => {
            if (data.packages && data.packages[""]) data.packages[""].version = next;
        },
    }),
    jsonFile("src-tauri/tauri.conf.json"),
    cargoToml("src-tauri/Cargo.toml"),
    cargoLockVoynix("src-tauri/Cargo.lock"),
    androidBuildGradle("android-native/app/build.gradle.kts"),
];

// --- CLI ---

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const checkOnly = args.includes("--check");
const kindArg = args.find((a) => !a.startsWith("--"));

const current = targets.map((t) => ({ path: t.path, version: t.read() }));
const mismatched = current.filter((c) => c.version !== current[0].version);

if (checkOnly) {
    if (mismatched.length > 0) {
        console.error("Version mismatch across files:");
        for (const c of current) console.error(`  ${c.version.padEnd(10)} ${c.path}`);
        process.exit(1);
    }
    console.log(`All files agree: ${current[0].version}`);
    process.exit(0);
}

if (mismatched.length > 0) {
    console.warn("Warning: files disagree on the current version before bumping:");
    for (const c of current) console.warn(`  ${c.version.padEnd(10)} ${c.path}`);
}

if (!kindArg) {
    console.error("Usage: npm run version:bump -- <patch|minor|major|x.y.z> [--dry-run]");
    console.error("       npm run version:bump -- --check");
    process.exit(1);
}

const base = current[0].version; // package.json's, by convention the source of truth
const next = bump(base, kindArg);

console.log(`${base} -> ${next}${dryRun ? "  (dry run)" : ""}`);
for (const t of targets) {
    console.log(`  ${t.path}`);
    if (!dryRun) t.write(next);
}

if (dryRun) {
    console.log("\nDry run only — nothing written.");
} else {
    console.log("\nDone. Not committed — review with `git diff` and commit yourself.");
}
console.log("Don't forget to add an entry to CHANGELOG.md.");
