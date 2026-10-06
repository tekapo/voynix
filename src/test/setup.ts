import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";
import i18n from "../i18n";

// The 1 s default for waitFor/findBy* is too tight on a loaded CI runner
// (playback start is async audio + DB work); passing tests aren't slowed by a
// longer ceiling.
configure({ asyncUtilTimeout: 5000 });

afterEach(async () => {
    cleanup();
    // Components read hooks' text via i18next, so a test that switches
    // language (e.g. a settings-language test) must not leak into the next.
    await i18n.changeLanguage("en");
});

// jsdom implements <audio>/<video> elements but not their playback behavior
// (play/pause/load are no-ops that don't even exist, and currentTime/duration
// aren't settable) — App.tsx's load-and-play effect (readFile -> Blob ->
// objectURL -> el.play()) needs at least this much to run under jsdom.
// Kept minimal: resolves play() immediately and tracks paused state; anything
// wanting real decode/seek behavior belongs in a manual/real-device check,
// not this suite.
if (typeof HTMLMediaElement !== "undefined") {
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
        configurable: true,
        writable: true,
        value: function play(this: HTMLMediaElement) {
            Object.defineProperty(this, "paused", { configurable: true, value: false });
            this.dispatchEvent(new Event("play"));
            this.dispatchEvent(new Event("playing"));
            return Promise.resolve();
        },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
        configurable: true,
        writable: true,
        value: function pause(this: HTMLMediaElement) {
            Object.defineProperty(this, "paused", { configurable: true, value: true });
            this.dispatchEvent(new Event("pause"));
        },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "load", {
        configurable: true,
        writable: true,
        value: function load() {},
    });
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
        configurable: true,
        writable: true,
        value: true,
    });
}

if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: () => "blob:mock" });
}
if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: () => {} });
}
