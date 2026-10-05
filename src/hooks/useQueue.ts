import { Dispatch, MutableRefObject, SetStateAction, useEffect, useRef, useState } from "react";
import i18n from "../i18n";
import { PlayerEngine, toEngineTrack } from "../player/engine";
import { buildOrder, effectiveShuffle, peekNext, removeUpcoming, RepeatMode, reorderUpcoming, stepOrder } from "../queue";
import { Track } from "../types";

export interface UseQueueParams {
    engine: PlayerEngine;
    setCurrentTrack: Dispatch<SetStateAction<Track | null>>;
    setIsPlaying: (playing: boolean) => void;
    setLoadToken: Dispatch<SetStateAction<number>>;
    setError: (message: string | null) => void;
    podcastNoShuffle: boolean;
    /** Shared with App.tsx's load effect — see that effect for how each is used. */
    pendingPlayRef: MutableRefObject<string | null>;
    loadedTrackIdRef: MutableRefObject<string | null>;
    nativeAdvancedToIdRef: MutableRefObject<string | null>;
}

/**
 * The playback queue: `queue`/`order`/`orderPos`/`repeatMode`/`shuffle`, the
 * actions that mutate them, and the gapless `engine.setNext()` bookkeeping
 * that rides on top. Extracted out of App.tsx (see the plan this came from).
 *
 * Deliberately NOT moved here (stays in App.tsx): the track-load effect
 * (currentTrack/loadToken/engine.load() is its own concern, not the queue's),
 * and the session-restore / auto-arm effects (tangled with restore-only refs
 * like pendingSeekRef/restoredRef/armRef). Those call back into this hook's
 * return value (`updateEngineNext`, the raw setters, `onEngineAdvanced`).
 */
export function useQueue({
    engine,
    setCurrentTrack,
    setIsPlaying,
    setLoadToken,
    setError,
    podcastNoShuffle,
    pendingPlayRef,
    loadedTrackIdRef,
    nativeAdvancedToIdRef,
}: UseQueueParams) {
    // Play queue: an ordered snapshot of the list the user started from, plus the
    // order it's actually played in. `order` holds indices into `queue` — identity
    // when shuffle is off, a full permutation when it's on — and `orderPos` is the
    // cursor into it. Since normal playback only moves `orderPos` forward,
    // `order[0..orderPos]` is the real play history, which is what ⏮ walks back
    // through. Kept separate from the visible track list so browsing another
    // playlist doesn't disturb what's playing.
    const [queue, setQueue] = useState<Track[]>([]);
    const [order, setOrder] = useState<number[]>([]);
    const [orderPos, setOrderPos] = useState(-1);
    const [repeatMode, setRepeatMode] = useState<RepeatMode>("off");
    const [shuffle, setShuffle] = useState(false);
    /** Index into `queue` of what's playing; -1 before playback starts. */
    const queueIndex = orderPos >= 0 ? order[orderPos] ?? -1 : -1;

    // The { queue position, track id } engine.setNext() was last called with, so
    // the onAdvanced handler can find where in `order` that track lives without
    // re-deriving it (and so it can tell a real advance from a stale one).
    const pendingNextRef = useRef<{ pos: number; trackId: string } | null>(null);

    // `playAdjacent` runs from handlers whose closures may predate the latest
    // render — the <audio> element's listener and the OS media-session handlers
    // registered once in an effect. Mirror everything it reads so it always sees
    // live values (same pattern as `nativeTransport` below). Assigned during
    // render, not in an effect: an effect runs after paint, leaving a window where
    // an `ended` event reads the previous render's queue/order.
    const navRef = useRef({ queue, order, orderPos, repeatMode, shuffle, podcastNoShuffle });
    navRef.current = { queue, order, orderPos, repeatMode, shuffle, podcastNoShuffle };

    // Compute + hand the engine the track that should play next, for a gapless
    // transition (native engine only — see PlayerEngine.setNext). Reads live
    // state via navRef so it's safe to call both from the reactive effect below
    // (queue/order/shuffle/repeat changed while already playing) *and*
    // explicitly right after `engine.load()` resolves in the load effect.
    //
    // That second call site turned out to matter: `engine.setNext()`'s
    // `invoke()` has no leading await, but `engine.load()`'s does (it awaits
    // NativeEngine's `this.ready` first) — so when both the load effect and
    // this hook's own reactive effect fire in the same render (any manual
    // jump: double-click, ⏭/⏮, initial arm+play, restore…), setNext's IPC call
    // was reaching the Rust side *before* load's, landing on the track that
    // was just about to be flushed away and getting dropped with it. The next
    // track then never got queued for that entire playback, silently falling
    // back to a normal (non-gapless) reload at every boundary. Calling this
    // again once load() has actually resolved guarantees at least one setNext
    // lands on the right (now-current) track.
    const updateEngineNext = () => {
        const { queue, order, orderPos, repeatMode, shuffle, podcastNoShuffle } = navRef.current;
        if (queue.length === 0 || orderPos < 0) {
            engine.setNext(null);
            pendingNextRef.current = null;
            return;
        }
        const shuffled = effectiveShuffle(shuffle, podcastNoShuffle, queue);
        const idx = peekNext(orderPos, order, { repeat: repeatMode, shuffled });
        const track = idx != null ? queue[idx] : undefined;
        if (!track) {
            engine.setNext(null);
            pendingNextRef.current = null;
            return;
        }
        const pos = repeatMode === "one" ? orderPos : (orderPos + 1 < order.length ? orderPos + 1 : 0);
        pendingNextRef.current = { pos, trackId: track.id };
        engine.setNext(toEngineTrack(track));
    };

    // Cue `track` (making `list` the queue) without playing it — a single click on
    // a row. Deals a fresh play order; under shuffle the cued track opens the pass.
    const armFromList = (list: Track[], track: Track) => {
        const start = list.findIndex(t => t.id === track.id);
        const nextOrder = buildOrder(list.length, { shuffle: effectiveShuffle(shuffle, podcastNoShuffle, list), first: start });
        setQueue(list);
        setOrder(nextOrder);
        setOrderPos(nextOrder.indexOf(start));
        setCurrentTrack(track); // no pendingPlayRef → cued only, the load effect won't play
    };

    // Start playing `track` immediately — a double click, or ▶ after cueing.
    const playFromList = (list: Track[], track: Track) => {
        // Already loaded in the engine: never reload it — that would restart from
        // 0. A mistouch on the playing row is a no-op; on a paused row it resumes
        // from where it was left.
        if (loadedTrackIdRef.current === track.id) {
            if (engine.isPaused()) {
                engine.play().then(() => setIsPlaying(true)).catch(e => setError(i18n.t("errors.resumeFailed", { error: e.message })));
            }
            return;
        }
        armFromList(list, track);
        pendingPlayRef.current = track.id;
        setLoadToken(t => t + 1); // force the load effect even if the id is unchanged
    };

    // Toggling shuffle re-deals the play order around whatever is playing: the
    // current track becomes position 0 of a fresh permutation (on), or the cursor
    // moves to its natural slot in the original list order (off). Reads render
    // state, not navRef — only ever called from PlayerBar's fresh onClick.
    const toggleShuffle = () => {
        const next = !shuffle;
        setShuffle(next);
        if (queue.length === 0) return;
        const nextOrder = buildOrder(queue.length, {
            shuffle: effectiveShuffle(next, podcastNoShuffle, queue),
            first: queueIndex >= 0 ? queueIndex : undefined,
        });
        setOrder(nextOrder);
        setOrderPos(nextOrder.indexOf(queueIndex)); // 0 when shuffling, queueIndex when not, -1 if stopped
    };

    // Move the play cursor. `fromEnded` lets repeat-one replay the current track
    // when it finishes on its own; a manual ⏭ always advances.
    const playAdjacent = (dir: 1 | -1, fromEnded = false) => {
        const { queue, order, orderPos, repeatMode, shuffle, podcastNoShuffle } = navRef.current;
        if (queue.length === 0) return;
        if (dir === 1 && fromEnded && repeatMode === "one") {
            engine.seek(0);
            engine.play().catch(() => {});
            return;
        }
        const step = stepOrder(orderPos, order.length, dir, { repeat: repeatMode });
        if (step == null) { setIsPlaying(false); return; }
        let nextOrder = order;
        if (step.reshuffle && effectiveShuffle(shuffle, podcastNoShuffle, queue)) {
            // A full pass just finished — deal a new permutation, but don't let the
            // track that just played open the next pass.
            nextOrder = buildOrder(queue.length, { shuffle: true, avoidFirst: order[orderPos] });
            setOrder(nextOrder);
        }
        const idx = nextOrder[step.pos]; // read the local, not `order` (setOrder is async)
        if (idx == null) return;
        setOrderPos(step.pos);
        pendingPlayRef.current = queue[idx].id;
        setCurrentTrack(queue[idx]);
    };

    // --- Queue panel actions (operate on `order`, never the `queue` snapshot) ---

    // Jump playback to any row in the queue — played, current (no-op) or upcoming.
    const jumpInQueue = (pos: number) => {
        if (pos === orderPos) return;
        const idx = order[pos];
        if (idx == null || queue[idx] == null) return;
        setOrderPos(pos);
        pendingPlayRef.current = queue[idx].id;
        setCurrentTrack(queue[idx]);
    };

    const moveInQueue = (pos: number, dir: 1 | -1) =>
        setOrder(prev => reorderUpcoming(prev, orderPos, pos, dir));

    const removeFromQueue = (pos: number) =>
        setOrder(prev => removeUpcoming(prev, orderPos, pos));

    // Append a track to the end of the play order. The new track lands at
    // `queue.length` in the *queue* array; that must be read here, not as
    // `order`'s own previous length — `removeFromQueue` shrinks `order`
    // without shrinking `queue` (it only drops upcoming entries, the queue
    // snapshot keeps the track), so after a removal the two lengths diverge
    // and appending by `order.length` would point at a leftover, unrelated
    // queue slot instead of the track just added.
    const addToQueue = (track: Track) => {
        if (queue.length === 0) { playFromList([track], track); return; }
        const newIndex = queue.length;
        setQueue(prev => [...prev, track]);
        setOrder(prev => [...prev, newIndex]);
    };

    // --- Collection-level actions (album/artist/playlist context menus) ---

    // Play a whole collection, optionally re-dealt into a shuffled order. Unlike
    // playFromList this can't read a stale `shuffle` closure — it sets the mode and
    // builds the order from the same local value in one go.
    const playCollection = (tracks: Track[], opts?: { shuffle?: boolean }) => {
        if (tracks.length === 0) return;
        const sh = opts?.shuffle ?? false;
        setShuffle(sh);
        const first = sh ? Math.floor(Math.random() * tracks.length) : 0;
        const nextOrder = buildOrder(tracks.length, { shuffle: effectiveShuffle(sh, podcastNoShuffle, tracks), first });
        setQueue(tracks);
        setOrder(nextOrder);
        setOrderPos(nextOrder.indexOf(first));
        pendingPlayRef.current = tracks[first].id;
        setCurrentTrack(tracks[first]);
        setLoadToken(t => t + 1);
    };

    // Append every track of a collection to the play order in one update — calling
    // addToQueue in a loop would re-read the same stale `queue` length each time.
    // Base index from `queue.length`, not `order`'s — see addToQueue's comment.
    const addCollectionToQueue = (tracks: Track[]) => {
        if (tracks.length === 0) return;
        if (queue.length === 0) { armFromList(tracks, tracks[0]); return; }
        const base = queue.length;
        setQueue(prev => [...prev, ...tracks]);
        setOrder(prev => [...prev, ...tracks.map((_, i) => base + i)]);
    };

    // The engine transitioned on its own — via a track we handed it through
    // setNext, for a gapless transition. Move our own cursor to match
    // without touching the engine (it's already playing `trackId`).
    const onEngineAdvanced = (trackId: string) => {
        const { queue, order, orderPos } = navRef.current;
        const pending = pendingNextRef.current;
        pendingNextRef.current = null;
        let pos = (pending && queue[order[pending.pos]]?.id === trackId) ? pending.pos : -1;
        if (pos < 0) {
            pos = order.findIndex((qi, i) => i !== orderPos && queue[qi]?.id === trackId);
        }
        const track = queue.find(t => t.id === trackId);
        if (!track || pos < 0) return;
        if (pos === orderPos) {
            // Handed off to the *same* queue slot (repeat-one, or repeat-all on a one-track
            // queue). Nothing below would change React state, so neither the load effect
            // nor the setNext effect would run: no further copy would be queued, and the
            // flag set in the branch below would stay stale. Queue the next copy now.
            updateEngineNext();
            return;
        }
        nativeAdvancedToIdRef.current = trackId;
        setOrderPos(pos);
        pendingPlayRef.current = trackId;
        setCurrentTrack(track);
    };

    // Recomputes updateEngineNext (defined above) whenever the queue itself,
    // its play order, or anything that affects either changes *while a track
    // is already playing* (shuffle/repeat toggles, reordering). The load
    // effect covers the "a track just started" case itself, explicitly —
    // see updateEngineNext's own comment for why that extra call site exists.
    useEffect(() => {
        updateEngineNext();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [engine, queue, order, orderPos, repeatMode, shuffle, podcastNoShuffle]);

    return {
        queue, setQueue,
        order, setOrder,
        orderPos, setOrderPos,
        repeatMode, setRepeatMode,
        shuffle, setShuffle,
        queueIndex,
        navRef,
        armFromList,
        playFromList,
        playCollection,
        playAdjacent,
        jumpInQueue,
        addToQueue,
        addCollectionToQueue,
        moveInQueue,
        removeFromQueue,
        toggleShuffle,
        updateEngineNext,
        onEngineAdvanced,
    };
}

export type QueueApi = ReturnType<typeof useQueue>;
