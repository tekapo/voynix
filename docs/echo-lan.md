# Playing Voynix playlists on an Echo (Alexa), over your LAN

[日本語版はこちら](./echo-lan.ja.md)

An optional, advanced feature: say "Alexa, *&lt;your skill&gt;*, play *Drive*" and an Echo plays that Voynix
playlist, fetching the audio **straight from your Mac over the home network**. Nothing is exposed to the
internet, and the Alexa skill never talks to your Mac.

It is off by default and takes real setup: a domain name, a certificate, a DNS entry for the Echo, a port
redirect and your own Alexa skill. This page is the whole recipe.

## How it works

```
You ──▶ Echo ──▶ Alexa cloud ──▶ your skill (builds a signed URL, hands it back)
                                      │
Echo ◀────────────────────────────────┘
Echo ──(DNS)──▶ your Mac's dnsmasq ──▶ the Mac's LAN IP
Echo ──(HTTPS, port 443)──▶ Mac ──(pf)──▶ Voynix on :8443  ──▶  GET /play?list=…&i=…&seed=…&exp=…&sig=…
```

- The skill turns the playlist name you said into `/play?list=<name>&i=<n>&seed=<s>&exp=<unix>&sig=<HMAC>`,
  signed with a secret shared with Voynix. `i` is the track number; `seed` 0 plays in order, anything else
  shuffles the same way every time. Before the track ends, the skill queues `i + 1`.
- Voynix finds the playlist (fuzzy, ignoring case, width and kana), checks the signature and expiry, converts
  the file to AAC with `afconvert` if Echo can't play it (Echo plays MP3 and AAC only), and serves it with Range
  support. Voynix refuses connections that don't come from a private (LAN) address.
- **Why split DNS?** Alexa's cloud rejects a Play URL whose host name resolves to a private IP
  (`INVALID_RESPONSE: The URL specified in the Play directive is invalid`), but the Echo can only reach your Mac
  at its LAN IP. So the host name resolves to a *public* IP for everyone (including Alexa's cloud) and to the
  Mac's LAN IP only for the Echo, through a DNS you run.

## Requirements

- A Mac that stays awake and running Voynix whenever you want to listen (if the Mac sleeps, the Echo can't
  resolve names either — see [Limits](#limits)).
- A router that can hand a specific DNS server to one device (e.g. ASUS: LAN → DHCP Server → manual
  assignment, "DNS Server" column), and an Echo with a fixed IP.
- A host name whose DNS you control, plus a public CA certificate for it. A free
  [DuckDNS](https://www.duckdns.org/) name (`<you>.duckdns.org`) works, and so does a subdomain of your own domain.
- An Amazon developer account **for the same Amazon account the Echo is registered to** (for Japan, that is
  amazon.co.jp). A skill created under another account never shows up on your Echo.
- `brew install lego dnsmasq`, Node.js 18+ (to run the skill's tests, optional).

## 1. Host name and certificate

1. Create the host name (DuckDNS: add `<you>` and set "current ip" to **any public IP**, e.g. `1.1.1.1`).
   Alexa's cloud only checks that it is not private. Note down the DuckDNS token (keep it out of chats and git;
   `~/.duckdns-token` with mode 600 works).
2. Get a Let's Encrypt certificate with a DNS-01 challenge (your Mac needs no public access for this):

   ```sh
   DUCKDNS_TOKEN=$(cat ~/.duckdns-token) lego run --path ~/.lego --email you@example.com --accept-tos \
     --dns duckdns --domains <you>.duckdns.org
   ```

   Files: `~/.lego/certificates/<you>.duckdns.org.crt` (the full chain) and `….key`. Check the chain has the
   intermediate certificate too (Echo rejects incomplete chains):

   ```sh
   openssl crl2pkcs7 -nocrl -certfile ~/.lego/certificates/<you>.duckdns.org.crt \
     | openssl pkcs7 -print_certs -noout | grep subject      # two or more lines
   ```

3. Certificates last 90 days. Install a weekly check that renews it when 30 days or less are left (a LaunchAgent, no
   `sudo`; it needs the DuckDNS token file from step 1):

   ```sh
   scripts/echo-lan/echo-lan.sh cert <you>.duckdns.org you@example.com        # add a token file path as a last argument if it isn't ~/.duckdns-token
   launchctl kickstart gui/$(id -u)/com.voynix.echo-cert-renew; tail ~/.lego/renew.log   # run it once now: "Skip renewal" is the expected answer
   ```

   It runs Mondays at 04:17 (when the Mac wakes, if it was asleep then) and logs to `~/.lego/renew.log`. Voynix notices
   the rewritten files by itself within seconds and needs no restart. If a renewal ever fails, the log says why; the
   old certificate keeps working until it expires. (Other DNS providers: use `lego run … --dns <provider> --renew-days 30`
   from your own job instead.)

## 2. A DNS for the Echo only

Give your Mac a fixed LAN IP in the router (DHCP reservation), then install a small dnsmasq that answers your
host name with that IP and forwards everything else to the router:

```sh
scripts/echo-lan/echo-lan.sh --dry-run dns <you>.duckdns.org <mac-lan-ip>   # shows what it will write
scripts/echo-lan/echo-lan.sh dns <you>.duckdns.org <mac-lan-ip>
dig +short <you>.duckdns.org @<mac-lan-ip>        # → the Mac's LAN IP
dig +short example.com @<mac-lan-ip>              # → a real answer (forwarded)
```

It runs as a LaunchDaemon (port 53 needs root) and doesn't conflict with Laravel Valet's dnsmasq, which only
listens on 127.0.0.1.

Then, **in the router, point only the Echo at it.** ASUS (stock firmware): LAN → DHCP Server → "Manual
Assignment": add the Echo (pick it from the client list), its IP, and DNS Server = the Mac's LAN IP; set
"Advertise router's IP in addition to user-specified DNS" to **No**. The WAN-side "DNS Server / Assign" page is
the router's own upstream DNS — don't use it. Restart the Echo so it renews its lease. Other routers: look for a
per-device DNS setting or an "override DNS for one device" option.

Check that the Echo uses it (optional): the installed dnsmasq doesn't log queries. To watch them for a minute, stop the
daemon, run dnsmasq in the foreground with logging, restart the Echo, and look for its IP asking for Amazon names
(Ctrl-C, then start the daemon again):

```sh
sudo launchctl bootout system /Library/LaunchDaemons/com.voynix.echo-dns.plist
sudo dnsmasq --no-daemon --log-queries --conf-file=/opt/homebrew/etc/voynix-echo-dnsmasq.conf   # path printed by the script
sudo launchctl bootstrap system /Library/LaunchDaemons/com.voynix.echo-dns.plist
```

## 3. Redirect port 443 to Voynix

Echo only connects to port 443, which an ordinary app can't bind. Voynix listens on **8443**, and a `pf` rule
redirects the Mac's own LAN address from 443 to 8443:

```sh
scripts/echo-lan/echo-lan.sh --dry-run pf <mac-lan-ip>
scripts/echo-lan/echo-lan.sh pf <mac-lan-ip>
```

It installs a rule in an anchor the stock `/etc/pf.conf` already evaluates (`com.apple/*`), so `/etc/pf.conf`
is untouched, and re-applies it at boot. The Mac can't test its own redirect; from another device on the LAN,
`curl -vk https://<mac-lan-ip>/play` should complete a TLS handshake (Voynix then answers 400/403).

## 4. Turn it on in Voynix

Settings → **Echo**:

1. Type the certificate (full chain) and private key paths, then click **Apply** (both are applied together — a new
   certificate with the old key would not load). Keep the port at 8443.
2. Tick **Enable Echo playback**. Ticking it before the paths are set shows "Set the certificate and private key files
   first" and unticks itself. The status line should say "Running on port 8443".
3. **Show / Copy** gives you the shared secret for the skill. Regenerating it invalidates the old secret and any URLs
   already handed to an Echo — update the skill's `config.json` afterwards.

If you also run a development build of Voynix, don't run both at once: they use the same port, and each keeps its own
secret in its own settings.

## 5. The Alexa skill

Source: [`alexa-skill/`](../alexa-skill) (see its README for what each file does). It's an Alexa-hosted (Node.js)
custom skill with the Audio Player interface. The invocation name in `ja-JP.json` is `ラジカセ` — change it if you like,
but pick a plain word that doesn't contain "music"/"ミュージック"/"プレイリスト" or sound like English
("マイミュージック" is swallowed by Amazon Music).

1. **Use the Echo's own Amazon account.** In the Alexa app, More → Settings → Account Settings shows which account the
   Echo belongs to (in Japan usually amazon.co.jp). Open <https://developer.amazon.com/alexa/console/ask> signed in with
   *that* account (register as a developer if asked — it's free; no certification, publishing or identity
   verification is needed, and a development skill only works on devices of the same account). The console may sign
   you in to a *different* Amazon account or region on its own: check the avatar menu, and sign out and in again if it
   is the wrong one. The Alexa app's "My Skills" doesn't list development skills, so it can't tell you if you are in
   the right place.
   Then Create Skill → any name, locale Japanese (JP), type **Other**, model **Custom**, hosting
   **Alexa-hosted (Node.js)**, region **US West (Oregon)** (US East has failed to provision), template
   **Start from scratch**.
2. Build → Interfaces → **Audio Player: on** → Save.
3. Build → Interaction Model → JSON Editor: paste `alexa-skill/skill-package/interactionModels/custom/ja-JP.json`
   → Save → **Build Skill**, and wait until "last successful build" shows a new time (saving alone changes nothing).
4. **Teach Alexa your playlist names.** Without this, speech recognition guesses (it heard "ヒロト＆マーシー" as
   "廣戸麻生" and nothing matched). In Voynix, Settings → Echo → **Copy playlist names**, then in the JSON Editor
   replace the `PLAYLIST` entry in the model's `"types"` list with what you copied, and **Build Skill** again.
   Repeat after adding or renaming playlists.
   - **Synonyms are how you fix mishearings.** If Alexa returns the wrong text, add that text (and how you'd say the
     name more simply) to the value's `"synonyms"`, e.g. `"name": {"value": "ヒロト＆マーシー", "synonyms": ["ヒロト", "廣戸麻生", "仕事マーシー"]}`.
     To see what Alexa heard: console → Code → **CloudWatch Logs**, search `REQUEST IntentRequest`, read
     `{"playlist":"…"}`. In the line `PLAY … list=…`, a canonical playlist name means Alexa matched it; the raw heard text
     (often kanji) means it did not. Person names have many kanji spellings, so expect a few rounds.
   - **An English name is not the same as its katakana.** Voynix matches case, width and kana, but not "For Drive" with
     "フォードライブ": add the katakana reading as a synonym.
5. Code: replace `lambda/package.json` and `lambda/index.js`, add `lambda/playback.js`, and create `lambda/config.json`
   from `config.example.json` (`baseUrl` = `https://<you>.duckdns.org`, `secret` = the one from Voynix) → **Save →
   Deploy**, and wait for the deploy to finish ("last deployed" updates) before testing.
6. Test tab → stage **Development**. In the simulator, type "*&lt;invocation name&gt;* を開いて" — the reply asks which
   playlist; then "*&lt;playlist&gt;* をかけて". The JSON output should contain an `AudioPlayer.Play` directive whose `url` is
   `https://<you>.duckdns.org/play?list=…`. On the Echo, say "Alexa, *&lt;invocation name&gt;* を開いて", then (no wake word
   needed for the answer) "*&lt;playlist&gt;* をかけて", or "…をシャッフルして" for shuffle. In Japanese the invocation name
   must be followed by a connecting word: "…を開いて", or "…で、*&lt;playlist&gt;* をかけて".

Copy files into the console with the clipboard so the secret never appears on screen
(`pbcopy < alexa-skill/lambda/config.json`), and clear the clipboard afterwards (`pbcopy < /dev/null`).

## Pitfalls on the Alexa side

- **The simulator passing proves little.** It runs the skill of the account you are signed in with in the console; the
  Echo runs the skill of *its* account. If the simulator answers with the new reply but the Echo gives an old one (or
  "お役に立てません"), the skill you edited belongs to a different Amazon account than the Echo's.
- **Saving isn't deploying.** After a model change, wait for the build to finish; after a code change, Save and then
  Deploy and wait. Trying too early runs the previous version.
- **A name that sounds like a built-in gets taken over.** "マイミュージック" and anything with ミュージック / 音楽 /
  プレイリスト goes to Amazon Music; a coined brand name can be misheard ("ボイニックス" became "v nex"). Use a plain
  katakana word; test it by typing it in the Alexa app's "Ask Alexa" first.
- **Japanese needs a connecting word after the invocation name.** "ラジカセ ヒロトをかけて" in one breath is not
  recognized as your skill; say "ラジカセを開いて" and then the playlist, or "ラジカセで、ヒロトをかけて".
- **The CloudWatch page's red "not authorized to perform cloudwatch:GetMetricData" banner is harmless** — the log
  events below it are what you want.

## Checking and troubleshooting

| Symptom | Look at |
|---|---|
| "お役に立てません" / the skill doesn't open | Wrong Amazon account (the Echo's account ≠ the developer account); the invocation name is swallowed by a built-in or missing its connecting word ("…を開いて"); the model wasn't rebuilt. Try typing the phrase into the Alexa app's "Ask Alexa". |
| Echo opens an old version of the skill (an older reply) | The code was pasted into a skill under a different Amazon account than the Echo's (the simulator uses the console's account, so it can pass while the Echo doesn't), or the deploy hasn't finished. |
| Skill opens, Echo says nothing / stops | The skill's CloudWatch log (console → Code → Logs): `SESSION ENDED` with `INVALID_RESPONSE` means Alexa's cloud rejected the URL (the host name resolves to a private IP for it — check the public record with `dig +short <host> @1.1.1.1`). `PLAYBACK FAILED` carries the error type. |
| No lines in Voynix's output for the Echo | DNS: is the Echo's per-device DNS setting applied (restart the Echo), and does dnsmasq see it asking for your host name (see step 2)? |
| Echo connects but a TLS error | Certificate chain incomplete, or the host name differs from the certificate's. |
| 403 in Voynix's log | Expired or wrong-secret signature (the secret in `config.json` ≠ Voynix's), or a request from a non-LAN address. |
| Plays the "playlist not found" voice | The spoken name matched nothing, or the playlist is empty. The skill's log shows what Alexa heard (`PLAY … list=…`): if it's kanji or another spelling, add the playlist names to the model with synonyms (step 5.4). An English name needs its katakana reading as a synonym. |
| Skips / silence on FLAC, ALAC | `afconvert` missing or the first conversion is slow; the next track is converted ahead while the current one plays. |

Voynix logs one line per request to its stderr (`echo /play <ip> i=… seed=… -> <status>`); signatures are never logged.

## Limits

- **The Mac must be awake.** If it sleeps or quits, the Echo can't reach it — and since the Echo uses the Mac's DNS,
  its *other* name lookups fail too. If that bites, move the dnsmasq to an always-on device (a Raspberry Pi, a NAS)
  and point the Echo's DNS there instead; nothing else changes.
- Only the Echo you point at the DNS can play (other Echos resolve the host name to the public IP and fail).
- Tracks whose file is missing on disk (or on an unmounted drive) are skipped; if the same recording exists at two
  paths, the one that exists is played. A track that can't be converted (an unsupported format) still stops the queue.
- A link is valid for `ttlSeconds` (2 hours by default) from when the skill signs it. A single track longer than that
  (an audiobook, a long mix) can fail if the Echo re-requests it after the link expires; raise `ttlSeconds` in the
  skill's `config.json` if you play such files.
- Converted files are kept in `remote-cache/` in the app's data folder and deleted after 30 days.
- At the end of a playlist the skill's queued next track gets a 404 and the Echo stops, with a failed-playback entry in
  the log. That's expected.
- The public DNS record and the certificate are public: the host name (not your LAN IP or music) is visible.

## Removing it

`scripts/echo-lan/echo-lan.sh uninstall` removes the DNS and port-redirect LaunchDaemons and the weekly certificate
check; then take the Echo's DNS setting out of the router, untick the setting in Voynix, and delete the skill in the
Alexa console.

## Security notes

- The server only accepts connections from private addresses and only serves `/play`. A URL is valid for 2 hours
  (set by the skill) and is bound to one playlist, track number and shuffle seed.
- The shared secret lets anyone who has it make Voynix play your music from your network, nothing more; it is kept in
  Voynix's local settings, never in backups, and in the skill's `config.json` (git-ignored). Treat it like a password
  and don't paste it into chats.
- Don't forward port 443 on your router; this feature is meant to stay inside your home network.
