# Voynix

English | [日本語](./README.ja.md)

A local-first music player that manages and plays your music library on a Mac, and syncs it over Wi-Fi
to an Android device (Android Auto supported) so you can take it with you.

## Features

- **Playback**: Scans local music files (mp3, m4a, flac) into a library (artists, albums, playlists). Gapless playback with no silence between tracks, on both Mac and Android
- **Playlists**: Regular playlists, plus smart playlists that automatically collect tracks by genre, artist, play count, date added, favorites, and more (create and edit on Mac only; they sync to Android as regular playlists). Most Played / Recently Added / Recently Played playlists are built in
- **Editing track info**: "Get Info…" lets you edit titles and tags per track, album, or artist. Artist images can be fetched automatically
- **Podcasts**: Playback speed (0.8–2.0x), ±10-second skip, and exclusion from shuffle
- **iTunes import**: Import playlists from an iTunes library XML
- **Usability**: Keyboard shortcuts and a Dock right-click menu
- **Sync to Android**: Automatically mirrors the library, playlists, play history, and favorites to Android devices on the same Wi-Fi network, with background auto-sync about every 6 hours
- **Android Auto**: Browse and play your library and playlists from the car head unit

## Requirements

- **Mac**: macOS (the distributed DMG is Apple Silicon (arm64) only)
- **Android**: Android 8.0 (API 26) or later; Android Auto is optional
- Sync requires the Mac and the Android device to be on the same Wi-Fi network

## Installation

### Mac

Download the `.dmg` from [Releases](https://github.com/tekapo/voynix/releases) and drag the app to
Applications. The app is not signed or notarized by Apple, so on first launch **right-click the app in
Finder and choose "Open"** (double-clicking may show a warning and refuse to open it).

### Android

Download `voynix-<version>.apk` from [Releases](https://github.com/tekapo/voynix/releases) and open it on
the device. Android asks you to allow installing apps from your browser or file manager ("Install unknown
apps") the first time.

To get updates automatically, add the repository to [Obtainium](https://obtainium.imranr.dev/): in
Obtainium choose "Add App", enter `https://github.com/tekapo/voynix`, and install. Obtainium picks the
`.apk` from each Release and notifies you when a new version is out.

The APK is not distributed through Google Play. You can also build it from source following
[android-native/README.md](./android-native/README.md).

For building the Mac app from source, see [DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## Usage

### Adding music (Mac)

In the sidebar, choose "＋ New" → "Add Music Folder…" and pick a folder to start scanning.
From Settings > Music Folders you can also rescan folders (Rescan All) and import an iTunes library
(Import iTunes Library…).

### Keyboard shortcuts (Mac)

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ← / → | Previous / next track (±10 seconds while playing a podcast) |
| ⌘F | Focus the search field |
| Escape | Clear focus |

### Syncing with Android

1. On the Mac, open the Sync screen and click "Start Server". A QR code is shown
2. On Android, open Settings → "Wi-Fi Sync" and scan the QR code (this uses Google's code scanner,
   so no camera permission is needed). The QR code contains the server certificate's fingerprint, so you
   don't need to verify the security code. You can also use automatic discovery of the Mac on the same
   Wi-Fi, or enter the URL and pairing code manually
3. Approve the prompt that appears on the Mac
4. Once approved, tracks, playlists, play history, and favorites are imported to Android. After that you
   can re-sync manually, and within Wi-Fi range it syncs automatically in the background about every 6
   hours (can be turned off, or limited to while charging, in the Android settings)
   - Tracks in formats Android can't play, such as ALAC, are converted on the Mac before being sent

On first launch, the Android app asks for the notification permission (Android 13 and later).

### Using Android Auto

When connected to a head unit, you can browse and play tracks, playlists, and podcasts from the home
screen. Shuffle/repeat and ±10-second skip for podcasts are supported.

Because the app is installed outside Google Play, it won't appear in Android Auto's app list unless
"Unknown sources" is enabled. This one-time setup is needed:

1. Open the Android Auto app on the phone
2. Go to Settings and tap "Version" at the bottom about 10 times (a message says you're now a developer)
3. Go back from the settings screen and open the menu (≡) at the top left; a "Developer settings" item has appeared
4. Developer settings → turn on "Unknown sources"
5. Force-stop Android Auto (or restart the phone) and reconnect to the car (or Auto over USB/Bluetooth)

"Voynix" should now appear in the list. If it doesn't, see
[android-native/README.md](./android-native/README.md) for detailed troubleshooting.

## Known limitations

- When pairing by manual entry, make sure the security code shown matches on both the Mac and Android
  (not needed when pairing with the QR code)
- Songs cannot be added or scanned directly on Android (it is a dedicated client that mirrors the Mac
  library)
- Android backup is disabled (the pairing token must not be restored on another device): after changing
  phones, pair again and sync
- Smart playlists can only be created and edited on the Mac

## Security

To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## Changelog

See [CHANGELOG.md](./docs/CHANGELOG.md) for changes in each version.

## For developers

For build instructions and development commands, see [DEVELOPMENT.md](./docs/DEVELOPMENT.md) (Mac) and
[android-native/README.md](./android-native/README.md) (Android).

## License

MIT License. See [LICENSE](./LICENSE) for details.
For third-party assets such as bundled fonts and icons, see
[THIRD_PARTY_NOTICES.md](./docs/THIRD_PARTY_NOTICES.md).
