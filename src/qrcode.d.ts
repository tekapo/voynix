// Minimal typing for the one `qrcode` API we use. @types/qrcode would be the
// usual route, but it drags in @types/node, whose `node:sqlite` typings then
// break `tsc` for src/test/sqliteDevice.ts.
declare module "qrcode" {
    interface QRCodeToStringOptions {
        type?: "svg" | "utf8" | "terminal";
        margin?: number;
        errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    }
    const QRCode: {
        toString(text: string, options?: QRCodeToStringOptions): Promise<string>;
    };
    export default QRCode;
}
