# Developer documentation (Mac app)

English | [日本語](./DEVELOPMENT.ja.md)

Voynix is a music player that manages and plays a local music library on a Mac and syncs it over Wi-Fi to
Android. The Mac app is built with Tauri 2, React, and TypeScript (frontend) plus Rust (backend). For the
Android app (Kotlin + Jetpack Compose, `android-native/`), see
[android-native/README.md](../android-native/README.md).

## Architecture

- **Playback engine**: On Mac, a custom Rust engine (rodio + symphonia) pre-decodes the next track and
  joins tracks sample-accurately for gapless playback. The silence left between m4a/ALAC tracks is removed
  by reading `iTunSMPB` (the encoder's leading/trailing padding sample counts) and trimming it. Android
  uses ExoPlayer's playlist support to pre-queue the next track
- **Wi-Fi sync server**: The app embeds a sync server and pairs with Android devices on the same network.
  Traffic is protected by TLS (self-signed certificate + SPKI pinning). Pairing by scanning the QR code
  shown on the Mac (it contains the certificate fingerprint) is recommended. With mDNS discovery or manual
  entry of the URL and pairing code, you compare the security code (fingerprint) by eye on the Mac's
  approval screen before allowing the connection
- **Transcoding**: During sync, only ALAC (Apple Lossless) tracks, which Android can't play, are converted
  with macOS's built-in `afconvert` to AAC (256 kbps by default) or FLAC (a setting) before being sent.
  Results are cached and reused on later syncs. The extensions scanned are mp3, m4a, and flac

## Prerequisites

- **macOS** (the app is macOS-only; it relies on macOS features such as `afconvert` and the Dock menu)
- **Node.js 22** (the version CI uses): [download](https://nodejs.org/)
- **Rust**: install via [rustup](https://rustup.rs/)
- **Xcode Command Line Tools**:

  ```sh
  xcode-select --install
  ```

For Tauri builds in general, see also [Tauri's prerequisites](https://tauri.app/start/prerequisites/).

## Setup and development

Clone the repository and install dependencies:

```sh
npm ci
```

Run in development mode (frontend + Tauri backend):

```sh
npm run tauri:dev
```

The development build runs under a different app ID (`com.tekapo.voynix.dev`) and app name
("Voynix (Dev)") than the production build (`com.tekapo.voynix`), and keeps its app data (library,
playlists, and so on) in a separate directory. Installing the production build never mixes with your
development data.

Run only the frontend in the browser (handy for UI work):

```sh
npm run dev
```

## Build

```sh
npm run tauri build
```

## Testing

| Target | Command |
| --- | --- |
| Frontend (Vitest) | `npm test` (watch: `npm run test:watch`, coverage: `npm run test:coverage`) |
| Rust (backend) | `cd src-tauri && cargo test` |
| Android | `cd android-native && ./gradlew testDebugUnitTest` ([android-native/README.md](../android-native/README.md#testing)) |

All three run in CI (`.github/workflows/test.yml`) on every push to `main` and every pull request.

Rules shared by the Mac and Android apps (album-art key, content hash, natural sort, pairing QR) are pinned
by shared test vectors in [`docs/test-vectors/`](./test-vectors/) and verified on both the Rust and Kotlin
sides. When you change one of these rules, update the test vectors and both implementations together.

## Versioning and releases

### Version number

```sh
npm run version:bump -- <patch|minor|major|x.y.z>
```

`scripts/bump-version.mjs` updates `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `android-native/app/build.gradle.kts` (`versionName`,
and `versionCode` is bumped by 1) in one go. After bumping, add an entry at the top of
[CHANGELOG.md](./CHANGELOG.md): `## <version> — <YYYY-MM-DD>` followed by 1–3 bullets, in English.

### Regenerating license notices

After adding or updating a dependency, run `npm run licenses:generate` and commit the regenerated
`public/licenses.txt` and `android-native/app/src/main/assets/licenses.txt`
(`src/licenses.test.ts` catches direct dependencies that are missing).

### Building the macOS app on GitHub Actions

`.github/workflows/build-macos.yml` builds the macOS desktop app (Apple Silicon / arm64 only) on GitHub
Actions (`macos-latest`). The build is unsigned, so opening it triggers Gatekeeper's "cannot verify the
developer" warning (work around it with right-click → Open, or `xattr -cr`).

There are two triggers:

- **Tag push** (`v*`): `npm run release` creates and pushes a `v<version>` tag from the version in
  package.json (it stops with an error if the working tree isn't clean or the version files disagree)
- **Manual run**: pick the `Build macOS` workflow in the GitHub "Actions" tab and click "Run workflow"
  (no tag needed)

The artifacts (`.dmg` / `.app`) can be downloaded from the workflow run's Artifacts. A tag-push run
additionally creates a **published** Release on the GitHub "Releases" page with the `.dmg` attached
(release notes are generated from commits). A manual run has no tag, so it creates no Release and only
produces Artifacts.

### Attaching the Android APK to a Release

The APK is not built in CI. It is built on a local machine that holds the release key and attached to the
Release by hand, so the key never sits on GitHub. For preparing the release key, see
[android-native/README.md](../android-native/README.md#release-key-once-per-machine).

`npm run release` does all of it in one go: it pushes the tag, waits for the Build macOS workflow, attaches
the APK, then updates the Homebrew cask (use `-- --no-android` to push the tag only). To attach the APK on its own:

1. Push the `v<version>` tag (e.g. `npm run release -- --no-android`) and wait for the Build macOS workflow to
   create the Release
2. Run `npm run release:android`. It builds a signed APK with `assembleRelease` and attaches it to the
   Release as `voynix-<version>.apk` with `gh release upload` (overwriting an existing one). With
   `-- --dry-run` it only builds and skips the upload

You need to be logged in to the `gh` CLI. The script stops with an error if the release key
(`local.properties`) isn't configured.

### Homebrew cask

The Mac app is also installable with `brew install --cask tekapo/voynix/voynix` (Apple Silicon only). The cask
lives in the separate tap repository [`tekapo/homebrew-voynix`](https://github.com/tekapo/homebrew-voynix)
(`Casks/voynix.rb`). `npm run release` runs `npm run release:cask` at the end, which downloads the Release's
DMG and updates `version` and `sha256` in the cask through the GitHub API (`-- --dry-run` prints the result
without pushing). To run it on its own, the Release must already exist.

The app is not notarized, so the cask's `postflight_steps` block runs `xattr -dr com.apple.quarantine` on the
installed app. It uses the `{{appdir}}` path token (and lists the app in `writable_paths`, because the steps run in
a sandbox), which also keeps `brew style` happy. The legacy `postflight` block works too but prints a deprecation
warning on every install.

## Command reference

| Command | Description |
| --- | --- |
| `npm ci` | Install dependencies |
| `npm run tauri:dev` | Run in development mode (frontend + Tauri backend; app ID `com.tekapo.voynix.dev`) |
| `npm run dev` | Run only the frontend in the browser (for UI work) |
| `npm run tauri build` | Build the production app |
| `npm test` | Run tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage |
| `npm run licenses:generate` | Regenerate the dependency license notices |
| `npm run version:bump` | Update the version number (applied to both Mac and Android) |
| `npm run release` | Create and push the `v<version>` tag for the current version, wait for the macOS build on GitHub Actions, then attach the signed APK to the Release and update the Homebrew cask (`-- --no-android` pushes the tag only) |
| `npm run release:cask` | Update `version` / `sha256` of the cask in the `tekapo/homebrew-voynix` tap to the current version's DMG (run by `npm run release`; the Release must already exist) |
| `npm run build:android-aab` | Build the signed release App Bundle (`voynix-<version>.aab`) for Google Play and print its path. Upload it by hand in Play Console (not attached to the GitHub Release) |
| `npm run release:android` | Build the signed APK and attach it to the GitHub Release for the current version (the Release must already exist) |
| `npm run install:android-native` | Install the Android debug build on a device |
| `npm run build:android-native` | Build the Android release APK (signed, minified) |
| `npm run install:android-native:release` | Install the Android release build over the existing app |
| `npm run install:android-native:release:clean` | Same, but uninstall the existing app first |
| `npm run adb:pair` | Pair adb over Wi-Fi (first time only) |
| `npm run install:android-native:wifi` | Build and install the Android app over Wi-Fi |
| `npm run auto:dhu` | Start the Android Auto Desktop Head Unit (DHU) against a USB-connected device |

For details on the Android commands, see [android-native/README.md](../android-native/README.md).

## Recommended IDE setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
