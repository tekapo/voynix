# サードパーティ素材について

[English](./THIRD_PARTY_NOTICES.md) | 日本語

このリポジトリのソースコード自体は [LICENSE](../LICENSE)（MIT）ですが、
同梱している以下のフォント・アイコン素材は別のライセンスの下で配布されています。

## 依存ライブラリ

Rust・npm・Android（Gradle）の依存ライブラリの著作権表示とライセンス文は、
`npm run licenses:generate`（`scripts/generate-licenses.mjs`）で自動生成し、
アプリ内の「オープンソースライセンス」から見られるようにしています。

- Mac: `public/licenses.txt`（設定 → About から表示）
- Android: `android-native/app/src/main/assets/licenses.txt`（設定 → オープンソースライセンス）

## Outfit フォント

- ファイル: `public/fonts/outfit.woff2`
- ライセンス: [SIL Open Font License 1.1](https://openfontlicense.org/)（全文: [`third-party/OFL-Outfit.txt`](./third-party/OFL-Outfit.txt)）
- 配布元: [Outfit (Google Fonts)](https://fonts.google.com/specimen/Outfit)

## Android Auto 用アイコン

- ファイル: `android-native/app/src/main/res/drawable/ic_auto_*.xml`
- 960×960 の viewport を持つベクター定義で、Google の
  [Material Symbols](https://fonts.google.com/icons) をもとにしています
- ライセンス: [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
