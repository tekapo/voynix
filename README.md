# Voynix

English | [日本語](./README.ja.md)

📖 **[User manual](https://tekapo.github.io/voynix/)** — installation, sync, Android Auto, FAQ

## TL;DR

Voynix is a local-first music player for Mac and Android.

- Syncs your Mac library to Android over Wi-Fi; play history and favorites sync back too
- Supports Android Auto

## Features

- **Playback**: Scans local music files (mp3, m4a, flac) into a library (artists, albums, playlists), with gapless playback on both Mac and Android
- **Playlists**: Regular and smart playlists (smart playlists are created on Mac and sync to Android as regular playlists)
- **Editing track info**: Edit titles and tags per track, album, or artist
- **Podcasts**: Playback speed, ±10-second skip, and exclusion from shuffle
- **Sync to Android**: Mirrors the library, playlists, play history, and favorites to Android devices on the same Wi-Fi network
- **Android Auto**: Browse and play your library and playlists from the car head unit

## Requirements

- **Mac**: macOS (the distributed DMG is Apple Silicon (arm64) only)
- **Android**: Android 8.0 (API 26) or later; Android Auto is optional
- Sync requires the Mac and the Android device to be on the same Wi-Fi network

## Installation

Download the Mac `.dmg` or the Android `.apk` from [Releases](https://github.com/tekapo/voynix/releases).

> [!WARNING]
> **Mac:** the app is not signed or notarized by Apple, so macOS blocks it on first launch. Press "Done" (not
> "Move to Trash"), then open System Settings → Privacy & Security and click **"Open Anyway"** next to the
> Voynix message. Or run `xattr -cr /Applications/Voynix.app` in Terminal and open the app again.
>
> **Android:** the APK is not distributed through Google Play. If Android's **Advanced Protection** is on,
> installing it (including via Obtainium) is blocked with "restricted by Advanced Protection". Turn it off
> in Settings → Security & privacy before installing. You also need to allow "Install unknown apps" for the app you
> install from (browser, file manager or Obtainium). The same applies to **updates**: with Advanced Protection on,
> Android refuses to let Obtainium install apps, so turn it off for each update too (you can turn it back on afterwards).

**Install with Homebrew (Mac, Apple Silicon):**

```
brew install --cask tekapo/voynix/voynix
```

The cask removes the quarantine flag after installing, so the Gatekeeper warning above does not appear.
Upgrade with `brew upgrade --cask voynix`. If Homebrew 7 says it refuses to load the cask from an untrusted tap,
run `brew trust tekapo/voynix` once.

On Android you can get automatic updates with [Obtainium](https://obtainium.imranr.dev/) by adding
`https://github.com/tekapo/voynix`.

See the [user manual](https://tekapo.github.io/voynix/) for details, including how to add music, sync with
Android, and set up Android Auto.

## Documentation

- [User manual](https://tekapo.github.io/voynix/) (usage, Wi-Fi sync, Android Auto, keyboard shortcuts, backup, FAQ and known limitations)
- [Privacy policy](https://tekapo.github.io/voynix/en/privacy.html)
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
