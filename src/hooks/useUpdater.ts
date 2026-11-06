import { useCallback, useEffect, useRef, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";

/** Wait this long after launch before the automatic check, so it never competes with startup. */
const STARTUP_CHECK_DELAY_MS = 5000;
/** The app can stay open for days, so it re-checks on this interval after the launch check. */
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; version: string; done: number; total: number | null }
  | { kind: "error"; message: string };

/** What the update dialog and Settings → About render and drive. */
export interface SelfUpdate {
  status: UpdaterStatus;
  /** The "available" dialog is shown until dismissed; a manual check re-opens it. */
  dialogOpen: boolean;
  /** The sidebar notice was closed with × (this session only; a newer version brings it back). */
  noticeDismissed: boolean;
  openDialog: () => void;
  dismissNotice: () => void;
  checkNow: () => void;
  install: () => void;
  dismiss: () => void;
}

/**
 * Self-update for the desktop app (tauri-plugin-updater): checks the signed
 * `latest.json` on GitHub Releases, and downloads + installs + relaunches only
 * when the user asks. The automatic check runs shortly after launch and then
 * every 6 hours, only when `autoCheck` is on (read through a ref so the
 * persisted setting has loaded by the time the timer fires). It only raises a
 * sidebar notice; the dialog opens on a click or a manual check. Dev builds
 * never auto-check — there is no signed bundle to compare against.
 */
export function useUpdater(autoCheck: boolean): SelfUpdate {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const notifiedVersion = useRef<string | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const pending = useRef<Update | null>(null);
  const autoCheckRef = useRef(autoCheck);
  autoCheckRef.current = autoCheck;

  const runCheck = useCallback(async (manual: boolean) => {
    if (manual) setStatus({ kind: "checking" });
    try {
      const update = await check();
      if (!update) {
        if (manual) setStatus({ kind: "upToDate" });
        return;
      }
      pending.current = update;
      setStatus({ kind: "available", version: update.version, notes: update.body ?? "" });
      if (notifiedVersion.current !== update.version) {
        notifiedVersion.current = update.version;
        setNoticeDismissed(false);
      }
      // A background check only raises the sidebar notice; it never interrupts.
      if (manual) setDialogOpen(true);
    } catch (e) {
      // A failed background check (offline, rate-limited) is not worth interrupting for.
      if (manual) setStatus({ kind: "error", message: String(e) });
    }
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    const tick = () => {
      // Never swap `pending` out from under an update the user is looking at or installing.
      const kind = statusRef.current.kind;
      if (autoCheckRef.current && kind !== "available" && kind !== "downloading") void runCheck(false);
    };
    const timer = setTimeout(tick, STARTUP_CHECK_DELAY_MS);
    const interval = setInterval(tick, PERIODIC_CHECK_INTERVAL_MS);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, [runCheck]);

  const install = useCallback(async () => {
    const update = pending.current;
    if (!update) return;
    let done = 0;
    let total: number | null = null;
    setStatus({ kind: "downloading", version: update.version, done, total });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? null;
        else if (event.event === "Progress") done += event.data.chunkLength;
        setStatus({ kind: "downloading", version: update.version, done, total });
      });
      // The plugin's relaunch() leaves the new window behind other apps on macOS;
      // relaunch_app goes through `open` so it comes to the front. It returns false
      // when that isn't possible (e.g. not running from an .app bundle).
      if (!(await invoke<boolean>("relaunch_app"))) await relaunch();
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, []);

  return {
    status,
    dialogOpen,
    checkNow: () => { setDialogOpen(false); void runCheck(true); },
    install: () => { void install(); },
    dismiss: () => setDialogOpen(false),
    noticeDismissed,
    openDialog: () => setDialogOpen(true),
    dismissNotice: () => setNoticeDismissed(true),
  };
}
