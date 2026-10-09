# Voynix

[English](./README.md) | 日本語

📖 **[ユーザーマニュアル](https://tekapo.github.io/voynix/ja/)** — インストール、同期、Android Auto、FAQ

## TL;DR

Voynix は、Mac と Android 向けのローカルファーストな音楽プレーヤーです。

- Mac のライブラリを Wi-Fi 経由で Android に同期します。再生履歴やお気に入りも、Android から Mac に反映されます
- Android Auto に対応しています

## 主な機能

- **音楽再生**: ローカルの音楽ファイル（mp3, m4a, flac）をスキャンしてライブラリ管理（アーティスト、アルバム、プレイリスト）。Mac・Android とも曲間の無音を挟まないギャップレス再生に対応
- **プレイリスト**: 通常のプレイリストとスマートプレイリスト（スマートプレイリストは Mac で作成し、Android へは通常プレイリストとして同期）
- **曲情報の編集**: 曲・アルバム・アーティスト単位でタイトルやタグを編集可能
- **Podcast**: 再生速度の変更、±10秒スキップ、シャッフル対象外
- **Android への同期**: 同じ Wi-Fi ネットワーク上の Android 端末へ、ライブラリ・プレイリスト・再生履歴・お気に入りをミラー同期
- **Android Auto**: 車載機からもライブラリ・プレイリストを操作・再生可能

## 動作環境

- **Mac**: macOS（配布している DMG は Apple Silicon（arm64）専用）
- **Android**: Android 8.0（API 26）以上、Android Auto は任意
- 同期には Mac と Android が同じ Wi-Fi ネットワーク上にあることが必要です

## インストール

[Releases](https://github.com/tekapo/voynix/releases) から、Mac 用の `.dmg` または Android 用の `.apk` をダウンロードします。

> [!WARNING]
> **Mac:** アプリは Apple の署名・公証を受けていないため、初回は macOS にブロックされます。警告で「ゴミ箱に入れる」ではなく
> 「完了」を押し、システム設定 →「プライバシーとセキュリティ」で Voynix の項目の横にある**「このまま開く」**を押してください。
> ターミナルで `xattr -cr /Applications/Voynix.app` を実行してから開き直す方法もあります。
>
> **Android:** APK は Google Play では配布していません。Android の**「高度な保護機能」**がオンだと、
> 「高度な保護機能により制限されています」と表示されてインストールできません（Obtainium 経由も同様）。
> インストール前に、設定 → セキュリティとプライバシーでオフにしてください。あわせて、インストール元のアプリ
> （ブラウザ、ファイルアプリ、Obtainium）に「提供元不明のアプリ」の許可も必要です。**更新**も同じで、オンのままだと
> Obtainium に「この提供元のアプリを許可」を設定できず更新できないため、更新のたびにオフにしてください（更新後にオンへ戻せます）。

**Homebrew でのインストール（Mac、Apple Silicon）:**

```
brew install --cask tekapo/voynix/voynix
```

Cask がインストール後に quarantine 属性を外すため、上記の Gatekeeper の警告は出ません。
更新は `brew upgrade --cask voynix` です。Homebrew 7 で「信頼されていない tap」として読み込みを拒否されたら、
一度だけ `brew trust tekapo/voynix` を実行してください。

Android は [Obtainium](https://obtainium.imranr.dev/) に `https://github.com/tekapo/voynix` を登録すると、更新を自動で受け取れます。

音楽の取り込み、Android との同期、Android Auto の設定など、詳しくは
[ユーザーマニュアル](https://tekapo.github.io/voynix/ja/)を参照してください。

## ドキュメント

- [ユーザーマニュアル](https://tekapo.github.io/voynix/ja/)（使い方、Wi-Fi 同期、Android Auto、キーボードショートカット、バックアップ、FAQ と既知の制限）
- [プライバシーポリシー](https://tekapo.github.io/voynix/ja/privacy.html)
- [CHANGELOG.md](./docs/CHANGELOG.md)（英語）: バージョンごとの変更
- [SECURITY.md](./SECURITY.md): 脆弱性の報告方法
- [Homebrew tap](https://github.com/tekapo/homebrew-voynix): `brew install --cask tekapo/voynix/voynix` 用の Cask

## 支援

Voynix は無料のオープンソースです。気に入っていただけたら、[Ko-fi](https://ko-fi.com/tekapo) で開発を支援できます。

## 開発者向け情報

ビルド方法や開発コマンドなどは [DEVELOPMENT.ja.md](./docs/DEVELOPMENT.ja.md)（Mac 版）、
[android-native/README.ja.md](./android-native/README.ja.md)（Android 版）を参照してください。

## ライセンス

MIT License。詳細は [LICENSE](./LICENSE) を参照してください。
同梱しているフォント・アイコン等のサードパーティ素材については
[THIRD_PARTY_NOTICES.ja.md](./docs/THIRD_PARTY_NOTICES.ja.md) を参照してください。
