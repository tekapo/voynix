# Voynix

[English](./README.md) | 日本語

📖 **[ユーザーマニュアル](https://tekapo.github.io/voynix/ja/)** — インストール、同期、Android Auto、FAQ

## TL;DR

Voynix は、Mac と Android 向けのローカルファーストな音楽プレイヤーです。

- Mac のライブラリを Wi-Fi 経由で Android に同期します。Android での再生履歴やお気に入りも Mac に反映されます
- Android Auto に対応しています

## 主な機能

- **音楽再生**: ローカルの音楽ファイル（mp3、m4a、flac）をスキャンし、ライブラリ（アーティスト、アルバム、プレイリスト）として管理します。Mac・Android とも曲間に無音を挟まないギャップレス再生に対応
- **プレイリスト**: 通常のプレイリストとスマートプレイリスト（スマートプレイリストは Mac で作成し、Android へは通常プレイリストとして同期）
- **曲情報の編集**: 曲・アルバム・アーティスト単位でタイトルやタグを編集可能
- **ポッドキャスト**: 再生速度の変更、±10秒スキップ、シャッフル対象からの除外（設定）
- **歌詞**: 再生中の曲の歌詞を Mac・Android で表示（歌詞の画面を開いたとき、LRCLIB からオンラインで取得）
- **テーマ（Mac）**: 設定 → 一般で「システムに従う」「ライト」「ダーク」を選択
- **Android への同期**: 同期対象に指定したプレイリスト・ライブラリ項目を、同じ Wi-Fi ネットワーク上の Android 端末へミラー同期。再生履歴とお気に入りは双方向で反映
- **Android Auto**: 車載機からもライブラリ・プレイリストを操作・再生可能
- **再生元の表示（Android）**: キューをどのプレイリスト・アーティスト・アルバム・ライブラリ項目から再生しているかを、再生画面、ミニプレイヤー、Android Auto に表示

## 動作環境

- **Mac**: macOS（配布している DMG は Apple Silicon／arm64 専用）
- **Android**: Android 8.0（API 26）以上、Android Auto は任意
- 同期には Mac と Android が同じ Wi-Fi ネットワーク上にあることが必要です

## インストール

[Releases](https://github.com/tekapo/voynix/releases) から、Mac 用の `.dmg` または Android 用の `.apk` をダウンロードします。

**Android のテスター募集中:** Google Play でクローズド テストを実施中です。Android 端末と Mac をお持ちで、14日間参加したままにできる方は、[こちらのフォーム](https://forms.gle/5WoQn1y3orfDcVB67)からお申し込みください。

> [!WARNING]
> **Mac:** アプリは Apple の署名・公証を受けていないため、初回は macOS にブロックされます。警告で「ゴミ箱に入れる」ではなく
> 「完了」を押し、システム設定 →「プライバシーとセキュリティ」で Voynix の項目の横にある「**このまま開く**」を押してください。
> ターミナルで `xattr -cr /Applications/Voynix.app` を実行してから開き直す方法もあります。
>
> **Android:** Releases の APK は、Google Play の外からインストールするものです。Android の「**高度な保護機能**」がオンだと、
> 「高度な保護機能により制限されています」と表示されてインストールできません（Obtainium 経由も同様）。
> インストール前に、設定 → セキュリティとプライバシーでオフにしてください。あわせて、インストール元のアプリ
> （ブラウザ、ファイルアプリ、Obtainium）に「不明なアプリのインストール」の許可も必要です。**更新**も同じで、高度な保護機能が
> オンのままだと Obtainium に「この提供元のアプリを許可」を設定できず更新できないため、更新のたびにオフにしてください（更新後にオンへ戻せます）。
>
> クローズド テストのテスターとして Google Play から入れる場合は、これらは不要です。高度な保護機能をオンのままインストールでき、更新も Play が行います。

**Homebrew でのインストール（Mac、Apple Silicon）:**

```sh
brew install --cask tekapo/voynix/voynix
```

Cask がインストール後に quarantine 属性を外すため、上記の Gatekeeper の警告は出ません。
更新は `brew upgrade --cask voynix` です。Homebrew 7 で「信頼されていない tap」として読み込みを拒否されたら、
一度だけ `brew trust tekapo/voynix` を実行してください。

Android は [Obtainium](https://obtainium.imranr.dev/) に `https://github.com/tekapo/voynix` を登録すると、更新を自動で受け取れます。

音楽の取り込み、Android との同期、Android Auto の設定など、詳しくは
[ユーザーマニュアル](https://tekapo.github.io/voynix/ja/)を参照してください。

## クイックスタート

先にアプリをインストールしてください（[インストール](#インストール)）。各手順の詳細は[ユーザーマニュアル](https://tekapo.github.io/voynix/ja/)にあります。

### Mac

1. Voynix を起動します。
2. サイドバーの「**＋ 新規** → **ミュージックフォルダを追加…**」から音楽フォルダを選びます。スキャンがすぐに始まります。
3. スマホに入れたいプレイリスト（または「すべての曲」などのライブラリ項目）を右クリックして「**デバイスと同期**」を選びます。横に同期マークが付きます。何も選ばないと Android には曲が届きません。
4. サイドバー下部の「＋ 新規」の隣にある同期ボタンを押すと QR コードが表示されます。既定では、同期サーバーは Voynix の起動時に自動で始まります（設定 → 同期 →「同期サーバーを自動的に開始する」）。

### Android

1. アプリ（APK、またはクローズド テストのテスターは Google Play 版）をインストールして開きます。通知の許可を求められたら許可します。
2. Mac と同じ Wi-Fi に接続し、「**設定** → **Wi-Fi同期**」を開いて、Mac に表示された QR コードを読み取ります。
3. 同期対象の曲・プレイリスト、再生履歴、お気に入りが取り込まれます。以降は「**今すぐ同期**」を押すか、Mac と同じ Wi-Fi で約6時間ごとの自動同期に任せられます。

### Android Auto

APK を Google Play 以外から入れた場合、Android Auto 側で「提供元不明のアプリ」を有効にしないとアプリが表示されません（初回のみ）。Google Play のクローズド テストから入れた場合は、この手順は不要です。

1. 端末で Android Auto アプリを開き、設定の一番下の「バージョン」を約10回タップします。
2. 設定画面から戻り、左上のメニュー（≡）から「**デベロッパー向け設定**」を開いて、「**提供元不明のアプリ**」をオンにします。
3. Android Auto を強制停止（または端末を再起動）して、車に再接続します。一覧に Voynix が表示されます。

うまくいかないときは、[マニュアルの Android Auto](https://tekapo.github.io/voynix/ja/#auto) と [android-native/README.ja.md](./android-native/README.ja.md) を参照してください。

## ドキュメント

- [ユーザーマニュアル](https://tekapo.github.io/voynix/ja/)（使い方、Wi-Fi 同期、Android Auto、キーボードショートカット、バックアップ、FAQ と既知の制限）
- [プライバシーポリシー](https://tekapo.github.io/voynix/ja/privacy.html)
- [Echo で LAN 内再生](./docs/echo-lan.ja.md): 上級者向けの任意機能。インターネットには何も公開せず、自作の Alexa スキルで Voynix のプレイリストを Echo で再生
- [CHANGELOG.md](./docs/CHANGELOG.md)（英語）: バージョンごとの変更
- [SECURITY.md](./SECURITY.md)（英語）: 脆弱性の報告方法
- [Homebrew tap](https://github.com/tekapo/homebrew-voynix): `brew install --cask tekapo/voynix/voynix` 用の Cask

## 支援

Voynix は無料のオープンソースです。気に入っていただけたら、[Ko-fi](https://ko-fi.com/tekapo) で開発を支援していただけるとうれしいです。

## 開発者向け情報

ビルド方法や開発コマンドなどは [DEVELOPMENT.ja.md](./docs/DEVELOPMENT.ja.md)（Mac 版）、
[android-native/README.ja.md](./android-native/README.ja.md)（Android 版）を参照してください。

## ライセンス

MIT License。詳細は [LICENSE](./LICENSE) を参照してください。
同梱しているフォント・アイコンなどのサードパーティ素材については
[THIRD_PARTY_NOTICES.ja.md](./docs/THIRD_PARTY_NOTICES.ja.md) を参照してください。
