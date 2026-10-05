#!/usr/bin/env node
// Launch the Android Auto Desktop Head Unit (DHU) against a USB-connected
// device. Wraps the fiddly bit — `adb forward` has to be re-created every
// time the phone reconnects, and the DHU binary lives under a versioned SDK
// path that's easy to get wrong — into one command.
//
//   npm run auto:dhu
//   npm run auto:dhu -- -i touch          # extra flags are passed through to DHU
//
// Requires (see README.md "Using Android Auto" for enabling unknown sources,
// and android-native/README.md "Verifying with the Desktop Head Unit (DHU)"):
//   - a device connected over USB with USB debugging enabled
//   - Android Auto's "developer settings" -> "Start head unit server" running
//     on that device (tap "Version" ~10 times in Auto's settings to unlock it)
//   - "Unknown sources" enabled in Android Auto's developer settings, since
//     `com.tekapo.voynix` is signed with the debug key

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const sdkRoot =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    join(process.env.HOME ?? "", "Library/Android/sdk");

const adb = join(sdkRoot, "platform-tools", "adb");
const dhu = join(sdkRoot, "extras", "google", "auto", "desktop-head-unit");

if (!existsSync(dhu)) {
    console.error(`DHU not found at ${dhu}`);
    console.error("Install it (2.1 pulls in a newer protocol version than the");
    console.error("stable 2.0 release):");
    console.error("");
    console.error(`  ${join(sdkRoot, "cmdline-tools/latest/bin/android")} sdk install --beta "extras;google;auto@2.1.0"`);
    process.exit(1);
}

if (!existsSync(adb)) {
    console.error(`adb not found at ${adb} (set ANDROID_HOME/ANDROID_SDK_ROOT)`);
    process.exit(1);
}

const devices = execFileSync(adb, ["devices"], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("*"))
    .map((l) => l.split(/\s+/));

const online = devices.filter(([, state]) => state === "device");

if (online.length === 0) {
    console.error("No device online (`adb devices` is empty).");
    console.error("Connect a phone over USB, enable USB debugging, and accept the");
    console.error("prompt on the device, then re-run this command.");
    process.exit(1);
}

if (online.length > 1) {
    console.error(`Multiple devices online (${online.map((d) => d[0]).join(", ")}); pass -s to adb yourself.`);
    process.exit(1);
}

const serial = online[0][0];
console.log(`Using device ${serial}`);

execFileSync(adb, ["-s", serial, "forward", "tcp:5277", "tcp:5277"], { stdio: "inherit" });
console.log("Forwarded tcp:5277. Make sure Android Auto's \"Start head unit");
console.log("server\" is running on the device, then watch for the DHU window.");

const extraArgs = process.argv.slice(2);
const result = spawnSync(dhu, ["-a", "localhost:5277", ...extraArgs], { stdio: "inherit" });
process.exit(result.status ?? 1);
