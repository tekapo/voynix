import { useCallback, useEffect, useRef, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** Wait this long after launch before the automatic check, so it never competes with startup. */
const STARTUP_CHECK_DELAY_MS = 5000;

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
  checkNow: () => void;
  install: () => void;
  dismiss: () => void;
}

/**
 * Self-update for the desktop app (tauri-plugin-updater): checks the signed
 * `latest.json` on GitHub Releases, and downloads + installs + relaunches only
 * when the user asks. The automatic check runs once, shortly after launch, and
 * only when `autoCheck` is on (read through a ref so the persisted setting has
 * loaded by the time the timer fires). Dev builds never auto-check — there is
 * no signed bundle to compare against.
 */
export function useUpdater(autoCheck: boolean): SelfUpdate {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });
  const [dialogOpen, setDialogOpen] = useState(false);
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
      setDialogOpen(true);
    } catch (e) {
      // A failed background check (offline, rate-limited) is not worth interrupting for.
      if (manual) setStatus({ kind: "error", message: String(e) });
    }
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    const timer = setTimeout(() => {
      if (autoCheckRef.current) void runCheck(false);
    }, STARTUP_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
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
      await relaunch();
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
  };
}
