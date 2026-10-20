import { getSetting, setSetting } from "./settings";

// Settings for the Echo (Alexa) playback server. All off/empty by default; none of
// these keys are in BACKUP_SETTING_KEYS — the shared secret is a credential and
// the rest describes this machine's certificate files.

/** The port the host's `pf` rule redirects 443 to (see docs/echo-lan.md). */
export const DEFAULT_REMOTE_PORT = 8443;

export interface RemoteSettings {
    enabled: boolean;
    port: number;
    certPath: string;
    keyPath: string;
}

function randomHex(bytes: number): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
}

export async function getRemoteSettings(): Promise<RemoteSettings> {
    const [enabled, portRaw, certPath, keyPath] = await Promise.all([
        getSetting("remote_enabled"),
        getSetting("remote_port"),
        getSetting("remote_cert_path"),
        getSetting("remote_key_path"),
    ]);
    const port = Number(portRaw);
    return {
        enabled: enabled === "1",
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_REMOTE_PORT,
        certPath: certPath ?? "",
        keyPath: keyPath ?? "",
    };
}

export async function setRemoteEnabled(enabled: boolean) {
    await setSetting("remote_enabled", enabled ? "1" : "0");
}

export async function setRemotePort(port: number) {
    await setSetting("remote_port", String(port));
}

export async function setRemoteCertPaths(certPath: string, keyPath: string) {
    await setSetting("remote_cert_path", certPath.trim());
    await setSetting("remote_key_path", keyPath.trim());
}

/** HMAC key shared with the Alexa skill, which signs every `/play` URL with it.
 *  Generated on first use. */
export async function getRemoteSecret(): Promise<string> {
    let value = await getSetting("remote_secret");
    if (!value) {
        value = randomHex(32);
        await setSetting("remote_secret", value);
    }
    return value;
}

/** Replaces the secret: the skill must be updated with the new one, and every
 *  URL already handed to an Echo stops verifying. */
export async function regenerateRemoteSecret(): Promise<string> {
    const secret = randomHex(32);
    await setSetting("remote_secret", secret);
    return secret;
}
