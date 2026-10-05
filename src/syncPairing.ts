import QRCode from "qrcode";
import type { ServerStatus } from "./types";

/** The pairing QR payload the Android app scans (`parsePairingQr` in
 *  android-native/.../logic/Sync.kt). The fingerprint rides along so the phone
 *  can pin the certificate straight from the QR — it replaces the manual
 *  security-code comparison, since the QR is read off the Mac's own screen. */
export const pairingQrPayload = (status: Pick<ServerStatus, "url" | "token" | "fingerprint">): string =>
    `voynix://pair?u=${encodeURIComponent(status.url)}&t=${encodeURIComponent(status.token)}&fp=${status.fingerprint}`;

/** SVG data URI of the pairing QR, for an <img src>. */
export const pairingQrDataUri = async (status: Pick<ServerStatus, "url" | "token" | "fingerprint">): Promise<string> => {
    const svg = await QRCode.toString(pairingQrPayload(status), { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};
