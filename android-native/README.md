# Voynix (android-native)

English | [日本語](./README.ja.md)

The native Android client for Voynix (Kotlin + Jetpack Compose). `applicationId` is `com.tekapo.voynix`;
the Kotlin package name (`namespace`) is `com.voynix`. It supports Android Auto, but a car connection is
optional: the app works fine on the phone alone.

It mirrors the Mac library over Wi-Fi as a mirror-only client (it never scans or imports song files
itself). Start Voynix on the Mac and turn on sync first.

This file is for developers (building, testing, verifying Android Auto). For how to use the app (pairing,
enabling Android Auto), see the [root README](../README.md). For the Mac app, see
[docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md).

## Requirements

- Android 8.0 (API 26) or later
- The same Wi-Fi network as the Mac running Voynix (sync is LAN-only)
- To build: Android Studio (latest recommended) or JDK 17+ with the Android SDK (compileSdk 36 /
  platform android-36)

## Build and install

Debug and release builds share the **same `applicationId`**; only the signing key differs.

| | Debug | Release |
| --- | --- | --- |
| Purpose | Day-to-day development | Daily use on a real device |
| Signing | Debug key (auto-generated) | Release key (set in `local.properties`) |
| Minify / resource shrinking | Off | On (R8) |
| Stack traces | Readable | Obfuscated |

### Android Studio

1. Open the `android-native/` folder in Android Studio
2. Wait for the Gradle sync to finish
3. Pick a device (a real device with USB debugging enabled, or an emulator)
4. Press Run ▶

### Command line

Enable **USB debugging** under Developer options on the device, connect it over USB, and approve
"Allow this computer" on the device. Check the connection:

```sh
adb devices   # the device should show as "device" ("unauthorized" / "offline" = not approved / not connected)
```

If several devices (real or emulator) are connected, `install*` tasks can stop; pick one:

```sh
ANDROID_SERIAL=<serial from adb devices> npm run install:android-native:release
```

Debug build:

```sh
npm run install:android-native          # = cd android-native && ./gradlew installDebug
```

To only produce an APK (for `adb install` or manual transfer):

```sh
cd android-native && ./gradlew assembleDebug
# Output: android-native/app/build/outputs/apk/debug/app-debug.apk
```

Release build:

```sh
npm run install:android-native:release          # install over the existing app (keeps synced songs and DB)
npm run install:android-native:release:clean    # uninstall first, then install (synced songs and DB are removed)
npm run build:android-native                    # only build the APK
# Output: android-native/app/build/outputs/apk/release/app-release.apk
```

- **An APK signed with a different key can't be installed over the existing one**
  (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). Use `:clean` when switching between a debug and a release build.
  Synced songs and the DB are removed, so you re-sync from the Mac
- Without a release key configured, the release build is an unsigned APK that can't be installed as is

### Release key (once per machine)

The keystore (`*.jks`) and `local.properties` are both gitignored and never enter the repository.

```sh
keytool -genkeypair -v -keystore android-native/keystore/voynix-release.jks \
  -alias <alias> -keyalg RSA -keysize 2048 -validity 10000
```

Put these four keys in `android-native/local.properties` (`storeFile` is relative to `android-native/`):

```properties
voynix.release.storeFile=keystore/voynix-release.jks
voynix.release.storePassword=...
voynix.release.keyAlias=...
voynix.release.keyPassword=...
```

If you lose the key you can no longer publish updates signed with the same key, so keep a backup elsewhere.
To attach the signed APK to a GitHub Release, see "Versioning and releases" in
[docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md).

### Over Wi-Fi (no USB)

```sh
npm run adb:pair -- [<IP:pairing port>] <pairing code>              # first time only
npm run install:android-native:wifi -- [<IP:port>] [debug|release]  # defaults to release
```

Turn on "Wireless debugging" under Developer options. If you omit `<IP:port>`, the script discovers it
over mDNS (`adb mdns services`). The pairing port and the main connection port are different. Depending on
the network and macOS's "Local Network" permission, mDNS or `adb connect` may not work; use USB then.

## Troubleshooting

- **Gradle fails with `IllegalArgumentException: 25.0.3`** (or similar): Kotlin can't parse the version of
  the JDK used from the terminal (for example JDK 25, such as the JBR bundled with Android Studio).
  Install JDK 21 (`brew install openjdk@21`) and set
  `org.gradle.java.home=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home` in
  `~/.gradle/gradle.properties` (the path is for Homebrew on Apple Silicon)
- **`adb` stays at `waiting for device`**: the device isn't recognized. Check the cable, USB debugging,
  and the approval dialog on the device
- **Viewing logs**: `adb logcat | grep -iE "Voynix"` (playback and sync logs use the `VoynixPlayback` tag)

## Android Auto

A debug build installed with `./gradlew installDebug` or a sideloaded APK won't appear in Android Auto's
app list unless "Unknown sources" is enabled there. For how to enable it, see
[Using Android Auto](../README.md#using-android-auto) in the root README. If "Voynix" still doesn't
appear, these help:

```sh
# Does the OS see it as a media browser?
adb shell pm query-services -a android.media.browse.MediaBrowserService --components

# Is the playback session registered?
adb shell dumpsys media_session | grep -i voynix

# Why Android Auto rejects it while connected (signature / unknown sources, etc.)
adb logcat | grep -iE "gearhead|CAR\.|MediaApp"
```

### Verifying with the Desktop Head Unit (DHU)

DHU is the official test tool for projected Android Auto (the old Media Browser / Messaging simulators
are discontinued)
([Test Android apps for cars](https://developer.android.com/training/cars/testing)).

```sh
# If not installed yet (use the beta channel: stable stays at 2.0)
android sdk install --beta "extras;google;auto@2.1.0"

# With the device connected over USB
npm run auto:dhu
```

`npm run auto:dhu` (`scripts/dhu.mjs`) checks `adb devices`, runs `adb forward tcp:5277 tcp:5277`, and
starts the DHU. Beforehand, in the Android Auto app on the device, open Developer settings and tap
"Start head unit server" (see [Using Android Auto](../README.md#using-android-auto) for how to reveal
Developer settings).

Use **DHU 2.1** from the beta channel: stable 2.0 doesn't complete the handshake with the Android Auto
app on a real device. The browse tree, tap-to-play, cover art / title display, and pause from the Auto
side were all verified working on a Pixel 8 Pro with Android Auto 17.6. Set "Application mode" to
"Developer" in Android Auto's Developer settings first (the item doesn't appear until you do).

## Testing

```sh
./gradlew testDebugUnitTest
```

Beyond the logic layer (queue / playback / search / sort / sync diff / stats merge), tests run on the JVM
without an emulator: Room DAOs (`tracks` / `playlists` / `play_events` / `settings` / `album_covers`) on
Robolectric, `SyncApi` against MockWebServer (ping, 503 retry for the manifest, download resume / 416,
integrity verification, album-art fetch), and `PlayerController` against a Mockito-mocked `Player` (queue
advance, shuffle, repeat, recording play counts).

Rules shared with the Mac app (album-art key, content hash, natural sort, pairing QR) are pinned by test
vectors in [`docs/test-vectors/`](../docs/test-vectors/) and verified on both the Rust and Kotlin sides.

## Known limitations

- Pairing supports scanning the Mac's QR code (recommended), mDNS discovery, and manual entry. The QR code
  contains the certificate fingerprint, so it is checked automatically. With mDNS and manual entry the TLS
  certificate can't be verified out of band, so compare the fingerprint (Security code) shown while
  pairing with the one on the Mac by eye
- Sync is HTTPS-only, with a self-signed certificate and SPKI pinning (TOFU)
- Auto Backup and device-to-device transfer are disabled (the pairing token must not follow the data to another
  device), so after changing phones, pair again and re-sync
