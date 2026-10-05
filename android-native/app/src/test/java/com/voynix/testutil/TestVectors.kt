package com.voynix.testutil

import java.io.File

/**
 * Walks up from the Gradle unit-test working directory to find the repo-root
 * `docs/test-vectors/` — avoids hardcoding a relative depth that would break
 * if Gradle ever changes which directory it runs tests from. Shared by every
 * test that pins a cross-platform contract against the same JSON the Rust
 * (src-tauri) and TS (src/) test suites read.
 */
fun testVectorFile(name: String): File {
    var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (true) {
        val candidate = File(dir, "docs/test-vectors/$name")
        if (candidate.exists()) return candidate
        dir = dir.parentFile ?: error("could not locate docs/test-vectors/$name")
    }
}
