# Changelog

Version history of Voynix, newest first.

The version number is bumped with `npm run version:bump -- <patch|minor|major|x.y.z>`
(`scripts/bump-version.mjs`), which updates package.json / package-lock.json /
src-tauri/tauri.conf.json / src-tauri/Cargo.toml / src-tauri/Cargo.lock /
android-native/app/build.gradle.kts in one go.

**Rule**: when you bump the version, add one entry at the top of this file
(`## <version> — <YYYY-MM-DD>` followed by 1–3 bullets), written in English, and commit it together with the bump.

## 0.42.2 — 2026-11-12

- Android Auto: the playback screen ignored the queue title, so while the phone is projecting, the artist line now reads "Artist · Source" (the playlist, artist, album or library list the queue came from).

## 0.42.1 — 2026-11-12

- Mac: the Dock menu's Thumbs Up / Thumbs Down items now show 👍 / 👎 in front of the label.

## 0.42.0 — 2026-11-11

- Mac: the Dock right-click menu now has Thumbs Up and Thumbs Down for the playing track, with a checkmark for the current rating (disabled when nothing is loaded).

## 0.41.2 — 2026-11-11

- Mac: restoring a backup now refuses an archive with an oversized entry (over 50 MB, or 500 MB in total) instead of freezing the app, and only reads `backup.json` and the cover images from it.
- Mac: failures of the player's stop / pause / seek / volume / next-track commands are now logged to the console instead of being silently dropped.

## 0.41.1 — 2026-11-11

- Mac: harden the online cover and lyrics lookups: responses are size-capped, redirects only go to the lookup services and their image CDNs, and iTunes covers must decode as images before they are cached or synced.
- Mac: "Show in Finder" refuses non-absolute paths.

## 0.41.0 — 2026-11-11

- Mac: an empty playlist now shows an "Add Songs" button in its header; it opens a searchable list where you tick the songs to add (not offered for smart playlists).
- Mac: All Songs, Favorites, Most Played, Recently Added and Recently Played show their song count and total time next to the title; times of an hour or more read "1 hr 32 min" everywhere.

## 0.40.0 — 2026-11-10

- Mac: a playlist, artist or album now opens with a header above its tracks: cover (a mosaic of up to four albums, a single cover, or a round artist photo), title, song count and time, and Play / Shuffle buttons. It scrolls away with the list.
- Android: the collection header gets a bigger cover, a bolder title, a flat background and 12 dp buttons to match.

## 0.39.7 — 2026-11-10

- Android: the cover placeholder for a track with no artist tag now shows the title's initial, matching the Mac (it used the album name before).

## 0.39.6 — 2026-11-09

- The sync server no longer spins a CPU core when accepting connections fails (e.g. out of file descriptors); it backs off for 100 ms like the Echo server.

## 0.39.5 — 2026-11-09

- After adding a folder, rescanning, or importing an iTunes XML, covers missing from the files are now fetched online (iTunes) in the background, so the Albums grid fills in without playing each album first.

## 0.39.4 — 2026-11-09

- The update dialog now has a "View release notes" link that opens the release page for that version.

## 0.39.3 — 2026-11-09

- Fix keyboard and update-dialog issues: Enter on a row's thumbs button no longer plays the row, stacked dialogs no longer fight over Tab, a failed install keeps the update dialog open with the reason and a retry, "Check for updates" is ignored mid-download, and turning off auto-check is honoured even when startup is slow.
- Fix the player bar showing a stale thumbs-down after a rating syncs in; incoming ratings are normalised so a track is never both thumbs-up and thumbs-down.

## 0.39.2 — 2026-11-09

- User manual and READMEs now describe thumbs up/down ratings and the "hide thumbs-down songs" setting; leftover star wording is gone.
- Smart playlist conditions and the album info count now say "Thumbs up" instead of "Favorite"; unused star strings removed.

## 0.39.1 — 2026-11-09

- The track list header, sidebar Favorites entry and album info now use thumbs-up/down icons instead of the old star.
- Settings: the Echo tab buttons and the sync server's Stop/Close buttons now look like buttons (bordered) instead of plain text. Same for the Welcome "manual" link, the album-cover / artist-image Search buttons and the smart playlist "Add condition" button.

## 0.39.0 — 2026-11-09

- Thumbs up / thumbs down on every track (Mac and Android) replaces the favorite star: thumbs up is the old favorite, thumbs down is new, and the two are mutually exclusive. The rating syncs both ways (last write wins).
- New setting "Hide thumbs-down songs from auto lists" (on by default, separate on Mac and Android): Most Played, Recently Added and Recently Played skip thumbs-down songs, including on Android Auto and in what the Mac syncs to the phone.

## 0.38.2 — 2026-11-09

- Remove the experimental Bluetooth sync (0.38.0/0.38.1): over BLE it ran at about 1 KB/s, too slow even for metadata only. Sync works over Wi-Fi and tethering as before.

## 0.38.1 — 2026-11-09
- Bluetooth sync fix: the Mac now answers the phone's channel-info read itself (instead of a cached value) and the phone keeps its GATT link open until the tunnel closes, so CoreBluetooth can attach the incoming L2CAP channel to the phone.
- The Mac writes a small log of Bluetooth sync to `~/Library/Logs/Voynix-bluetooth.log`.

## 0.38.0 — 2026-11-09
- Bluetooth sync (experimental, off by default): with "Allow sync over Bluetooth" on in the Mac app and "Sync over Bluetooth" on in the Android app (Android 12+), a manual sync falls back to a direct Bluetooth (BLE L2CAP) link when the Mac can't be reached on the network. It carries metadata only unless "Include song files over Bluetooth" is on.
- The sync server's connection handler now works over any byte stream, not just TCP.

## 0.37.1 — 2026-11-09
- Android: the periodic auto-sync no longer runs as a foreground service, so the "Syncing with Mac" notification and the dataSync foreground-service permission are gone (Play only accepts that type for user-started work). An interrupted run resumes from its partial downloads on the next hourly check.

## 0.37.0 — 2026-11-09
- Android: new "Sync song files" switch on the sync screen (on by default). When off, a sync only brings playlists, play history, favorites and podcast positions; no song file is downloaded or deleted, and the result notes how many songs were left for the next sync with files.

## 0.36.0 — 2026-11-06
- Self-update: the app now re-checks for updates every 6 hours while it is open (besides at launch). A background check no longer pops up the dialog; it shows a "Voynix X.Y.Z available" notice at the bottom left of the sidebar, which opens the update dialog when clicked and can be dismissed with ×.

## 0.35.6 — 2026-11-06
- Hardening from the security audit: the sync TLS key file is created owner-only (0600) from the start; the Echo `/play` server now caps concurrent connections like the sync server; stats pushed from a phone have length limits on track keys and play states.
- The Echo skill's Lambda now has a lockfile and CI uses `npm ci`; added Dependabot version updates (monthly, grouped) for GitHub Actions and the Lambda.

## 0.35.5 — 2026-11-05
- Security: mDNS pairing now refuses to hand out the token unless the phone reports the same TLS key the Mac presented (a relay on the LAN can no longer obtain it). This needs both the Mac and Android apps updated for mDNS auto-pairing; QR and manual pairing and already-paired phones are unaffected.
- Security (Android): a track key from the Mac's manifest can no longer point a download or a delete outside the sync folder; unsafe keys are ignored.

## 0.35.4 — 2026-11-05
- macOS: fix the last played track and position not being restored on launch; it is now armed in the player bar (not playing), and ▶ resumes from the saved position.
- Added tests for cold-start restore, skipping unplayable tracks and playback-cursor saving.

## 0.35.3 — 2026-11-05
- Internal refactor, no visual change: `App.css` was split into 16 files under `src/styles/` (base, sidebar, header, track list, player bar, modals, responsive, …), imported in the original order so the cascade is unchanged; the built CSS is byte-identical.

## 0.35.2 — 2026-11-05
- Internal refactor, no behaviour change: the Rust `lib.rs` was split into `identity.rs` (track key / content hash / cloud-placeholder check), `tags.rs` (tag and cover read/write) and `scan.rs` (library scan and iTunes import).
- Added a test that every command the UI invokes by name is registered in `generate_handler!`, so a rename or module move can't silently drop one.

## 0.35.1 — 2026-11-05
- Internal refactor, no behaviour change: App.tsx's artwork/tag actions, language/theme handling and track/playlist toggles moved into `useArtworkActions`, `useAppearance` and `usePlaylistActions`; the Settings dialog was split into one component per tab.
- Added tests for those hooks and for every Settings tab (55 + 21 new tests).

## 0.35.0 — 2026-11-05
- macOS: the Settings dialog now has a fixed size with the tabs in a left column, so the title, tabs and Close button no longer shift when switching tabs; only the right-hand content scrolls.
- Up/Down arrow keys move between Settings tabs; on narrow windows the tabs go back to a row on top.

## 0.34.2 — 2026-11-05
- macOS: after a self-update the app now relaunches through `open`, so the new window comes to the front instead of opening behind other apps (takes effect for updates made from this version on).

## 0.34.1 — 2026-11-05
- Android: fixed a crash when pressing Next from the third track onward (the media session was paired with a mismatched timeline since 0.32.1).

## 0.34.0 — 2026-11-05
- macOS: the track list, sidebar, library lists, context menus and dialogs now work with the keyboard and screen readers (arrow keys, Enter, menu key, focus handling, roles and labels, and status messages are announced).
- Android: the switch rows in Settings and Sync are a single TalkBack stop announced as a switch.

## 0.33.0 — 2026-11-05
- macOS: the Help menu is no longer empty. It now has User Manual, Show Welcome Guide and Report an Issue (opens the GitHub issue templates).

## 0.32.1 — 2026-11-05
- Android / Android Auto: the queue shown by the media session now lists the real play queue in play order (a window of up to 200 entries around the current track) instead of only "now playing + next", and picking an entry from it jumps to that track.
- Playback itself is unchanged: ExoPlayer still holds only the current and next track, so gapless hand-off is untouched.

## 0.32.0 — 2026-11-05
- Settings > About now shows the library totals (tracks, artists, albums), unaffected by search or the current view.

## 0.31.0 — 2026-11-05
- A track with no cover now shows its artist's image, then the artist's initial on a colored tile, instead of a music-note icon: Mac player bar, album grid and info dialogs, and Android track rows, mini player and Now Playing.
- Notifications, Android Auto and the widget still show only the album's own art.

## 0.30.6 — 2026-11-05
- Fixed a race where the "arm the view's first track" effect could replace a track the user had just asked to play while it was still loading, so playback never started.
- Tests: raised the Vitest test timeout above the waitFor timeout so a stuck assertion reports its own error (this removes the flaky `App.stats.test.tsx` timeout).

## 0.30.5 — 2026-11-05
- macOS: removed "Support on Ko-fi" from the app menu; "About Voynix" now opens Settings on the About tab, which has the Ko-fi button.

## 0.30.4 — 2026-11-05
- Settings > About: the four buttons are now laid out as an equal-width two-column grid instead of ragged inline buttons.

## 0.30.3 — 2026-11-05
- macOS: added "Support on Ko-fi" (Japanese: 作者にコーヒーをおごる) to the Voynix app menu, right below About.

## 0.30.2 — 2026-11-05
- macOS: the menu bar (About, Hide, Quit, File, Edit, View, Window, Help) now follows the UI language instead of always showing English.

## 0.30.1 — 2026-11-05
- Settings: action buttons (Check for Updates, Add Folder, Rescan, backup, etc.) now have a visible fill and border instead of looking like plain text until hovered.
- Japanese: the Ko-fi link label is now "作者にコーヒーをおごる".

## 0.30.0 — 2026-11-04
- Android sync: when the Mac moved and mDNS can't find it (e.g. the Mac joined the phone's hotspot on the road), "Sync now" and the connection check now probe the other hosts on the phone's own subnets. The pinned TLS key still decides who is the Mac, so the token never reaches other hosts. Background auto sync does not scan.
- Android sync: mDNS discovery now holds a Wi-Fi multicast lock while browsing. Docs explain syncing over tethering on hotel Wi-Fi.

## 0.29.2 — 2026-11-04
- Android Auto: fixed playback not resuming when the car starts. Engine-off usually stops playback with an audio-focus loss, which never wrote the "stopped by the car" marker, so the marker is now also written when the car projection drops (androidx.car.app CarConnection).

## 0.29.1 — 2026-11-04
- Moved "Check for Updates" from Settings → About to the bottom of Settings → General, next to the launch-time check toggle.

## 0.29.0 — 2026-11-04
- Added "Remove from Playlist" to the track right-click menu (single track and multi-selection) when viewing a regular playlist. The songs stay in the library.

## 0.28.0 — 2026-10-27
- The Mac app can now update itself: it checks GitHub Releases at launch (Settings → General turns this off, Settings → About has a manual check) and asks before downloading, installing and restarting.
- Release builds now publish a signed updater bundle and `latest.json` alongside the DMG.

## 0.27.3 — 2026-10-25
- The desktop track list's Time column can now be resized like the other columns (drag its left edge, double-click to reset). Its default width is now just wide enough for HH:MM:SS, leaving more room for the text columns.
- An in-progress podcast's "position / duration" text is truncated with an ellipsis when it doesn't fit; hover to see it in full.

## 0.27.2 — 2026-10-25
- The desktop track list's "Now playing" jump button now appears at the vertical center of the visible rows, for both the up and down directions.

## 0.27.1 — 2026-10-25
- Fixed the "Now playing" jump button in the desktop track list floating far above the player bar; it now sits the same distance from the player bar as it does from the header when pointing up.

## 0.27.0 — 2026-10-25
- Android now shows where the queue is playing from (a playlist, artist, album or library list): in the Now Playing app bar (tap to open that list), under the artist in the mini player, as a "Playing" chip on that list's app bar, and in Android Auto as a "Now playing" tile at the top of Home plus the playback screen's queue title.
- The collection header's play button now reflects only the list the queue was started from, not any list that happens to contain the current track.

## 0.26.2 — 2026-10-24
- The sync server now caps concurrent connections, the queue of incoming play stats (answers 503 so the phone retries later) and the paired-device list, and looks up files by track key through an index instead of scanning every track. One device can hold at most 16 connections, and the desktop app now checks for `afconvert` once instead of on every status poll.

## 0.26.1 — 2026-10-24
- Adding tracks to a playlist and drag-reordering now write in batches, so large folder scans and reorders are much faster; Android sync reuses one pinned TLS client and commits its metadata/stats merges in single transactions.
- The sync server now times out stalled TLS handshakes and closes open connections when stopped; the webview's file-system permission no longer allows writing anywhere (backup export still writes to the path picked in the save dialog). CI now also runs `tsc` and the Alexa skill tests.

## 0.26.0 — 2026-10-24
- Added a light theme for the desktop app. Choose System, Light or Dark in the new General tab of Settings (the language setting moved there too); System follows the macOS appearance.
- Context menus now use an inset, rounded highlight, and low-contrast text was darkened to meet 4.5:1 contrast. A higher-contrast palette is used when macOS Increase Contrast is on.

## 0.25.0 — 2026-10-24
- The Title, Artist and Album column widths in the desktop track list can now be changed by dragging the header dividers; double-click a divider to reset it. Widths are saved and included in backups.

## 0.24.5 — 2026-10-23
- A podcast marked as played now stays played until you mark it as unplayed by hand; re-listening no longer flips it back to unplayed or in-progress (Mac and Android).
- Re-listening a played episode still saves the resume position, which resets to 0 when it finishes.

## 0.24.4 — 2026-10-23
- Fixed Android Auto sometimes not resuming playback when the car restarts: the "car stopped it" marker is now written whenever playback was running just before the car disconnected, not only for a noisy-audio pause.
- A car resume that loses audio focus to the head unit right after starting is retried up to three times, and playback events are also written to `playback.log` in the app's external files dir for diagnosing real drives.

## 0.24.3 — 2026-10-23
- Fixed the "Now playing" jump button never showing when the playing track is scrolled above the visible track list: it is now rendered right below the sticky header. The position marker on the right edge is likewise moved to the top of the list so it is always visible.

## 0.24.2 — 2026-10-23
- Added the album cover to the macOS Now Playing display (Control Center): the cover shown in the player bar is passed to the OS once per track change, not on every update.

## 0.24.1 — 2026-10-23
- Fixed the Mac media keys (play/pause, next, previous) not reaching Voynix while music played, which sent them to a background browser tab instead: Voynix now registers with macOS Now Playing natively, so Control Center also shows the track and its position.

## 0.24.0 — 2026-10-20
- Added opt-in Echo (Alexa) playback over the LAN: a signed, LAN-only `/play` HTTPS endpoint (Settings → Echo) that an Echo fetches straight from the Mac, with split DNS so nothing is exposed to the internet; includes the Alexa skill (`alexa-skill/`), host setup scripts and `docs/echo-lan.md`.
- Playlist names are taught to Alexa through a copyable slot type ("Copy playlist names"), and queued next tracks are converted ahead for Echo.

## 0.23.1 — 2026-10-10
- Fixed playback stalling with a pause icon and 0:00 / 0:00 when a track's file is missing (e.g. a stale library row hit during shuffle): a failed load now rejects, and the player skips to the next track (up to 5 in a row).
- A missing gapless "next" file no longer flips the UI to paused while the current track keeps playing.

## 0.23.0 — 2026-10-09
- Added a first-launch welcome guide to the Mac and Android apps (#41). On the Mac it walks through adding a music folder and pairing with Android; on Android it explains Wi-Fi sync and opens the pairing screen. It shows once on a fresh install (never when a library or a paired Mac already exists) and can be reopened from Settings.

## 0.22.18 — 2026-10-09
- Added `npm run release:play`, which builds the signed AAB and uploads it to Google Play internal testing with Gradle Play Publisher, using this version's CHANGELOG entry as release notes (#39). `npm run release` now runs it at the end, and skips it when no Play service account key is configured (`--no-play` skips it too). Production releases are still promoted by hand in Play Console.

## 0.22.17 — 2026-10-09
- Added a "Support on Ko-fi" button to the Mac app's Settings → About tab (#40). The Android app deliberately has no donation link, because Google Play's payments policy restricts them.
- Added Ko-fi links to the README, the site footer and a GitHub Sponsor button (`.github/FUNDING.yml`).

## 0.22.16 — 2026-10-08
- Fixed Mac music playback going silent for good (until the app was restarted) after the audio output device disappeared, e.g. a Bluetooth speaker disconnecting or a monitor sleeping. The output now reopens on the current default device and resumes the track at the same position.
- Mac playback now also follows changes to the system default output device.

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
