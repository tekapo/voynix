# Voynix Echo skill

The Alexa-hosted (Node.js) custom skill behind Voynix's opt-in Echo playback. It never talks to your Mac: it turns
the playlist name you say into a signed `https://<your host>/play?…` URL and hands it to the Echo, which fetches the
audio from your Mac over your LAN. The whole setup (certificate, DNS, port redirect, this skill) is in
[`docs/echo-lan.md`](../docs/echo-lan.md) ([日本語](../docs/echo-lan.ja.md)); this page only says what is here.

## Files

| Path | What it is |
|---|---|
| `skill-package/interactionModels/custom/ja-JP.json` | The ja-JP interaction model: invocation name `ラジカセ`, the play / shuffle intents, and a `PLAYLIST` slot type. Paste it into the console's JSON Editor, then replace the `PLAYLIST` values with your own (Voynix: Settings → Echo → *Copy playlist names*). |
| `skill-package/skill.json` | The manifest (Audio Player interface). The console sets this up when you turn Audio Player on. |
| `lambda/index.js` | The request handlers: launch, play / shuffle a playlist, pause / resume, next / previous (voice and device buttons), queueing the next track before the current one ends, logging. |
| `lambda/playback.js` | Pure helpers: signing the URL, the AudioPlayer token, resolving the slot to the playlist's canonical name. |
| `lambda/playback.test.js` | Tests for the helpers (`cd alexa-skill/lambda && node --test`). One signature test vector is shared with `src-tauri/src/remote.rs`: both sides must agree on the signing format. |
| `lambda/config.example.json` | Copy to `lambda/config.json` (git-ignored) and fill in `baseUrl` and the shared `secret` from Voynix. |

## Putting it in the console

In this order, each followed by a build or deploy that you wait for (details and the mistakes people make are in the guide):

1. Model: paste `ja-JP.json` → Save → **Build Skill**.
2. Code: `lambda/package.json`, `lambda/index.js`, `lambda/playback.js`, `lambda/config.json` → Save → **Deploy**.
3. Test stage **Development**; say "*invocation name* を開いて", then the playlist name.

Use the clipboard so the secret never shows on screen, and empty it afterwards:

```sh
pbcopy < alexa-skill/lambda/config.json    # paste into the console's lambda/config.json
pbcopy < /dev/null
```

The skill must belong to the same Amazon account the Echo is registered to; the console's simulator works for any
account, which can hide a mismatch.
