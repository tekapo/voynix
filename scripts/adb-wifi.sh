#!/usr/bin/env bash
# Wi-Fi 経由の adb 接続 + Android インストール。
#   初回ペアリング:  npm run adb:pair -- [<IP:ペアリング用ポート>] <ペア設定コード>
#   インストール:    npm run install:android-native:wifi -- [<IP:ポート>] [debug|release]
# <IP:ポート> を省略すると mDNS（adb mdns services）で自動検出する。
#   ペアリング: 端末の「ペア設定コードによるデバイスのペア設定」画面を開いている間だけ検出される。
#   インストール: 「開発者向けオプション > ワイヤレスデバッグ」がオンで、ペアリング済みなら検出される。
# 手入力する場合の <IP:ポート> は、ワイヤレスデバッグ画面のメインのもの。
set -euo pipefail

# adb mdns services から指定サービス種別の host:port を探す。見つからない/複数なら失敗。
discover() {
  local type="$1" label="$2" found count
  found="$(adb mdns services 2>/dev/null | awk -v t="$type" '$2 == t "._tcp" { print $3 }' | sort -u)"
  count="$(printf '%s' "$found" | grep -c . || true)"
  if [ "$count" -eq 0 ]; then
    echo "mDNS で $label が見つからない。端末のワイヤレスデバッグ画面を開いているか、同じ Wi-Fi か確認するか、<IP:ポート> を直接指定してください。" >&2
    return 1
  fi
  if [ "$count" -gt 1 ]; then
    echo "$label が複数見つかった。<IP:ポート> を直接指定してください:" >&2
    printf '  %s\n' $found >&2
    return 1
  fi
  echo "mDNS で検出: $found" >&2
  printf '%s\n' "$found"
}

is_hostport() { [[ "$1" =~ ^[^[:space:]]+:[0-9]+$ ]]; }

cmd="${1:-}"
case "$cmd" in
  pair)
    case $# in
      2) target="$(discover _adb-tls-pairing 'ペアリング待ちの端末')"; code="$2" ;;
      3) target="$2"; code="$3" ;;
      *) echo "usage: adb-wifi.sh pair [<host:port>] <code>" >&2; exit 1 ;;
    esac
    adb pair "$target" "$code"
    ;;
  install)
    shift
    target=""
    if [ $# -ge 1 ] && is_hostport "$1"; then
      target="$1"; shift
    fi
    variant="${1:-release}"
    case "$variant" in
      debug) task=installDebug ;;
      release) task=installRelease ;;
      *) echo "usage: adb-wifi.sh install [<host:port>] [debug|release]" >&2; exit 1 ;;
    esac
    [ -n "$target" ] || target="$(discover _adb-tls-connect '接続可能な端末')"
    adb connect "$target"
    # 複数端末が見えていても対象を固定する。
    cd "$(dirname "$0")/../android-native"
    ANDROID_SERIAL="$target" ./gradlew "$task"
    ;;
  *)
    echo "usage: adb-wifi.sh <pair|install> ..." >&2
    exit 1
    ;;
esac
