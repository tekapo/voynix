#!/bin/sh
# Host setup for Voynix's Echo playback (see docs/echo-lan.md). Two one-time jobs
# that need root, each installed as a LaunchDaemon so it survives a reboot:
#
#   echo-lan.sh dns <host-name> <lan-ip>   a DNS answering <host-name> with <lan-ip>
#                                          (point ONLY your Echo at it, in the router)
#   echo-lan.sh pf  <lan-ip> [port]        redirect <lan-ip>:443 -> <lan-ip>:<port>
#                                          (default 8443, Voynix's Echo port)
#   echo-lan.sh cert <host-name> <email> [duckdns-token-file]
#                                          renew the Let's Encrypt certificate (lego, DuckDNS DNS-01)
#                                          weekly when it is within 30 days of expiry; no sudo
#   echo-lan.sh status | uninstall
#
# `--dry-run` as the first argument prints what would be written and changes nothing.
set -eu

DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
CMD="${1:-}"

DNS_LABEL="com.voynix.echo-dns"
PF_LABEL="com.voynix.echo-pf"
DNS_PLIST="/Library/LaunchDaemons/$DNS_LABEL.plist"
PF_PLIST="/Library/LaunchDaemons/$PF_LABEL.plist"
CERT_LABEL="com.voynix.echo-cert-renew"
CERT_PLIST="$HOME/Library/LaunchAgents/$CERT_LABEL.plist"
LEGO_DIR="$HOME/.lego"
PF_ANCHOR_FILE="/etc/pf.anchors/voynix-echo"
# Anchors under com.apple/ are evaluated by the stock /etc/pf.conf, so /etc/pf.conf stays untouched.
PF_ANCHOR="com.apple/250.VoynixEcho"

die() { echo "error: $*" >&2; exit 1; }
need_ipv4() { echo "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || die "'$1' is not an IPv4 address"; }

# Writes stdin to $1 as root (or just shows it with --dry-run).
put() {
  echo "--- $1"
  if [ "$DRY" = 1 ]; then cat; else sudo tee "$1" >/dev/null; fi
}
# Same, for a file the current user owns (no sudo).
put_user() {
  echo "--- $1"
  if [ "$DRY" = 1 ]; then cat; else mkdir -p "$(dirname "$1")" && cat > "$1"; fi
}
run() { if [ "$DRY" = 1 ]; then echo "+ $*"; else "$@"; fi; }

case "$CMD" in
  dns)
    HOST="${2:?usage: $0 dns <host-name> <lan-ip>}"; IP="${3:?usage: $0 dns <host-name> <lan-ip>}"
    need_ipv4 "$IP"
    DNSMASQ="$(command -v dnsmasq || true)"; [ -n "$DNSMASQ" ] || die "dnsmasq not found (brew install dnsmasq)"
    CONF="$(dirname "$(dirname "$DNSMASQ")")/etc/voynix-echo-dnsmasq.conf"
    # Not Valet's dnsmasq: that one listens on 127.0.0.1 only, so both can run side by side.
    put "$CONF" <<CONF_EOF
# Answers $HOST with $IP, forwards everything else to the router.
# Only the Echo should be pointed at this DNS (router: DHCP static lease > DNS Server).
no-resolv
server=$(route -n get default 2>/dev/null | awk '/gateway/ {print $2}')
listen-address=$IP
bind-interfaces
no-hosts
address=/$HOST/$IP
CONF_EOF
    put "$DNS_PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$DNS_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$DNSMASQ</string><string>--keep-in-foreground</string><string>--conf-file=$CONF</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PLIST_EOF
    if [ "$DRY" = 0 ]; then
      sudo chown root:wheel "$DNS_PLIST"; sudo chmod 644 "$DNS_PLIST"
      sudo launchctl bootout system "$DNS_PLIST" 2>/dev/null || true
    fi
    run sudo launchctl bootstrap system "$DNS_PLIST"
    echo "Check: dig +short $HOST @$IP   (should print $IP)"
    ;;

  pf)
    IP="${2:?usage: $0 pf <lan-ip> [port]}"; PORT="${3:-8443}"
    need_ipv4 "$IP"
    # The interface that owns $IP (`route get` would say lo0 for the Mac's own address).
    IFACE="$(ifconfig | awk -v ip="$IP" '/^[a-z0-9]+:/ {sub(":", "", $1); i=$1} $1 == "inet" && $2 == ip {print i}')"
    [ -n "$IFACE" ] || die "no interface has the address $IP"
    put "$PF_ANCHOR_FILE" <<ANCHOR_EOF
# Echo only connects to port 443; Voynix listens (unprivileged) on $PORT.
rdr pass on $IFACE inet proto tcp from any to $IP port 443 -> $IP port $PORT
ANCHOR_EOF
    put "$PF_PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$PF_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>/sbin/pfctl -e; /sbin/pfctl -a $PF_ANCHOR -f $PF_ANCHOR_FILE</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST_EOF
    if [ "$DRY" = 0 ]; then
      sudo chown root:wheel "$PF_PLIST"; sudo chmod 644 "$PF_PLIST"
      sudo launchctl bootout system "$PF_PLIST" 2>/dev/null || true
    fi
    run sudo launchctl bootstrap system "$PF_PLIST"
    echo "Check from ANOTHER device on the LAN (the Mac can't test its own redirect):"
    echo "  curl -vk https://$IP/play   -> a TLS handshake, then 400/403 from Voynix"
    ;;

  cert)
    HOST="${2:?usage: $0 cert <host-name> <email> [duckdns-token-file]}"; EMAIL="${3:?usage: $0 cert <host-name> <email> [duckdns-token-file]}"
    TOKEN_FILE="${4:-$HOME/.duckdns-token}"
    LEGO="$(command -v lego || true)"; [ -n "$LEGO" ] || die "lego not found (brew install lego)"
    [ "$DRY" = 1 ] || [ -s "$TOKEN_FILE" ] || die "$TOKEN_FILE is missing or empty (the DuckDNS token, one line)"
    SCRIPT="$LEGO_DIR/renew-$HOST.sh"
    # `lego run` obtains or renews: with --renew-days 30 it does nothing until the
    # certificate has 30 days left. Voynix notices the rewritten files by itself.
    put_user "$SCRIPT" <<SCRIPT_EOF
#!/bin/sh
# Renews the certificate for $HOST when it has 30 days or less left. Run weekly by $CERT_LABEL.
set -eu
DUCKDNS_TOKEN="\$(cat "$TOKEN_FILE")"
export DUCKDNS_TOKEN
echo "== \$(date '+%Y-%m-%d %H:%M:%S') renew check for $HOST"
exec "$LEGO" run --path "$LEGO_DIR" --email "$EMAIL" --accept-tos --dns duckdns --domains "$HOST" --renew-days 30
SCRIPT_EOF
    put_user "$CERT_PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$CERT_LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$SCRIPT</string></array>
  <!-- Mondays 04:17; if the Mac was asleep then, launchd runs it on wake. -->
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>4</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardOutPath</key><string>$LEGO_DIR/renew.log</string>
  <key>StandardErrorPath</key><string>$LEGO_DIR/renew.log</string>
</dict></plist>
PLIST_EOF
    if [ "$DRY" = 0 ]; then
      chmod 700 "$SCRIPT"
      launchctl bootout "gui/$(id -u)" "$CERT_PLIST" 2>/dev/null || true
    fi
    run launchctl bootstrap "gui/$(id -u)" "$CERT_PLIST"
    echo "Weekly renewal check installed. Run it now with:  launchctl kickstart gui/$(id -u)/$CERT_LABEL"
    echo "Log: $LEGO_DIR/renew.log"
    ;;

  status)
    echo "pf anchor:"; sudo pfctl -a "$PF_ANCHOR" -sn 2>&1 | sed 's/^/  /'
    echo "daemons:"; launchctl print "system/$DNS_LABEL" >/dev/null 2>&1 && echo "  $DNS_LABEL loaded" || echo "  $DNS_LABEL not loaded"
    launchctl print "system/$PF_LABEL" >/dev/null 2>&1 && echo "  $PF_LABEL loaded" || echo "  $PF_LABEL not loaded"
    launchctl print "gui/$(id -u)/$CERT_LABEL" >/dev/null 2>&1 && echo "  $CERT_LABEL loaded" || echo "  $CERT_LABEL not loaded"
    ;;

  uninstall)
    for plist in "$DNS_PLIST" "$PF_PLIST"; do
      run sudo launchctl bootout system "$plist" 2>/dev/null || true
      run sudo rm -f "$plist"
    done
    run launchctl bootout "gui/$(id -u)" "$CERT_PLIST" 2>/dev/null || true
    run rm -f "$CERT_PLIST"
    run sudo pfctl -a "$PF_ANCHOR" -F all 2>/dev/null || true
    run sudo rm -f "$PF_ANCHOR_FILE"
    echo "pf itself is left enabled (other rules may rely on it); \`sudo pfctl -d\` turns it off if nothing else uses it."
    echo "Removed. The dnsmasq config file next to the dnsmasq binary (voynix-echo-dnsmasq.conf) is left for you to delete."
    ;;

  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
