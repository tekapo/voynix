# Voynix (android-native)

[English](./README.md) | 日本語

Voynix の Android ネイティブ版（Kotlin + Jetpack Compose）。`applicationId` は `com.tekapo.voynix`、
Kotlin のパッケージ名（`namespace`）は `com.voynix` です。Android Auto にも対応していますが、
車載機との接続は必須ではなく、スマホ単体でも普通に使えます。

Mac 側のライブラリをミラー専用クライアントとして Wi-Fi 経由で同期します
（Android から曲ファイルを直接スキャン・インポートすることはありません）。
先に Mac 側で Voynix を起動し、同期をオンにしておいてください。

このファイルは開発者向け（ビルド・テスト・Android Auto の検証手順）です。
アプリの使い方（ペアリング手順や Android Auto を有効化する手順など）は
[ルートの README.ja.md](../README.ja.md) を、Mac 版は
[docs/DEVELOPMENT.ja.md](../docs/DEVELOPMENT.ja.md) を参照してください。

## 動作環境

- Android 8.0（API 26）以上
- Mac 版 Voynix と同じ Wi-Fi ネットワーク（LAN 同期のため）
- ビルドには Android Studio（最新版推奨）、または JDK 17 以上 + Android SDK（compileSdk 36 /
  platform android-36）

## ビルドとインストール

デバッグ版とリリース版は**同じ `applicationId`** で、署名鍵だけが違います。

| | デバッグ版 | リリース版 |
| --- | --- | --- |
| 用途 | 開発中の動作確認 | 普段使い（実機への常用インストール） |
| 署名 | デバッグ鍵（自動生成） | リリース鍵（`local.properties` で指定） |
| minify / リソース縮小 | なし | あり（R8） |
| スタックトレース | そのまま読める | 難読化される |

### Android Studio から実行する場合

1. `android-native/` フォルダを Android Studio で開く
2. Gradle Sync が終わるのを待つ
3. 実機（USB デバッグを有効化して接続）またはエミュレータを選択
4. 上部の Run ▶ ボタンでインストール・起動

### コマンドラインでビルド・インストールする場合

実機の「開発者向けオプション」で **USB デバッグ** をオンにして USB 接続し、端末側の
「このコンピュータを許可」を承認します。接続の確認:

```sh
adb devices   # 端末が "device" と出ること（"unauthorized" / "offline" は未承認・未接続）
```

端末（実機・エミュレータ）が複数つながっていると `install*` が止まることがあります。
対象を1台に絞ります:

```sh
ANDROID_SERIAL=<adb devicesで出るシリアル> npm run install:android-native:release
```

デバッグ版:

```sh
npm run install:android-native          # = cd android-native && ./gradlew installDebug
```

APK だけ作る場合（`adb install` や手動転送用）:

```sh
cd android-native && ./gradlew assembleDebug
# 出力: android-native/app/build/outputs/apk/debug/app-debug.apk
```

リリース版:

```sh
npm run install:android-native:release          # 上書きインストール（曲データ・DBは保持）
npm run install:android-native:release:clean    # アンインストールしてから入れる（曲データ・DBは消える）
npm run build:android-native                    # APKだけ作る
# 出力: android-native/app/build/outputs/apk/release/app-release.apk
```

- **署名が違う版は上書きできません**（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`）。デバッグ版が入っている
  端末にリリース版を入れる（またはその逆）ときは `:clean` を使います。同期済みの曲データとDBも消えるので、
  Mac と再同期になります
- リリース鍵を設定していない環境では、リリース版は署名なしのAPKになり、そのままではインストールできません

### リリース鍵の準備（初回のみ・マシンごと）

鍵（`*.jks`）と `local.properties` はどちらも gitignore 済みで、リポジトリには入りません。

```sh
keytool -genkeypair -v -keystore android-native/keystore/voynix-release.jks \
  -alias <エイリアス> -keyalg RSA -keysize 2048 -validity 10000
```

`android-native/local.properties` に次の4キーを書きます（`storeFile` は `android-native/` からの相対パス）:

```properties
voynix.release.storeFile=keystore/voynix-release.jks
voynix.release.storePassword=...
voynix.release.keyAlias=...
voynix.release.keyPassword=...
```

鍵を失うと、同じ署名で更新できなくなります。バックアップを別に取っておいてください。
署名済み APK を GitHub Release に添付する手順は、
[docs/DEVELOPMENT.ja.md](../docs/DEVELOPMENT.ja.md) の「バージョンとリリース」を参照してください。

### Wi-Fi経由（USBなし）

```sh
npm run adb:pair -- [<IP:ペアリング用ポート>] <ペア設定コード>      # 初回のみ
npm run install:android-native:wifi -- [<IP:ポート>] [debug|release]  # 省略時は release
```

端末の「開発者向けオプション → ワイヤレスデバッグ」をオンにして使います。`<IP:ポート>` を省略すると
mDNS（`adb mdns services`）で自動検出します。ペアリング用のポートと接続用のメインのポートは別です。
ネットワークや macOS の「ローカルネットワーク」権限の都合で mDNS や `adb connect` が通らないことがあります。
その場合は USB 接続を使ってください。

## つまずいたとき

- **Gradle が `IllegalArgumentException: 25.0.3` などで失敗する**: ターミナルから使われる JDK
  （JDK 25、Android Studio 同梱の JBR など）のバージョンを Kotlin が解釈できません。
  JDK 21 を入れて（`brew install openjdk@21`）、`~/.gradle/gradle.properties` に
  `org.gradle.java.home=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home` を書きます
  （パスは Apple Silicon の Homebrew の例）
- **`adb` が `waiting for device` のまま止まる**: 端末が認識されていません。ケーブル・USBデバッグ・承認ダイアログを確認してください
- **実行中のログを見る**: `adb logcat | grep -iE "Voynix"`（再生・同期まわりのログは `VoynixPlayback` タグ）

## Android Auto

`./gradlew installDebug` や APK の sideload で入れたビルドは、Android Auto 側で
「提供元不明のアプリ」を有効にしないとアプリ一覧に出てきません。
有効化の手順は [README.ja.md](../README.ja.md#android-auto-を使う) を参照してください。それでも一覧に「Voynix」が出てこない場合、
確認用に:

```sh
# メディアブラウザとして OS に見えているか
adb shell pm query-services -a android.media.browse.MediaBrowserService --components

# 再生中のセッションが登録されているか
adb shell dumpsys media_session | grep -i voynix

# 接続中に Auto 側が弾いている理由（署名／不明ソースなど）
adb logcat | grep -iE "gearhead|CAR\.|MediaApp"
```

### Desktop Head Unit（DHU）でパソコン上から検証する

投影型 Android Auto の公式テストツールです。旧 Media Browser／Messaging シミュレータは
廃止済みで、現在は DHU に一本化されています
（[Test Android apps for cars](https://developer.android.com/training/cars/testing)）。

```sh
# 未インストールなら（stable は 2.0 のまま更新されないため beta チャンネルを指定）
android sdk install --beta "extras;google;auto@2.1.0"

# 端末を USB 接続した状態で
npm run auto:dhu
```

`npm run auto:dhu`（`scripts/dhu.mjs`）が `adb devices` の確認・`adb forward tcp:5277
tcp:5277`・DHU 起動をまとめてやります。事前に端末の Android Auto アプリ側でも
「デベロッパー向け設定」→「ヘッドユニットサーバーを起動」をタップしておくこと
（デベロッパー向け設定の出し方は [README.ja.md](../README.ja.md#android-auto-を使う) 参照）。

DHU は beta チャンネルの **2.1** を使います（stable の 2.0 は実機の Android Auto とのハンドシェイクが
成立しません）。ブラウズツリー、タップ再生、カバーアート／曲名表示、Auto 側からの一時停止操作まで
Pixel 8 Pro + Android Auto 17.6 で動作確認済みです。事前に端末の Android Auto「デベロッパー向け設定」→
「アプリモード」を "デベロッパー" に切り替えておくこと（この項目は切り替えないと出てきません）。

## テスト

```sh
./gradlew testDebugUnitTest
```

ロジック層（キュー/再生/検索/ソート/同期差分/統計マージ）に加えて、
Robolectric 上で Room DAO（`tracks`/`playlists`/`play_events`/`settings`/
`album_covers`）、MockWebServer を使った `SyncApi`（ping/manifest の503
リトライ/ダウンロード再開・416/整合性検証/アルバムアート取得）、
Mockito でモックした `Player` に対する `PlayerController`（キュー送り・
シャッフル・リピート・再生回数カウントの記録）まで、エミュレータなしで
JVM 上から検証できます。

Mac 版と共有する仕様（アルバムアートのキー、コンテンツハッシュ、自然順ソート、ペアリング QR）は
[`docs/test-vectors/`](../docs/test-vectors/) のテストベクタで固定し、Rust と Kotlin の両方で検証しています。

## 既知の制限

- ペアリングはMacのQRコードの読み取り（推奨）、mDNS 自動検出、手動入力に対応。QRコードは
  フィンガープリントを含むためそのまま照合される。mDNS・手動入力ではTLS証明書の帯域外検証が
  できないため、ペアリング時に表示されるフィンガープリント（Security code）をMac側の表示と
  目視で照合すること
- 同期は HTTPS 専用。自己署名証明書 + SPKIピン留め（TOFU）
- 自動バックアップと端末間データ移行は無効（ペアリング情報を別端末に引き継がないため）。機種変更後は再ペアリングして再同期すること
