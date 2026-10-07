# Changelog

Version history of Voynix, newest first.

The version number is bumped with `npm run version:bump -- <patch|minor|major|x.y.z>`
(`scripts/bump-version.mjs`), which updates package.json / package-lock.json /
src-tauri/tauri.conf.json / src-tauri/Cargo.toml / src-tauri/Cargo.lock /
android-native/app/build.gradle.kts in one go.

**Rule**: after bumping the version and committing, add one entry at the top of this file
(`## <version> — <YYYY-MM-DD>` followed by 1–3 bullets), written in English.

## 0.22.15 — 2026-10-07
- Removed the `android.hardware.type.automotive` uses-feature from the Android manifest, which Google Play rejects together with the Android Auto `com.google.android.gms.car.application` metadata (#39). Android Auto support is unchanged.

## 0.22.14 — 2026-10-07
- Added `npm run build:android-aab`, which builds the signed release App Bundle for Google Play (#39). The site also gained a privacy policy page.

## 0.22.13 — 2026-10-07
- Fixed a flaky Android unit test (`DecodeSampledTest`) that ran out of memory on CI by decoding a 2048 px bitmap instead of 4096 px. No app changes.

## 0.22.12 — 2026-10-07
- The Mac app can now be installed with Homebrew (`brew install --cask tekapo/voynix/voynix`); `npm run release` updates the cask in the tekapo/homebrew-voynix tap (`npm run release:cask`).

## 0.22.11 — 2026-10-07
- Release to verify Obtainium updates over the installed APK (#26). README and the manual now warn about macOS Gatekeeper and Android Advanced Protection blocking installs.

## 0.22.10 — 2026-10-06
- macOS: the app bundle is now ad-hoc signed as a whole (`signingIdentity: "-"`), so a downloaded DMG no longer shows "Voynix.app is damaged" (previously only a linker signature with no sealed resources). README and the manual mention `xattr -cr` as a fallback.

## 0.22.9 — 2026-10-06
- `npm run release` now also waits for the Build macOS workflow and attaches the locally built, signed Android APK to the Release (`-- --no-android` pushes the tag only).

## 0.22.8 — 2026-10-06
- Android decodes album and artist art downsampled to about 1024 px on the long edge (bounds pass + `inSampleSize`) instead of at full size, cutting memory use and list-scroll jank with large embedded images (#22).

## 0.22.7 — 2026-10-06
- Android sync now checks free space before downloading (tracks to fetch minus bytes already in `.part` files, plus a 50 MB margin) and stops early with a clear message; a full disk is refused instead of treated as unknown (#18).
- Make parallel track downloads safe: one download per track key (no shared `.part` file) and thread-safe progress counters and error list (#19).
- Raise the web tests' `waitFor` timeout from 1 s to 5 s so playback-state assertions stop flaking on loaded CI runners (#32).

## 0.22.6 — 2026-10-06
- Write cached album art, lyrics and the `.miss` markers atomically (temp file + rename), so a concurrent request or an app exit mid-write can no longer leave a truncated file that counts as a permanent cache hit (#20).

## 0.22.5 — 2026-10-06
- Fix the Android Wi-Fi Sync screen hiding the pairing progress and error when they fell below the screen edge (it now scrolls, and the status is shown at the top). The "can't connect" message now names the host and the same-Wi-Fi requirement, in English and Japanese (#17).
- Add a hard call timeout to the pairing probes so an unreachable Mac can't leave the spinner running.

## 0.22.4 — 2026-10-06
- Add a "User manual" link to the About screen on Mac (Settings → About) and Android (Settings), opening the English or Japanese manual site to match the app language (#23).
- Make the Android settings screen scrollable so the bottom rows are no longer cut off on large displays or font sizes.

## 0.22.3 — 2026-10-06
- Update Tauri to 2.12 and the dialog / fs / opener / sql plugins (Rust and npm sides together). Drops the old `kuchikiki` → `rand` 0.7.3 build-time dependency flagged by Dependabot

## 0.22.2 — 2026-10-06
- Update the `rand` 0.8 dependency to 0.8.8 (Cargo.lock only) to address a Dependabot advisory

## 0.22.1 — 2026-10-06
- Upgrade the test toolchain to vitest 5 (resolves the open Dependabot alerts for vitest, @vitest/mocker and tinypool)
- Run CI on Node 26, which the `node:sqlite`-based tests need under vitest 5

## 0.22.0 — 2026-10-05
- First public release. A local-first music player for Mac (Tauri) and Android (Kotlin + Jetpack Compose). Supports gapless playback, smart playlists, podcasts, Wi-Fi sync (pairing via QR code), Android Auto, and a home-screen widget
- License notices for dependencies are now generated automatically and viewable in the apps (Mac: Settings → About, Android: Settings)

---

## Development history before the public release (0.1.0–0.21.0)

A summary of the pre-release record, grouped by feature. Dates are in 2026.

### 0.19.0–0.21.0 (10/5) Release preparation
- Added QR-code pairing to Wi-Fi sync (the Mac shows a QR code and Android scans it; the QR also pins the certificate fingerprint, so there is no need to confirm the security code, and it works where mDNS doesn't)
- Automated generation of dependency license notices (`npm run licenses:generate`); silenced the chunk-size warning at build time

### 0.15.0–0.18.5 (9/28–10/5)
- Android Auto: podcast playback position and "unplayed" marker, artist/album lists of more than 20 entries are split into initial-letter folders, fixed the resume position after playing a whole album
- Sync: Android's sync screen shows the real connection state (connected / checking / can't connect / re-pairing needed), the Mac follows network changes, fixed a crash on full-width input during manual pairing, "Sync with device" from the right-click menu of a sidebar library item
- Album-cover search (iTunes + Deezer), backups in ZIP format that bundle artist images and album covers, backup/import of playlists, music folders, and settings
- Podcasts shown as "10:23 / 1:30:30", repeat-one shown with a large "1" badge, cover mosaic in Android collection details, previous/next buttons on the mini player, saving and restoring the play queue
- Desktop: fixed MP3s with broken ID3v2.2 tags not playing, and a stale track from the gapless look-ahead sounding first after a queue change. Added scripts for adb pairing/installing over Wi-Fi

### 0.14.0–0.14.1 (9/28) Localization
- The Mac and Android UIs support English and Japanese. The default follows the OS/device language and can be switched in settings (on Android 13+, the system per-app language setting also works)

### 0.13.0–0.13.19 (9/27) Quality improvements
- Replaced the track-ID hash with one that won't change with future Rust updates, restricted the permissions of `key.pem`, unified search normalization to NFKC (full-width/half-width variants), and grouped tracks without an album tag by their parent folder name
- Pinned the album-art key, content hash, and natural-sort rules shared by Mac and Android in shared test vectors (`docs/test-vectors/`), verified on both Rust and Kotlin
- Internal refactoring that split out hooks around the play queue and Tauri events (including a bug where adding after removing from the queue played a different track). Durations over an hour are shown as `h:mm:ss`

### 0.12.0–0.12.3 (9/27) Android widget
- Added a home-screen playback-control widget (Jetpack Glance): title, artist, artwork, play/pause, previous, next, and resizing. Playback can resume from the last position after the app is closed

### 0.11.0–0.11.19 (9/25–9/26) Gapless playback and release infrastructure
- Gapless playback (Mac: a Rust engine with rodio + symphonia; Android: ExoPlayer's look-ahead queue). The silence between m4a/ALAC tracks is trimmed by reading `iTunSMPB`
- macOS builds and automatic GitHub Release creation on GitHub Actions (actions pinned by commit SHA), `npm run release`
- Android: release signing, code and resource shrinking with R8 (APK about 16.9 MB → about 3.0 MB), `install:android-native:release` installs over the existing app (keeping synced data)
- Android Auto: automatic resume after the engine has been off for over 10 minutes, persistence of shuffle/repeat, restoring the previous playlist on resume
- Fixed rows for files removed by a library rescan staying in the library, placeholders in the album list, separate app IDs for development and production builds

### 0.10.0–0.10.3 (9/24) Smart playlists
- Added smart playlists that collect tracks automatically by conditions (genre, artist, play count, date added, favorites, play state, and more) (Mac; "Sync to Device" syncs the evaluated track list to Android as a regular playlist)
- Tidied the sidebar (the "＋ New" menu, a one-line footer) and fixed misplaced right-click menus

### 0.9.0–0.9.41 (9/14–9/24) Android app, sync, and podcasts
- **Added the native Android app (Kotlin + Compose)**: Room DB, ExoPlayer playback, library browsing and playlists, MediaSession and notifications, a Wi-Fi sync client, album art and lyrics
- Sync: TLS for LAN sync (self-signed certificate + SPKI pinning), background auto-sync about once an hour (WorkManager, with a charging-only option)
- Android Auto support (verified with Desktop Head Unit 2.1): shuffle/repeat/podcast ±10-second buttons, home items and icons
- Podcasts: playback speed (0.8–2.0x), sleep timer, played markers, exclusion from shuffle. Android: cross-library search on Home, Recently Added / Recently Played, a "Now Playing" jump in track lists
- Mac: Get Info (tag editing, bulk album editing), automatic artist-image fetching (Deezer), keyboard shortcuts, Dock menu, two-pane artist/album lists, virtualized track lists, tabbed settings modal, right-click menu for multiple selections, per-folder rescan, drag-and-drop reordering of podcasts

### 0.1.0–0.8.0 (9/9–9/14) Initial implementation
- The initial implementation of the Mac music player with Tauri + React + TypeScript, and early UI tuning
