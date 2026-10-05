import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import i18n from "../i18n";
import { useTauriEvent } from "./useTauriEvent";
import {
  applySyncInbox,
  buildSyncSnapshot,
  getSetting,
  getSyncServerPort,
  getSyncToken,
  getTranscodeOptions,
  setSetting,
  setSyncServerPort,
  setTranscodeBitrate,
  setTranscodeFormat as dbSetTranscodeFormat,
} from "../db";
import type { TranscodeFormat } from "../db";
import { IncomingStats, Playlist, ServerActivity, ServerStatus } from "../types";

/** How many times a failed inbox item is handed back before it's dropped (3s poll ⇒ ~15s). */
const MAX_INBOX_RETRIES = 5;

/**
 * Reconciles React's view of the server with the live Rust status, keeping the
 * previous object when nothing visible changed (avoids re-renders). The IP is
 * compared too: it changes when the Mac moves networks while the server runs.
 */
export function nextServerStatus(prev: ServerStatus | null, live: ServerStatus | null): ServerStatus | null {
  if (!live) return prev ? null : prev;
  if (prev && prev.running === live.running && prev.port === live.port && prev.ip === live.ip) return prev;
  return live;
}

interface UseSyncServerParams {
  playlists: Playlist[];
  refreshPlaylists: () => Promise<void>;
  setError: (message: string | null) => void;
}

/**
 * The LAN sync server (start/stop, snapshot push, inbox poll, pairing) plus
 * the transcode settings that feed it and the Sync modal's own open state.
 */
export function useSyncServer({ playlists, refreshPlaylists, setError }: UseSyncServerParams) {
  // `refreshPlaylists` is a fresh function identity every render (a plain
  // `async function` declared in App's body) — closing over it directly in an
  // effect with non-`[playlists,...]` deps would capture a stale (but
  // harmless) copy forever; the interval/debounced effects below need the
  // *latest* one without retriggering on every render, so mirror it through a
  // ref (same idiom as App.tsx's `trackHandlersRef`).
  const refreshPlaylistsRef = useRef(refreshPlaylists);
  refreshPlaylistsRef.current = refreshPlaylists;

  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [serverActivity, setServerActivity] = useState<ServerActivity | null>(null);
  // Start the sync server automatically on launch. Default ON — without this
  // a paired device's saved peer URL is useless until someone opens the Sync
  // modal and presses Start every time.
  const [serverAutostart, setServerAutostart] = useState(true);
  // Mac side: progress while transcoding files a synced device can't play natively.
  const [prepareProgress, setPrepareProgress] = useState<{ done: number; total: number } | null>(null);
  // Mac side: sync transcode target. AAC/256k matches the old
  // hardcoded default so existing setups don't change behavior.
  const [transcodeFormat, setTranscodeFormat] = useState<TranscodeFormat>("aac");
  const [transcodeBitrate, setTranscodeBitrateState] = useState(256000);

  // Bumped at podcast-progress "settle" points (pause / ended / manual mark) to
  // force a snapshot rebuild. handleTimeUpdate's 5s resume-position write does
  // NOT bump this — it deliberately skips refreshPlaylists() to avoid rebuilding
  // (and re-transcode-checking) the whole snapshot every 5s. Without this, a
  // podcast paused mid-episode on the Mac would never reach the Rust snapshot,
  // since favorite is the only stat whose setter already triggers a refresh.
  const [snapshotNonce, setSnapshotNonce] = useState(0);
  const inboxRetries = useRef(new Map<string, number>());
  const bumpSnapshot = () => setSnapshotNonce(n => n + 1);

  // Coalesces snapshot pushes: while one is in flight, a change sets `dirty` and
  // exactly one more rebuild runs when it finishes.
  const snapshotState = useRef<{ inFlight: boolean; dirty: boolean }>({ inFlight: false, dirty: false });

  const openSyncModal = () => setIsSyncModalOpen(true);
  const closeSyncModal = () => setIsSyncModalOpen(false);

  // Reuses the last bound port (server.rs falls back to an ephemeral one if it's
  // taken) so a paired phone's saved URL keeps working across Mac restarts.
  async function startServer() {
    const preferredPort = await getSyncServerPort().catch(() => null);
    const status = await invoke<ServerStatus>("start_sync_server", {
      token: await getSyncToken(),
      preferredPort: preferredPort ?? undefined,
    });
    setServerStatus(status);
    setSyncServerPort(status.port).catch(e =>
      console.error("Failed to persist sync_server_port:", e));
    return status;
  }

  const toggleServer = async () => {
    try {
      if (serverStatus?.running) {
        await invoke("stop_sync_server");
        setServerStatus(null);
        setServerActivity(null);
      } else {
        await startServer();
      }
    } catch (e: any) {
      console.error("Server error:", e);
      setError(i18n.t("syncServer.serverError", { error: String(e) }));
    }
  };

  const toggleServerAutostart = (next: boolean) => {
    setServerAutostart(next);
    setSetting("sync_server_autostart", next ? "1" : "0").catch(e =>
      console.error("Failed to persist sync_server_autostart:", e));
  };

  const changeTranscodeFormat = (next: TranscodeFormat) => {
    setTranscodeFormat(next);
    // The snapshot is built from the persisted option (getTranscodeOptions), so rebuild
    // only once the write has landed.
    dbSetTranscodeFormat(next)
      .then(() => bumpSnapshot())
      .catch(e => console.error("Failed to persist transcode_format:", e));
  };

  const changeTranscodeBitrate = (next: number) => {
    setTranscodeBitrateState(next);
    setTranscodeBitrate(next)
      .then(() => bumpSnapshot())
      .catch(e => console.error("Failed to persist transcode_bitrate:", e));
  };

  // Just the settings half of initSyncFromDb below (transcode target +
  // autostart flag), with no server start — for a backup import (see
  // useBackup.ts) to re-apply settings.transcode_format/transcode_bitrate/
  // sync_server_autostart onto React state without touching the already-
  // running (or deliberately not running) sync server.
  async function reloadSyncSettings() {
    const opts = await getTranscodeOptions().catch(() => null);
    if (opts) {
      setTranscodeFormat(opts.format);
      setTranscodeBitrateState(opts.bitrate);
    }
    const autostart = await getSetting("sync_server_autostart").catch(() => null);
    setServerAutostart(autostart !== "0");
  }

  // Called from App's mount-time initialize() at the same point this logic
  // used to run inline, so startup ordering (which of these await, which
  // don't) is unchanged.
  async function initSyncFromDb() {
    getTranscodeOptions().then(opts => {
      setTranscodeFormat(opts.format);
      setTranscodeBitrateState(opts.bitrate);
    }).catch(() => {});
    const autostart = await getSetting("sync_server_autostart").catch(() => null);
    const autostartOn = autostart !== "0";
    setServerAutostart(autostartOn);
    // The Rust sync server outlives a webview reload; restore our view of it
    // so the snapshot-push effect keeps working after HMR. If nothing is
    // running yet, start it ourselves so a paired device never has to wait
    // for someone to open the Sync modal.
    const liveStatus = await invoke<ServerStatus | null>("sync_server_status").catch(() => null);
    if (liveStatus) {
      setServerStatus(liveStatus);
    } else if (autostartOn) {
      startServer().catch(e => console.error("Sync server autostart failed:", e));
    }
  }

  // Surface the Mac-side transcode progress emitted by prepare_sync_media.
  useTauriEvent<{ done: number; total: number }>("sync-prepare", ({ done, total }) => {
    setPrepareProgress(total > 0 && done < total ? { done, total } : null);
  });

  // A phone that found this Mac over mDNS asked to pair. Approve/deny here so the
  // pairing code never has to be typed on either device.
  useTauriEvent<{ id: number; deviceName: string; fingerprint: string }>(
    "sync-pair-request",
    async ({ id, deviceName, fingerprint }) => {
      let approve = false;
      try {
        approve = await ask(
          i18n.t("syncServer.pairRequestMessage", { deviceName, fingerprint }),
          {
            title: i18n.t("syncServer.pairRequestTitle"),
            kind: "warning",
          },
        );
      } finally {
        await invoke("respond_pairing", { id, approve }).catch(() => { /* request already gone */ });
      }
    },
  );

  // Keep the running server's snapshot in step with the local library. Debounced so
  // a burst of library changes (rescan, starring a batch) rebuilds the snapshot once,
  // and coalesced so a change during a slow rebuild (transcoding) queues just one more.
  useEffect(() => {
    if (!serverStatus?.running) return;

    const push = async () => {
      if (snapshotState.current.inFlight) {
        snapshotState.current.dirty = true;
        return;
      }
      snapshotState.current.inFlight = true;
      try {
        do {
          snapshotState.current.dirty = false;
          await invoke("set_sync_snapshot", { snapshot: await buildSyncSnapshot() });
        } while (snapshotState.current.dirty);
      } catch (e) {
        console.error("Failed to push sync snapshot:", e);
      } finally {
        snapshotState.current.inFlight = false;
      }
    };

    const timer = setTimeout(push, 1500);
    return () => clearTimeout(timer);
  }, [playlists, serverStatus?.running, snapshotNonce]);

  // Poll the Rust sync server every 3s: re-sync React's view of it (the Rust
  // server outlives a webview/HMR reload), drain play/favorite updates pushed by
  // paired devices, and refresh activity. Runs unconditionally — gating on the
  // React `serverStatus` let a stale value after a reload wedge the round-trip
  // (inbox filled but never drained).
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const live = await invoke<ServerStatus | null>("sync_server_status");
        setServerStatus(prev => nextServerStatus(prev, live));
        if (!live?.running) return;

        const items = await invoke<IncomingStats[]>("take_sync_inbox");
        if (items.length > 0) {
          // take_sync_inbox is destructive, so anything that fails to apply is
          // handed back (bounded retries) instead of being silently lost.
          let failed: IncomingStats[];
          try {
            const res = await applySyncInbox(items);
            failed = res.failed;
            console.log(
              `[sync] inbox: ${items.length} push(es), play_states ${res.play_states_applied}/${res.play_states_received} applied`
            );
          } catch (e) {
            console.error("Failed to apply sync inbox:", e);
            failed = items;
          }
          const retry = failed.filter(it => {
            const key = JSON.stringify(it);
            const n = (inboxRetries.current.get(key) ?? 0) + 1;
            inboxRetries.current.set(key, n);
            return n <= MAX_INBOX_RETRIES;
          });
          if (retry.length > 0) await invoke("requeue_sync_inbox", { items: retry });
          if (failed.length === 0) inboxRetries.current.clear();
          await refreshPlaylistsRef.current();
        }
        setServerActivity(await invoke<ServerActivity>("sync_server_activity"));
      } catch (e) {
        console.error("Failed to poll sync server:", e);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return {
    isSyncModalOpen,
    serverStatus,
    serverActivity,
    serverAutostart,
    prepareProgress,
    transcodeFormat,
    transcodeBitrate,
    openSyncModal,
    closeSyncModal,
    toggleServer,
    toggleServerAutostart,
    changeTranscodeFormat,
    changeTranscodeBitrate,
    bumpSnapshot,
    initSyncFromDb,
    reloadSyncSettings,
  };
}
