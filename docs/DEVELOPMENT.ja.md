# 開発者向けドキュメント（Mac 版）

[English](./DEVELOPMENT.md) | 日本語

Voynix は、Mac 上のローカル音楽ライブラリを管理・再生し、Wi-Fi 経由で Android へ同期する音楽プレーヤーです。
Mac 版は Tauri 2、React、TypeScript（フロントエンド）と Rust（バックエンド）で構築されています。
Android 版（Kotlin + Jetpack Compose、`android-native/`）の開発については
[android-native/README.ja.md](../android-native/README.ja.md) を参照してください。

## アーキテクチャ

- **音楽再生エンジン**: Mac は Rust 製の独自再生エンジン（rodio + symphonia）が次の曲を事前デコードし
  サンプル単位で継ぎ目なく繋げる方式でギャップレス再生を実現します。m4a/ALAC の曲間に残る無音は、
  `iTunSMPB`（エンコーダの先頭・末尾の余分なサンプル数）を解釈してトリムして解消しています。
  Android は ExoPlayer のプレイリスト機能で次の曲を先読みキューイングします
- **Wi-Fi 同期サーバー**: アプリ内に同期サーバーを内蔵し、同一ネットワーク内の Android 端末とペアリングします。
  通信は TLS（自己署名証明書 + SPKI ピン留め）で保護します。ペアリングは、Mac が表示する QR コード
  （証明書のフィンガープリントを含む）を Android で読み取る方法が推奨です。mDNS 自動検出や URL と
  ペアリングコードの手動入力では、Mac 側の承認画面でセキュリティコード（フィンガープリント）を
  目視で照合してから接続を許可します
- **トランスコード**: 同期時、Android が再生できない ALAC（Apple Lossless）の曲だけを、macOS 標準の
  `afconvert` で AAC（既定 256kbps）または FLAC（設定で選択）に変換してから送信します。
  変換結果はキャッシュされ、再同期では再利用されます。スキャン対象の拡張子は mp3 / m4a / flac です

## 前提条件

- **macOS**（アプリ自体が macOS 専用で、`afconvert` や Dock メニューなど macOS の機能を使います）
- **Node.js 22**（CI と同じバージョン）: [ダウンロード](https://nodejs.org/)
- **Rust**: [rustup](https://rustup.rs/) 経由でインストール
- **Xcode Command Line Tools**:

  ```sh
  xcode-select --install
  ```

Tauri のビルド全般については [Tauri の前提条件ドキュメント](https://tauri.app/start/prerequisites/)も参照してください。

## セットアップと開発

リポジトリをクローンし、依存関係をインストールします:

```sh
npm ci
```

開発モードで実行する（フロントエンド + Tauri バックエンド）:

```sh
npm run tauri:dev
```

開発ビルドは本番ビルド（`com.tekapo.voynix`）とは別のアプリID（`com.tekapo.voynix.dev`）・アプリ名
（「Voynix (Dev)」）で動作し、アプリデータ（ライブラリ・プレイリスト等）も別ディレクトリに保存されます。
本番ビルドをインストールしても開発時のデータが混ざることはありません。

ブラウザでフロントエンドのみを実行する（UI開発に便利）:

```sh
npm run dev
```

## ビルド

```sh
npm run tauri build
```

## テスト

| 対象 | コマンド |
| --- | --- |
| フロントエンド（Vitest） | `npm test`（ウォッチは `npm run test:watch`、カバレッジは `npm run test:coverage`） |
| Rust（バックエンド） | `cd src-tauri && cargo test` |
| Android | `cd android-native && ./gradlew testDebugUnitTest`（[android-native/README.ja.md](../android-native/README.ja.md#テスト)） |

この3つは、`main` への push と pull request のたびに CI（`.github/workflows/test.yml`）で実行されます。

Mac と Android で共有する仕様（アルバムアートのキー、コンテンツハッシュ、自然順ソート、ペアリング QR）は、
[`docs/test-vectors/`](./test-vectors/) の共有テストベクタで固定し、Rust と Kotlin の両方で検証しています。
仕様を変えるときは、テストベクタと両方の実装をそろえて更新してください。

## バージョンとリリース

### バージョン番号

```sh
npm run version:bump -- <patch|minor|major|x.y.z>
```

`scripts/bump-version.mjs` が、`package.json` / `package-lock.json` / `src-tauri/tauri.conf.json` /
`src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `android-native/app/build.gradle.kts`
（`versionName` と `versionCode`）へ一括で反映します。バージョンを上げたら、
[CHANGELOG.md](./CHANGELOG.md) の先頭に `## <version> — <YYYY-MM-DD>` のエントリ（英語、箇条書き1〜3行）を
追記します。

### ライセンス表記の再生成

依存ライブラリを追加・更新したら `npm run licenses:generate` を実行し、
`public/licenses.txt` と `android-native/app/src/main/assets/licenses.txt` を再生成してコミットします
（`src/licenses.test.ts` が直接依存の載り漏れを検出します）。

### GitHub Actions での macOS 版ビルド

`.github/workflows/build-macos.yml` により、GitHub Actions 上（`macos-latest`）で macOS 版デスクトップ
アプリ（Apple Silicon / arm64 のみ）をビルドできます。未署名ビルドのため、配布物を開く際は Gatekeeper の
「開発元を確認できません」警告が出ます（右クリック → 開く、または `xattr -cr` で回避）。

トリガーは以下の2通りです:

- **タグ push**（`v*` 形式）: `npm run release` で package.json のバージョンから `v<version>` タグを
  作成して push します（作業ツリーがクリーンでない場合や、バージョンファイル間の不整合がある場合は
  エラーで止まります）
- **手動実行**: GitHub の「Actions」タブから `Build macOS` ワークフローを選び、「Run workflow」で
  実行します（タグ不要）

成果物（`.dmg` / `.app`）はワークフロー実行結果の Artifacts からダウンロードできます。タグ push で実行した
場合は、それに加えて GitHub の「Releases」ページに Release が**公開状態で**作成され、`.dmg` が添付されます
（リリースノートはコミットから自動生成）。手動実行ではタグが無いため Release は作成されず、Artifacts のみ
生成されます。

### Android 版の APK を Release に載せる

APK は CI ではビルドせず、リリース鍵のある手元のマシンでビルドして Release に添付します
（鍵を GitHub に預けないため）。リリース鍵の準備は
[android-native/README.ja.md](../android-native/README.ja.md#リリース鍵の準備初回のみマシンごと) を参照してください。

`npm run release` は、タグの push → Build macOS ワークフローの完了待ち → APK の添付 → Homebrew Cask の更新 → Google Play へのアップロードまでを続けて行います
（タグだけ push したいときは `-- --no-android`）。APK の添付だけを単独で行う場合は次のとおりです。

1. `npm run release -- --no-android` などで `v<version>` タグを push し、Build macOS ワークフローが Release を作るのを待つ
2. `npm run release:android` を実行する。`assembleRelease` で署名済み APK を作り、`gh release upload` で
   `voynix-<version>.apk` を Release に添付します（既存なら上書き）。`-- --dry-run` を付けるとビルドだけ
   行い、アップロードはしません

`gh` CLI のログインが必要です。リリース鍵（`local.properties`）が未設定だとエラーで止まります。

### Google Play へのアップロード

`npm run release` は最後に `npm run release:play` を実行し、署名済み AAB をビルドして、Gradle Play Publisher
（`./gradlew publishReleaseBundle`）で Play の**内部テスト**トラックにアップロードします。リリースノートには、
`docs/CHANGELOG.md` のそのバージョンの項目を Play の上限の 500 文字までで使います。Play のサービス アカウント キーが
未設定ならこの手順は飛ばします（`-- --no-play` でも飛ばせます）。製品版への昇格は Play Console で手動で行います。
キーの準備は [android-native/README.ja.md](../android-native/README.ja.md#google-play-のアップロード鍵初回のみマシンごと) を参照してください。

プラグインは 3.x に固定しています。4.x は Gradle 9.1 以上が必要なためです。

### Homebrew Cask

Mac 版は `brew install --cask tekapo/voynix/voynix` でもインストールできます（Apple Silicon のみ）。Cask は別リポジトリの
tap [`tekapo/homebrew-voynix`](https://github.com/tekapo/homebrew-voynix)（`Casks/voynix.rb`）にあります。
`npm run release` は最後に `npm run release:cask` を実行し、Release の DMG をダウンロードして、GitHub API 経由で
Cask の `version` と `sha256` を更新します（`-- --dry-run` なら push せず結果だけ表示）。単独で実行する場合は、
Release が先に存在している必要があります。

アプリは公証されていないため、Cask の `postflight_steps` で `xattr -dr com.apple.quarantine` をインストール済みのアプリに実行しています。
パスには `{{appdir}}` トークンを使い、手順がサンドボックスで動くため `writable_paths` にもアプリを指定します（`brew style` も通ります）。
従来の `postflight` でも動きますが、インストールのたびに非推奨の警告が出ます。

## コマンド一覧

| コマンド | 内容 |
| --- | --- |
| `npm ci` | 依存関係のインストール |
| `npm run tauri:dev` | 開発モードで実行（フロントエンド + Tauri バックエンド、アプリIDは `com.tekapo.voynix.dev`） |
| `npm run dev` | ブラウザでフロントエンドのみ実行（UI開発向け） |
| `npm run tauri build` | 本番用アプリケーションのビルド |
| `npm test` | テスト実行 |
| `npm run test:watch` | テストをウォッチモードで実行 |
| `npm run test:coverage` | カバレッジ付きでテスト実行 |
| `npm run licenses:generate` | 依存ライブラリのライセンス表記を再生成 |
| `npm run version:bump` | バージョン番号を更新（Mac / Android 両方に反映） |
| `npm run release` | 現在のバージョンで `v<version>` タグを作成・push し、macOS ビルドの完了を待って署名済み APK を Release に添付し、Homebrew の Cask を更新し、AAB を Google Play の内部テストにアップロード（`-- --no-android` でタグ push のみ、`-- --no-play` で Play を飛ばす） |
| `npm run release:cask` | `tekapo/homebrew-voynix` tap の Cask の `version` / `sha256` を、現在のバージョンの DMG に合わせて更新（`npm run release` が実行する。Release が先に存在している必要がある） |
| `npm run build:android-aab` | Google Play 向けの署名済み App Bundle（`voynix-<version>.aab`）をビルドし、パスを表示する。Play Console で手動アップロードするとき用（`npm run release:play` は自動でアップロードする。GitHub Release には添付しない） |
| `npm run release:play` | 署名済み AAB をビルドし、このバージョンの CHANGELOG の項目をリリースノートにして Google Play の内部テストにアップロード（`-- --dry-run` でリリースノートの表示のみ） |
| `npm run release:android` | 署名済み APK をビルドし、現在のバージョンの GitHub Release に添付（Release が先に存在している必要がある） |
| `npm run install:android-native` | Android のデバッグビルドを実機にインストール |
| `npm run build:android-native` | Android のリリースビルド（署名・minify 有効）を作成 |
| `npm run install:android-native:release` | Android のリリースビルドを実機に上書きインストール |
| `npm run install:android-native:release:clean` | 同上だが、既存インストール分をアンインストールしてから入れる |
| `npm run adb:pair` | Wi-Fi 経由の adb ペアリング（初回のみ） |
| `npm run install:android-native:wifi` | Wi-Fi 経由で Android 版をビルドしてインストール |
| `npm run auto:dhu` | Android Auto Desktop Head Unit (DHU) を USB 接続端末に対して起動 |

Android 系のコマンドの詳細は [android-native/README.ja.md](../android-native/README.ja.md) を参照してください。

## 推奨 IDE セットアップ

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
