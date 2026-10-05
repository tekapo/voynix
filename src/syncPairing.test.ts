import { describe, expect, it } from "vitest";
import { pairingQrDataUri, pairingQrPayload } from "./syncPairing";
import pairingVectors from "../docs/test-vectors/pairing-qr.json";

describe("pairingQrPayload", () => {
    it("matches the shared test vectors (the Android parser reads the same ones)", () => {
        for (const v of pairingVectors.vectors) {
            expect(pairingQrPayload({ url: v.url, token: v.token, fingerprint: v.fingerprint })).toBe(v.payload);
        }
    });
});

describe("pairingQrDataUri", () => {
    it("renders an SVG data URI", async () => {
        const v = pairingVectors.vectors[0];
        const uri = await pairingQrDataUri({ url: v.url, token: v.token, fingerprint: v.fingerprint });
        expect(uri.startsWith("data:image/svg+xml;utf8,")).toBe(true);
        expect(decodeURIComponent(uri.slice("data:image/svg+xml;utf8,".length))).toContain("<svg");
    });
});
