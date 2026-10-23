import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { effectiveAlbum } from "../albumName";
import { artistOf } from "../names";
import { Track } from "../types";
import { useTauriEvent } from "./useTauriEvent";

export interface MediaSessionActions {
    togglePlay: () => void;
    handleSeek: (seconds: number) => void;
    handleSkip: (delta: number) => void;
    playAdjacent: (dir: 1 | -1) => void;
    skipSeconds: number;
}

/** Payload of the `media-action` event (see src-tauri/src/now_playing.rs). */
type MediaAction = "play" | "pause" | "toggle" | "next" | "previous" | { seek: number };

/** Re-publish the position only when it drifts this far (seconds) from what
 *  the OS would extrapolate from the last one we sent — i.e. after a seek. */
const POSITION_DRIFT = 2;

/**
 * Publishes the now-playing track to the OS (macOS Now Playing: media keys,
 * Control Center, headphone buttons) and wires its play/pause/seek/next/
 * previous commands back into the app.
 *
 * This goes through the native MPRemoteCommandCenter rather than
 * `navigator.mediaSession`: music plays in the Rust engine, so WebKit never
 * has an `<audio>` element playing and never registers the page as Now
 * Playing — the media keys then went to whatever other app (e.g. a browser
 * tab) was. Podcasts do use `<audio>`, but registering a second source would
 * compete with this one, so the web API isn't used at all.
 *
 * Commands arrive as `media-action` events; the ref holds the latest
 * closures — same pattern as App.tsx's `dockActionsRef` — so one long-lived
 * listener always calls into whatever `actions` most recently were.
 *
 * Returns `syncPosition(seconds)`, to be called from the playback position
 * tick: it re-publishes only on a seek, since the OS advances the scrubber
 * itself from the last position and `rate`.
 */
export function useMediaSession(
    currentTrack: Track | null,
    artwork: string | null,
    isPlaying: boolean,
    rate: number,
    actions: MediaSessionActions,
): (seconds: number) => void {
    const positionRef = useRef(0);
    // What the OS believes the position is: the last value sent, advanced by
    // wall-clock time while playing.
    const sentRef = useRef({ position: 0, at: 0, playing: false, rate: 1 });

    const publish = useCallback((track: Track, playing: boolean, speed: number) => {
        const position = positionRef.current;
        sentRef.current = { position, at: performance.now(), playing, rate: speed };
        invoke("set_now_playing", {
            info: {
                title: track.title,
                artist: artistOf(track),
                album: effectiveAlbum(track) ?? "",
                duration: track.duration ?? 0,
                position,
                rate: speed,
                playing,
            },
        }).catch(() => { /* no native layer (tests, web preview) */ });
    }, []);

    // The cover is a large `data:` URI, so it's sent on its own and only when
    // it changes; the native side attaches it to every later publish.
    const artworkRef = useRef<string | null>(null);

    useEffect(() => {
        if (!currentTrack) {
            positionRef.current = 0;
            artworkRef.current = null;
            invoke("set_now_playing_artwork", { dataUri: null })
                .then(() => invoke("set_now_playing", { info: null }))
                .catch(() => {});
            return;
        }
        if (artworkRef.current === artwork) {
            publish(currentTrack, isPlaying, rate);
            return;
        }
        // Artwork first, so the publish below already carries it.
        artworkRef.current = artwork;
        let alive = true;
        invoke("set_now_playing_artwork", { dataUri: artwork })
            .catch(() => { /* no native layer (tests, web preview) */ })
            .then(() => { if (alive) publish(currentTrack, isPlaying, rate); });
        return () => { alive = false; };
        // Re-run on the track's identity and display fields, not on every
        // object replacement (e.g. a play-count patch).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentTrack?.id, currentTrack?.title, artwork, isPlaying, rate, publish]);

    // A new track starts from 0 until its first position tick says otherwise.
    useEffect(() => { positionRef.current = 0; }, [currentTrack?.id]);

    const trackRef = useRef(currentTrack);
    trackRef.current = currentTrack;
    const stateRef = useRef({ isPlaying, rate });
    stateRef.current = { isPlaying, rate };

    const syncPosition = useCallback((seconds: number) => {
        positionRef.current = seconds;
        const track = trackRef.current;
        if (!track) return;
        const s = sentRef.current;
        const expected = s.position + (s.playing ? ((performance.now() - s.at) / 1000) * s.rate : 0);
        if (Math.abs(seconds - expected) > POSITION_DRIFT) {
            publish(track, stateRef.current.isPlaying, stateRef.current.rate);
        }
    }, [publish]);

    const actionsRef = useRef(actions);
    actionsRef.current = actions;
    const isPlayingRef = useRef(isPlaying);
    isPlayingRef.current = isPlaying;
    useTauriEvent<MediaAction>("media-action", (a) => {
        const act = actionsRef.current;
        if (a === "toggle") act.togglePlay();
        // play/pause are no-ops when already in that state (e.g. a headset
        // sending "play" while playing).
        else if (a === "play") { if (!isPlayingRef.current) act.togglePlay(); }
        else if (a === "pause") { if (isPlayingRef.current) act.togglePlay(); }
        else if (a === "next") act.playAdjacent(1);
        else if (a === "previous") act.playAdjacent(-1);
        else if (typeof a === "object" && a !== null && "seek" in a) act.handleSeek(a.seek);
    });

    return syncPosition;
}
