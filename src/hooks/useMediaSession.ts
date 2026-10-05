import { useEffect, useRef } from "react";
import { effectiveAlbum } from "../albumName";
import { artistOf } from "../names";
import { Track } from "../types";

export interface MediaSessionActions {
    togglePlay: () => void;
    handleSeek: (seconds: number) => void;
    handleSkip: (delta: number) => void;
    playAdjacent: (dir: 1 | -1) => void;
    skipSeconds: number;
}

/**
 * Publishes the now-playing track to the OS media session (macOS media
 * controls / keyboard media keys / car head units) and wires its play/pause/
 * seek/skip/previous/next actions back into the app.
 *
 * Two independent effects pulled out of App.tsx:
 *   - metadata/playbackState publish, re-run whenever what it displays changes.
 *   - action handlers, registered once — same "ref holds the latest
 *     closures" pattern App.tsx already uses for the Dock menu
 *     (`dockActionsRef`) and the engine event trampoline
 *     (`engineHandlersRef`), so an OS button press always calls into
 *     whatever `actions` most recently were, without needing to re-list
 *     every piece of state those closures happen to depend on as effect deps.
 *
 * Not included: `setPositionState()`, called from App.tsx's position-tick
 * handler (`handleTimeUpdate`) rather than from an effect here — it's driven
 * by playback progress, not by one of these values changing.
 */
export function useMediaSession(
    currentTrack: Track | null,
    currentArtwork: string | null,
    isPlaying: boolean,
    actions: MediaSessionActions,
) {
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        const ms = navigator.mediaSession;
        if (!currentTrack) {
            ms.metadata = null;
            ms.playbackState = "none";
            return;
        }
        ms.metadata = new MediaMetadata({
            title: currentTrack.title,
            artist: artistOf(currentTrack),
            album: effectiveAlbum(currentTrack) ?? "",
            artwork: currentArtwork ? [{ src: currentArtwork }] : [],
        });
        ms.playbackState = isPlaying ? "playing" : "paused";
    }, [currentTrack, currentArtwork, isPlaying]);

    const actionsRef = useRef(actions);
    actionsRef.current = actions;
    // `isPlaying` isn't read via the ref: it decides whether "play" or
    // "pause" is a no-op, and the ref wouldn't be current at the moment a
    // stale closure's condition is checked the same way a fresh effect
    // dependency is — so this one effect still re-registers on it, same as
    // the original code.
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        const ms = navigator.mediaSession;
        const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
            try { ms.setActionHandler(action, handler); } catch { /* action unsupported on this WebView */ }
        };
        set("play", () => { if (!isPlaying) actionsRef.current.togglePlay(); });
        set("pause", () => { if (isPlaying) actionsRef.current.togglePlay(); });
        set("seekto", (d) => { if (d.seekTime != null) actionsRef.current.handleSeek(d.seekTime); });
        set("seekbackward", (d) => actionsRef.current.handleSkip(-(d.seekOffset ?? actionsRef.current.skipSeconds)));
        set("seekforward", (d) => actionsRef.current.handleSkip(d.seekOffset ?? actionsRef.current.skipSeconds));
        set("previoustrack", () => actionsRef.current.playAdjacent(-1));
        set("nexttrack", () => actionsRef.current.playAdjacent(1));
        return () => {
            for (const a of ["play", "pause", "seekto", "seekbackward", "seekforward", "previoustrack", "nexttrack"] as const) set(a, null);
        };
    }, [isPlaying]);
}
