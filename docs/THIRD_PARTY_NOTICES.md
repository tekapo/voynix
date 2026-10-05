# Third-party materials

English | [日本語](./THIRD_PARTY_NOTICES.ja.md)

The source code in this repository is under the [LICENSE](../LICENSE) (MIT), but the fonts and icons
bundled with it are distributed under their own licenses, listed below.

## Dependencies

Copyright notices and license texts for the Rust, npm, and Android (Gradle) dependencies are generated
automatically by `npm run licenses:generate` (`scripts/generate-licenses.mjs`) and shown in the apps under
"Open source licenses".

- Mac: `public/licenses.txt` (shown from Settings → About)
- Android: `android-native/app/src/main/assets/licenses.txt` (Settings → Open source licenses)

## Outfit font

- File: `public/fonts/outfit.woff2`
- License: [SIL Open Font License 1.1](https://openfontlicense.org/) (full text: [`third-party/OFL-Outfit.txt`](./third-party/OFL-Outfit.txt))
- Source: [Outfit (Google Fonts)](https://fonts.google.com/specimen/Outfit)

## Android Auto icons

- Files: `android-native/app/src/main/res/drawable/ic_auto_*.xml`
- Vector drawables with a 960×960 viewport, based on Google's
  [Material Symbols](https://fonts.google.com/icons)
- License: [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
