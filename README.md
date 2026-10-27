# Voynix

English | [日本語](./README.ja.md)

📖 **[User manual](https://tekapo.github.io/voynix/en/)** — installation, sync, Android Auto, FAQ

## TL;DR

Voynix is a local-first music player for Mac and Android.

- Syncs your Mac library to Android over Wi-Fi; play history and favorites sync back too
- Supports Android Auto

## Features

- **Playback**: Scans local music files (mp3, m4a, flac) and organizes them into a library (artists, albums, playlists), with gapless playback on both Mac and Android
- **Playlists**: Regular and smart playlists (smart playlists are created on Mac and sync to Android as regular playlists)
- **Editing track info**: Edit titles and tags per track, album, or artist
- **Podcasts**: Playback speed, ±10-second skip, and optional exclusion from shuffle
- **Lyrics**: View lyrics for the playing track on Mac and Android (looked up online from LRCLIB when you open the lyrics view)
- **Themes (Mac)**: System, Light or Dark, chosen in Settings → General
- **Sync to Android**: Mirrors the playlists and Library lists you mark for sync to Android devices on the same Wi-Fi network; play history and favorites sync both ways
- **Android Auto**: Browse and play your library and playlists from the car head unit
- **Now playing source (Android)**: Shows which playlist, artist, album or library list the queue is playing from, in the Now Playing screen, the mini player and Android Auto

## Requirements

- **Mac**: macOS (the distributed DMG is Apple Silicon (arm64) only)
- **Android**: Android 8.0 (API 26) or later; Android Auto is optional
- Sync requires the Mac and the Android device to be on the same Wi-Fi network

## Installation

Download the Mac `.dmg` or the Android `.apk` from [Releases](https://github.com/tekapo/voynix/releases).

**Android testers wanted:** Voynix is in a closed test on Google Play. If you have an Android phone and a Mac and can stay enrolled for 14 days, [sign up here](https://forms.gle/xiyXpZgHMHdR313h8).

> [!WARNING]
> **Mac:** the app is not signed or notarized by Apple, so macOS blocks it on first launch. Press "Done" (not
> "Move to Trash"), then open System Settings → Privacy & Security and click **"Open Anyway"** next to the
> Voynix message. Or run `xattr -cr /Applications/Voynix.app` in Terminal and open the app again.
>
> **Android:** the APK from Releases is installed outside Google Play. If Android's **Advanced Protection** is on,
> installing it (including via Obtainium) is blocked with "restricted by Advanced Protection". Turn it off
> in Settings → Security & privacy → Advanced Protection before installing. You also need to allow "Install unknown apps" for the app you
> install from (browser, file manager or Obtainium). The same applies to **updates**: with Advanced Protection on,
> Android refuses to let Obtainium install apps (you can't turn on "Allow from this source" for it), so turn it off for each update too
> (you can turn it back on afterwards).
>
> None of this applies if you install from Google Play as a closed-test tester: Advanced Protection can stay on, and Play updates the app for you.

**Install with Homebrew (Mac, Apple Silicon):**

```sh
brew install --cask tekapo/voynix/voynix
```

The cask removes the quarantine flag after installing, so the Gatekeeper warning above does not appear.
The Mac app also checks for updates at launch and offers to update itself (Settings → General turns it off). Or upgrade with `brew update && brew upgrade --cask voynix` (`brew update` first, or a just-released version may not show up yet). If Homebrew 7 refuses to load the cask because the tap is untrusted,
run `brew trust tekapo/voynix` once.

On Android you can get automatic updates with [Obtainium](https://obtainium.imranr.dev/) by adding
`https://github.com/tekapo/voynix`.

See the [user manual](https://tekapo.github.io/voynix/en/) for details, including how to add music, sync with
Android, and set up Android Auto.

## Quick start

Install the app first (see [Installation](#installation)). Details for each step are in the [user manual](https://tekapo.github.io/voynix/en/).

### Mac

1. Launch Voynix.
2. In the sidebar, choose **+ New → Add Music Folder…** and pick your music folder. Scanning starts right away.
3. Right-click each playlist (or a Library item such as All Songs) you want on your phone and choose **Sync to Device**. A sync mark appears next to it. If nothing is marked, Android receives no songs.
4. Click the sync button at the bottom of the sidebar (next to **+ New**) to show the QR code. By default the sync server starts automatically when Voynix launches (Settings → Sync → "Start sync server automatically").

### Android

1. Install the app (the APK, or Google Play if you are a closed-test tester) and open it. Allow notifications if asked.
2. Connect to the same Wi-Fi network as the Mac, open **Settings → Wi-Fi Sync**, and scan the QR code shown on the Mac.
3. The marked songs, playlists, play history and favorites are imported. After that, tap **Sync now**, or let it sync automatically about every 6 hours on the Mac's Wi-Fi.

### Android Auto

If you installed the APK from outside Google Play, Android Auto hides the app until you enable "Unknown sources" (one time only). If you installed from Google Play as a closed-test tester, skip this section.

1. Open the Android Auto app on the phone, go to Settings, and tap "Version" at the bottom about 10 times.
2. Go back, open the menu (≡) at the top left, and choose **Developer settings**. Turn on **Unknown sources**.
3. Force-stop Android Auto (or restart the phone) and reconnect to the car. Voynix now appears in the app list.

See the [Android Auto section of the manual](https://tekapo.github.io/voynix/en/#auto) and [android-native/README.md](./android-native/README.md) for troubleshooting.

## Documentation

- [User manual](https://tekapo.github.io/voynix/en/) (usage, Wi-Fi sync, Android Auto, keyboard shortcuts, backup, FAQ and known limitations)
- [Privacy policy](https://tekapo.github.io/voynix/en/privacy.html)
- [Echo playback over your LAN](./docs/echo-lan.md): optional, advanced — play Voynix playlists on an Echo through your own Alexa skill, without exposing anything to the internet
- [CHANGELOG.md](./docs/CHANGELOG.md): changes in each version
- [SECURITY.md](./SECURITY.md): how to report a vulnerability
- [Homebrew tap](https://github.com/tekapo/homebrew-voynix): the cask for `brew install --cask tekapo/voynix/voynix`

## Support

Voynix is free and open source. If you find it useful, you can support its development on [Ko-fi](https://ko-fi.com/tekapo).

## For developers

For build instructions and development commands, see [DEVELOPMENT.md](./docs/DEVELOPMENT.md) (Mac) and
[android-native/README.md](./android-native/README.md) (Android).

## License

MIT License. See [LICENSE](./LICENSE) for details.
For third-party assets such as bundled fonts and icons, see
[THIRD_PARTY_NOTICES.md](./docs/THIRD_PARTY_NOTICES.md).
