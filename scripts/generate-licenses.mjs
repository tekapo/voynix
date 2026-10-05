#!/usr/bin/env node
// Generates the third-party license notices shipped inside the apps:
//
//   public/licenses.txt                                  (Mac: Rust crates + npm packages + bundled font)
//   android-native/app/src/main/assets/licenses.txt      (Android: Gradle dependencies + bundled icons)
//
// Run `npm run licenses:generate` after changing dependencies and commit the
// result (src/licenses.test.ts fails if a direct dependency is missing).
// Reads cargo metadata, node_modules and the Gradle cache; POMs missing from the
// Gradle cache are fetched from Google Maven / Maven Central (network needed then).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const warnings = [];

const norm = (s) => s.replace(/\r\n/g, "\n").trim();
const read = (p) => norm(readFileSync(p, "utf8"));
const licenseFilesIn = (dir) =>
    existsSync(dir)
        ? readdirSync(dir)
              .filter((f) => /^(licen[cs]e|copying|notice|unlicense)/i.test(f))
              .map((f) => join(dir, f))
              .filter((p) => !/\.(rs|js|ts|json)$/.test(p) && statSync(p).isFile())
        : [];

// text hash -> { text, packages: Set<string> }
const newSection = () => new Map();
const add = (section, text, pkg) => {
    const key = createHash("sha256").update(text).digest("hex");
    if (!section.has(key)) section.set(key, { text, packages: new Set() });
    section.get(key).packages.add(pkg);
};

const MIT_TEMPLATE = (name) => `MIT License

Copyright (c) the ${name} authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const BSD3_TEMPLATE = (name) => `BSD 3-Clause License

Copyright (c) the ${name} authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

let mplText = null; // canonical MPL-2.0 text (no per-project copyright line), from a crate that ships it
const rememberMpl = (text) => {
    if (!mplText && /Mozilla Public License Version 2\.0/.test(text) && text.length > 9000) mplText = text;
};

let apacheText = null; // canonical Apache-2.0 text, taken from whichever crate ships it
const rememberApache = (text) => {
    if (!apacheText && /Apache License\s+Version 2\.0, January 2004/.test(text) && text.length > 9000) apacheText = text;
};

const selfLicense = read(join(root, "LICENSE"));

// ---------------------------------------------------------------- Rust
function rustSection() {
    const meta = JSON.parse(
        execFileSync(
            "cargo",
            ["metadata", "--format-version", "1", "--filter-platform", "aarch64-apple-darwin"],
            { cwd: join(root, "src-tauri"), maxBuffer: 1 << 28, encoding: "utf8" },
        ),
    );
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
    const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
    // Only normal (shipped) dependencies — build scripts and dev-dependencies don't end up in the binary.
    const seen = new Set();
    const stack = [meta.resolve.root];
    while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        for (const dep of nodes.get(id).deps) {
            if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg);
        }
    }
    const section = newSection();
    const names = new Set();
    const pendingMpl = [];
    for (const id of seen) {
        const p = pkgs.get(id);
        if (id === meta.resolve.root) continue;
        names.add(p.name);
        const isMpl = /MPL-2\.0/.test(p.license ?? "");
        // MPL-2.0 requires pointing recipients at the Source Code Form.
        const label = `${p.name} ${p.version} (${p.license ?? "license unknown"})${isMpl && p.repository ? ` — source: ${p.repository}` : ""}`;
        const files = licenseFilesIn(dirname(p.manifest_path));
        if (files.length === 0) {
            const lic = p.license ?? "";
            if (/MIT/.test(lic)) add(section, MIT_TEMPLATE(p.name), label);
            else if (/BSD-3-Clause/.test(lic)) add(section, BSD3_TEMPLATE(p.name), label);
            else if (isMpl) pendingMpl.push([section, label]);
            else {
                add(section, `License: ${lic || "unknown"}\nSee https://spdx.org/licenses/ for the full text.`, label);
                warnings.push(`rust: no license file for ${p.name} ${p.version} (${lic})`);
            }
            continue;
        }
        for (const f of files) {
            const text = read(f);
            rememberApache(text);
            rememberMpl(text);
            add(section, text, label);
        }
    }
    for (const [sec, label] of pendingMpl) {
        if (mplText) add(sec, mplText, label);
        else warnings.push(`rust: MPL-2.0 text unavailable for ${label}`);
    }
    return { section, names };
}

// ---------------------------------------------------------------- npm
function npmSection() {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    const section = newSection();
    const names = new Set();
    for (const [key, v] of Object.entries(lock.packages)) {
        if (!key || v.dev) continue;
        const name = key.replace(/^.*node_modules\//, "");
        names.add(name);
        const label = `${name} ${v.version} (${v.license ?? "license unknown"})`;
        const files = licenseFilesIn(join(root, key));
        if (files.length === 0) {
            if (/MIT/.test(v.license ?? "")) add(section, MIT_TEMPLATE(name), label);
            else warnings.push(`npm: no license file for ${name} ${v.version}`);
            continue;
        }
        for (const f of files) {
            const text = read(f);
            rememberApache(text);
            add(section, text, label);
        }
    }
    return { section, names };
}

// ---------------------------------------------------------------- Android
async function androidSection() {
    const out = execFileSync(
        "./gradlew",
        [":app:dependencies", "--configuration", "releaseRuntimeClasspath", "-q"],
        { cwd: join(root, "android-native"), maxBuffer: 1 << 26, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const deps = new Map(); // "group:artifact" -> version
    for (const line of out.split("\n")) {
        if (!/^[ |+\\-]*[+\\]--- /.test(line)) continue;
        const m = line.match(/--- ([\w.\-]+):([\w.\-]+):([^\s]+)(?: -> ([^\s]+))?/);
        if (!m) continue;
        const [, group, artifact, declared, resolved] = m;
        deps.set(`${group}:${artifact}`, resolved ?? declared);
    }
    const cache = join(homedir(), ".gradle/caches/modules-2/files-2.1");
    const findPom = (group, artifact, version) => {
        const dir = join(cache, group, artifact, version);
        if (!existsSync(dir)) return null;
        for (const sub of readdirSync(dir)) {
            const p = join(dir, sub, `${artifact}-${version}.pom`);
            if (existsSync(p)) return p;
        }
        return null;
    };
    // Gradle only caches the POM for modules without Gradle Module Metadata, so
    // fall back to the public Maven repositories for the rest.
    const fetchPom = async (group, artifact, version) => {
        const path = `${group.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}.pom`;
        for (const base of ["https://dl.google.com/dl/android/maven2", "https://repo.maven.apache.org/maven2"]) {
            try {
                const res = await fetch(`${base}/${path}`);
                if (res.ok) return await res.text();
            } catch {
                // try the next repository
            }
        }
        return null;
    };
    const licensesOf = async (group, artifact, version, depth = 0) => {
        const pom = findPom(group, artifact, version);
        const xml = pom ? readFileSync(pom, "utf8") : await fetchPom(group, artifact, version);
        if (!xml) return null;
        const found = [...xml.matchAll(/<license>\s*<name>([^<]*)<\/name>(?:\s*<url>([^<]*)<\/url>)?/g)].map((m) => ({
            name: m[1].trim(),
            url: (m[2] ?? "").trim(),
        }));
        if (found.length) return found;
        const parent = xml.match(/<parent>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>\s*<version>([^<]+)<\/version>/);
        if (parent && depth < 3) return await licensesOf(parent[1], parent[2], parent[3], depth + 1);
        return null;
    };

    const byLicense = new Map(); // "name\turl" -> Set(pkg)
    for (const [ga, version] of [...deps].sort()) {
        const [group, artifact] = ga.split(":");
        const lics = await licensesOf(group, artifact, version);
        if (!lics) {
            warnings.push(`android: no license found for ${ga}:${version}`);
            continue;
        }
        for (const l of lics) {
            const k = `${l.name}\t${l.url}`;
            if (!byLicense.has(k)) byLicense.set(k, new Set());
            byLicense.get(k).add(`${ga} ${version}`);
        }
    }
    return { byLicense, names: new Set([...deps.keys()]) };
}

// ---------------------------------------------------------------- render
const RULE = "=".repeat(78);

function renderSection(section) {
    return [...section.values()]
        .sort((a, b) => [...a.packages][0].localeCompare([...b.packages][0]))
        .map(({ text, packages }) => `${[...packages].sort().map((p) => `- ${p}`).join("\n")}\n\n${text}`)
        .join(`\n\n${"-".repeat(78)}\n\n`);
}

const header = (title) =>
    `${title}\n\nVoynix is distributed under the MIT License (below). It includes the third-party\nsoftware listed in this file, each under its own license.\n\n${RULE}\nVoynix\n${RULE}\n\n${selfLicense}\n`;

const fontText = read(join(root, "docs/third-party/OFL-Outfit.txt"));

// Mac
const rust = rustSection();
const npm = npmSection();
const mac =
    `${header("Voynix (Mac) — open source licenses")}\n${RULE}\nOutfit font (public/fonts/outfit.woff2)\n${RULE}\n\n${fontText}\n` +
    `\n${RULE}\nRust crates\n${RULE}\n\n${renderSection(rust.section)}\n` +
    `\n${RULE}\nnpm packages (frontend)\n${RULE}\n\n${renderSection(npm.section)}\n`;
writeFileSync(join(root, "public/licenses.txt"), mac);

// Android
const android = await androidSection();
const apache = apacheText ?? "Apache License, Version 2.0 — https://www.apache.org/licenses/LICENSE-2.0";
const androidBlocks = [...android.byLicense]
    .sort()
    .map(([k, pkgs]) => {
        const [name, url] = k.split("\t");
        const isApache = /apache/i.test(name);
        const body = isApache ? "Full text of the Apache License, Version 2.0: see the \"Apache License 2.0\" section below." : `Terms: ${url || "(see the library's project page)"}`;
        return `${name}${url ? ` <${url}>` : ""}\n${[...pkgs].sort().map((p) => `- ${p}`).join("\n")}\n\n${body}`;
    })
    .join(`\n\n${"-".repeat(78)}\n\n`);
const androidText =
    `${header("Voynix (Android) — open source licenses")}\n${RULE}\nAndroid libraries\n${RULE}\n\n${androidBlocks}\n` +
    `\n${RULE}\nAndroid Auto icons (res/drawable/ic_auto_*.xml)\n${RULE}\n\nDerived from Google's Material Symbols (https://fonts.google.com/icons), licensed under the Apache License 2.0.\n` +
    `\n${RULE}\nApache License 2.0\n${RULE}\n\n${apache}\n`;
writeFileSync(join(root, "android-native/app/src/main/assets/licenses.txt"), androidText);

if (warnings.length) {
    console.warn(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.warn("  " + w);
}
console.log(
    `rust: ${rust.names.size} crates, npm: ${npm.names.size} packages, android: ${android.names.size} artifacts\n` +
        `wrote public/licenses.txt (${(mac.length / 1024).toFixed(0)} KB) and android assets/licenses.txt (${(androidText.length / 1024).toFixed(0)} KB)`,
);
