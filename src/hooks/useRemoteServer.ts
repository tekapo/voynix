import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import i18n from "../i18n";
import { playlistSlotType } from "../echoSlot";
import {
  buildRemoteLibrary,
  DEFAULT_REMOTE_PORT,
  getRemoteSecret,
  getRemoteSettings,
  regenerateRemoteSecret,
  setRemoteCertPaths,
  setRemoteEnabled,
  setRemotePort,
} from "../db";
import { Playlist, RemoteStatus } from "../types";

interface UseRemoteServerParams {
  playlists: Playlist[];
  setError: (message: string | null) => void;
}

/** What the Settings → Echo tab renders and drives. */
export interface RemoteAccess {
  enabled: boolean;
  status: RemoteStatus | null;
  port: number;
  certPath: string;
  keyPath: string;
  /** Revealed only on request; never kept in React state otherwise. */
  revealSecret: () => Promise<string>;
  setEnabled: (next: boolean) => void;
  changePort: (next: number) => void;
  changeCertPaths: (certPath: string, keyPath: string) => void;
  regenerateSecret: () => Promise<void>;
  /** The skill model's `types` entry for the current playlist names, as JSON text. */
  playlistSlotJson: () => string;
}

/**
 * The Echo (Alexa) playback server (remote.rs): off by default, started only when
 * the user turns it on in Settings. Mirrors useSyncServer's shape — push the
 * library to Rust after changes, debounced and coalesced — minus pairing and
 * the inbox poll.
 */
export function useRemoteServer({ playlists, setError }: UseRemoteServerParams) {
  const [enabled, setEnabledState] = useState(false);
  const [port, setPort] = useState(DEFAULT_REMOTE_PORT);
  const [certPath, setCertPath] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const pushState = useRef<{ inFlight: boolean; dirty: boolean }>({ inFlight: false, dirty: false });

  async function start(nextPort: number, nextCert: string, nextKey: string) {
    if (!nextCert.trim() || !nextKey.trim()) throw new Error(i18n.t("remote.needCert"));
    const live = await invoke<RemoteStatus>("start_remote_server", {
      port: nextPort,
      secret: await getRemoteSecret(),
      certPath: nextCert.trim(),
      keyPath: nextKey.trim(),
    });
    setStatus(live);
    return live;
  }

  async function stop() {
    await invoke("stop_remote_server");
    setStatus(null);
  }

  const reportError = (e: unknown) => {
    console.error("Echo server error:", e);
    setError(i18n.t("remote.serverError", { error: e instanceof Error ? e.message : String(e) }));
  };

  // Called from App's mount-time initialize(). Unlike the sync server this
  // never starts on its own: only when the user enabled it earlier.
  async function initRemoteFromDb() {
    const s = await getRemoteSettings().catch(() => null);
    if (!s) return;
    setEnabledState(s.enabled);
    setPort(s.port);
    setCertPath(s.certPath);
    setKeyPath(s.keyPath);
    // The Rust server outlives a webview reload (HMR) — restore our view of it.
    const live = await invoke<RemoteStatus | null>("remote_server_status").catch(() => null);
    if (live) setStatus(live);
    else if (s.enabled) start(s.port, s.certPath, s.keyPath).catch(reportError);
  }

  const setEnabled = (next: boolean) => {
    setEnabledState(next);
    setRemoteEnabled(next)
      .then(async () => {
        if (next) await start(port, certPath, keyPath);
        else await stop();
      })
      .catch(e => {
        // E.g. no certificate yet, or the port is taken: keep the switch honest
        // rather than "on" with nothing listening.
        setEnabledState(false);
        setRemoteEnabled(false).catch(() => {});
        reportError(e);
      });
  };

  const restartIfRunning = async (nextPort: number, nextCert: string, nextKey: string) => {
    if (!status?.running) return;
    await stop();
    await start(nextPort, nextCert, nextKey);
  };

  const changePort = (next: number) => {
    if (!Number.isInteger(next) || next < 1 || next > 65535) return;
    setPort(next);
    setRemotePort(next).then(() => restartIfRunning(next, certPath, keyPath)).catch(reportError);
  };

  const changeCertPaths = (nextCert: string, nextKey: string) => {
    setCertPath(nextCert.trim());
    setKeyPath(nextKey.trim());
    setRemoteCertPaths(nextCert, nextKey).then(() => restartIfRunning(port, nextCert, nextKey)).catch(reportError);
  };

  const regenerateSecret = async () => {
    try {
      const secret = await regenerateRemoteSecret();
      if (status?.running) await invoke("set_remote_secret", { secret });
    } catch (e) {
      reportError(e);
    }
  };

  // Keep the running server's library in step with the app. Debounced longer
  // than the sync snapshot's because this one carries the whole track list, and
  // coalesced so a change during a slow rebuild queues just one more.
  useEffect(() => {
    if (!status?.running) return;

    const push = async () => {
      if (pushState.current.inFlight) {
        pushState.current.dirty = true;
        return;
      }
      pushState.current.inFlight = true;
      try {
        do {
          pushState.current.dirty = false;
          await invoke("set_remote_library", { library: await buildRemoteLibrary() });
        } while (pushState.current.dirty);
      } catch (e) {
        console.error("Failed to push remote library:", e);
      } finally {
        pushState.current.inFlight = false;
      }
    };

    const timer = setTimeout(push, 3000);
    return () => clearTimeout(timer);
  }, [playlists, status?.running]);

  const remote: RemoteAccess = {
    enabled,
    status,
    port,
    certPath,
    keyPath,
    revealSecret: getRemoteSecret,
    setEnabled,
    changePort,
    changeCertPaths,
    regenerateSecret,
    playlistSlotJson: () => JSON.stringify(playlistSlotType(playlists.map(p => p.name)), null, 2),
  };

  return { remote, initRemoteFromDb };
}
