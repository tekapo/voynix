# Voynix

[English](./README.md) | 日本語

Mac 上のローカル音楽ライブラリを管理・再生し、Wi-Fi 経由で Android（Android Auto 対応）へ
同期して持ち出せる音楽プレーヤーです。

## 主な機能

- **音楽再生**: ローカルの音楽ファイル（mp3, m4a, flac）をスキャンしてライブラリ管理（アーティスト、アルバム、プレイリスト）。曲間の無音を挟まないギャップレス再生に対応（Mac・Android共通）
- **プレイリスト**: 通常のプレイリストに加え、ジャンル・アーティスト・再生回数・追加日・お気に入りなどの条件で自動的に曲を集めるスマートプレイリストを作成可能（作成・編集は Mac のみ、Android へは通常プレイリストとして同期）。Most Played / Recently Added / Recently Played の自動プレイリストも用意
- **曲情報の編集**: 「Get Info…」から曲・アルバム・アーティスト単位でタイトルやタグを編集可能。アーティスト画像は自動取得できます
- **Podcast**: 再生速度の変更（0.8〜2.0x）、±10秒スキップ、シャッフル対象外などポッドキャスト向けの挙動に対応
- **iTunes 連携**: iTunes のライブラリ XML をインポートしてプレイリストを取り込むことができます
- **操作性**: キーボードショートカットや Dock 右クリックメニューに対応
- **Android への同期**: 同じ Wi-Fi ネットワーク上の Android 端末へ、ライブラリ・プレイリスト・再生履歴・お気に入りを自動でミラー同期。約6時間ごとのバックグラウンド自動同期にも対応
- **Android Auto**: 車載機からもライブラリ・プレイリストを操作・再生可能

## 動作環境

- **Mac**: macOS（配布している DMG は Apple Silicon（arm64）専用）
- **Android**: Android 8.0（API 26）以上、Android Auto は任意
- 同期には Mac と Android が同じ Wi-Fi ネットワーク上にあることが必要です

## インストール

### Mac

[Releases](https://github.com/tekapo/voynix/releases) から `.dmg` をダウンロードして Applications に
ドラッグします。アプリは Apple の署名・公証を受けていないため、初回は Finder でアプリを
**右クリック →「開く」** で起動してください（ダブルクリックだと警告で開けない場合があります）。

### Android

[Releases](https://github.com/tekapo/voynix/releases) から `voynix-<バージョン>.apk` をダウンロードして
端末で開きます。初回は、ブラウザやファイルアプリに「提供元不明のアプリ」のインストールを許可する
よう求められます。

更新を自動で受け取りたい場合は [Obtainium](https://obtainium.imranr.dev/) に登録します。Obtainium で
「アプリを追加」→ `https://github.com/tekapo/voynix` を入力してインストールすると、各 Release の
`.apk` を取得し、新しいバージョンが出たときに通知してくれます。

APK は Google Play では配布していません。ソースからビルドする場合は
[android-native/README.ja.md](./android-native/README.ja.md) の手順を参照してください。

ソースからのビルド手順（Mac 版）は [DEVELOPMENT.ja.md](./docs/DEVELOPMENT.ja.md) を参照してください。

## 使い方

### 音楽を取り込む（Mac）

サイドバーの「＋ New」→「Add Music Folder…」から音楽フォルダを追加するとスキャンが始まります。
Settings > Music Folders からフォルダの再スキャン（Rescan All）や iTunes ライブラリの読み込み
（Import iTunes Library…）も行えます。

### キーボードショートカット（Mac）

| キー | 動作 |
| --- | --- |
| Space | 再生 / 一時停止 |
| ← / → | 前後の曲へ移動（Podcast 再生中は ±10秒） |
| ⌘F | 検索欄にフォーカス |
| Escape | フォーカス解除 |

### Android と同期する

1. Mac 側で Sync 画面を開き「Start Server」を押してサーバーを起動する。QR コードが表示される
2. Android の設定から「Wi-Fi Sync」を開き、QR コードを読み取る（Google のコードスキャナを使うため
   カメラ権限は不要）。QR にはサーバーの証明書のフィンガープリントが含まれるため、セキュリティコードの
   確認は不要です。同一 Wi-Fi 上の Mac を自動検出する方法や、URL とペアリングコードの手動入力も使えます
3. Mac 側に承認プロンプトが表示されたら許可する
4. 承認後、曲・プレイリスト・再生履歴・お気に入りが Android へ取り込まれます。以降は手動での再同期に
   加え、Wi-Fi 圏内であれば約6時間ごとにバックグラウンドで自動同期されます（Android の設定で ON/OFF・
   充電中のみに限定するオプションあり）
   - ALAC など Android 側で再生できない形式の曲は、Mac 上で自動的に変換してから送られます

Android アプリの初回起動時は、通知権限（Android 13 以上）の許可を求められます。

### Android Auto を使う

車載機に接続すると、ホーム画面から曲・プレイリスト・Podcast をブラウズして再生できます。
シャッフル/リピート、Podcast の ±10秒スキップにも対応。

Google Play 以外から入れたアプリは、Android Auto 側で「提供元不明のアプリ」を有効にしないと
アプリ一覧に出てきません。初回のみ以下の設定が必要です。

1. 端末で Android Auto アプリを開く
2. 設定 → 一番下の「バージョン」を約10回タップする（デベロッパーになった旨のメッセージが表示される）
3. 設定画面から戻り、左上のメニュー（≡）を開くと「デベロッパー向け設定」という項目が増えている
4. デベロッパー向け設定 →「提供元不明のアプリ」を ON にする
5. Android Auto を一度強制停止するか端末を再起動し、車（または USB/BT 経由の Auto）に再接続する

これで一覧に「Voynix」が表示されます。うまくいかない場合の詳細な確認方法は
[android-native/README.ja.md](./android-native/README.ja.md) を参照してください。

## 既知の制限

- 手動入力でペアリングする場合は、表示されるセキュリティコードが Mac・Android 双方で一致していることを
  必ず確認してください（QR コードでのペアリングでは不要）
- Android から曲ファイルを直接追加・スキャンすることはできません（Mac のライブラリをミラーする専用
  クライアントです）
- スマートプレイリストの作成・編集は Mac 版のみで可能です
- Android のバックアップは無効です（ペアリング情報を別端末に復元させないため）。機種変更後は再ペアリングして同期してください

## セキュリティ

脆弱性の報告方法は [SECURITY.md](./SECURITY.md) を参照してください。

## 変更履歴

バージョンごとの変更は [CHANGELOG.md](./docs/CHANGELOG.md)（英語）を参照してください。

## 開発者向け情報

ビルド方法や開発コマンドなどは [DEVELOPMENT.ja.md](./docs/DEVELOPMENT.ja.md)（Mac 版）、
[android-native/README.ja.md](./android-native/README.ja.md)（Android 版）を参照してください。

## ライセンス

MIT License。詳細は [LICENSE](./LICENSE) を参照してください。
同梱しているフォント・アイコン等のサードパーティ素材については
[THIRD_PARTY_NOTICES.ja.md](./docs/THIRD_PARTY_NOTICES.ja.md) を参照してください。
