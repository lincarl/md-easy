// Typed wrappers over the isolated Electron preload API. See docs/design.md §3.

import { desktopBridge, invoke } from "./bridge";
import type { Eol, RecentEntry, Settings } from "../state/types";
import type {
  DefaultHandler,
  FileStat,
  FileMeta,
  FilePayload,
  ImageBytes,
  NativePrintOptions,
  PrinterInfo,
  SearchHit,
  SearchOpts,
  SearchSummary,
  Session,
  Snapshot,
  SpellcheckInfo,
  UpdateInfo,
} from "./contracts";

/**
 * Read a file. `content` is returned in the canonical in-memory form — UTF-8,
 * BOM stripped, line endings normalized to LF — i.e. directly comparable to a
 * `DocumentState.markdown` string (relied on by AppRuntime's file-changed check).
 */
export function readFile(path: string): Promise<FilePayload> {
  return invoke("read_file", { path });
}

export function writeFile(path: string, content: string, eol: Eol): Promise<FileMeta> {
  return invoke("write_file", { path, content, eol });
}

export function pathExists(path: string): Promise<boolean> {
  return invoke("path_exists", { path });
}

/** Watch the open file for external changes (emits `file-changed`, §5.1). */
export function watchFile(path: string): Promise<void> {
  return invoke("watch_file", { path });
}

export function unwatchFile(): Promise<void> {
  return invoke("unwatch_file");
}

/** Create (if needed) and return the attachments dir next to `docPath` (§5.7). */
export function ensureAttachmentsDir(docPath: string, folderName: string): Promise<string> {
  return invoke("ensure_attachments_dir", { docPath, folderName });
}

/**
 * Write attachment bytes next to the document and return the relative,
 * forward-slash link path (e.g. `attachments/img-….png`). See §5.5/§5.7.
 */
export function writeAttachment(
  docPath: string,
  folderName: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<string> {
  // The preload bridge and IPC copy a Uint8Array as binary. A number array
  // took seconds for a file of a few megabytes.
  return invoke("write_attachment", { docPath, folderName, fileName, bytes });
}

/** Read image bytes + MIME for a path (relocate / copy-image, §5.5). */
export function readImageBytes(path: string): Promise<ImageBytes> {
  return invoke("read_image_bytes", { path });
}

// ── Recent files (§5.8) ──

export function getRecentFiles(limit?: number): Promise<RecentEntry[]> {
  return invoke("get_recent_files", { limit: limit ?? null });
}

/** Upsert on open; `openedAtMs` is epoch milliseconds from the caller (Date.now()). */
export function recordFileOpened(path: string, openedAtMs: number): Promise<RecentEntry> {
  return invoke("record_file_opened", { path, openedAtMs });
}

export function removeRecent(path: string): Promise<void> {
  return invoke("remove_recent", { path });
}

/** Set/clear the favorite flag on an existing recent entry (§5.8 star). */
export function setFavorite(path: string, favorite: boolean): Promise<RecentEntry> {
  return invoke("set_favorite", { path, favorite });
}

/** Live existence + size for the visible rows (§5.8 row layout). */
export function statFiles(paths: string[]): Promise<FileStat[]> {
  return invoke("stat_files", { paths });
}

// Content search streams matching files and progress through desktop events.

export async function searchRecentContents(
  searchId: string,
  query: string,
  opts: SearchOpts,
  onResult: (hit: SearchHit) => void,
): Promise<SearchSummary> {
  let received = 0;
  let expected = Number.POSITIVE_INFINITY;
  let allReceived = (): void => {};
  const unlisten = desktopBridge().listen("search-result", (result) => {
    if (result.searchId !== searchId) return;
    onResult(result.hit);
    if (result.hit.kind === "content" && ++received >= expected) allReceived();
  });
  try {
    const summary = await invoke("search_recent_contents", { searchId, query, opts });
    // Electron delivers the command's reply on another channel than the result
    // events, so the reply can overtake the last hits. Keep listening until
    // every hit the main process counted has arrived, for at most a second.
    if (received < summary.matched) {
      expected = summary.matched;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SEARCH_RESULT_GRACE_MS);
        allReceived = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    return summary;
  } finally {
    unlisten();
  }
}

/** How long a finished content search waits for result events still in flight. */
const SEARCH_RESULT_GRACE_MS = 1000;

export function cancelSearch(searchId: string): Promise<void> {
  return invoke("cancel_search", { searchId });
}

// ── Crash recovery (§5.11) ──

export function writeSnapshot(snapshot: Snapshot): Promise<void> {
  return invoke("write_snapshot", { snapshot });
}

export function deleteSnapshot(sessionId: string): Promise<void> {
  return invoke("delete_snapshot", { sessionId });
}

export function listRecoverySnapshots(): Promise<Snapshot[]> {
  return invoke("list_recovery_snapshots");
}

// ── Reopening the open documents ──

/** The documents that were open when Downpad last closed. */
export function loadSession(): Promise<Session> {
  return invoke("load_session");
}

/** Record the open documents for the next start. */
export function saveSession(session: Session): Promise<void> {
  return invoke("save_session", { session });
}

// ── OS integration (§5.12) ──

/** The markdown file Downpad was launched with, if any. */
export function getLaunchArgs(): Promise<string | null> {
  return invoke("get_launch_args");
}

/** Current default .md handler (§5.12). */
export function getDefaultMdHandler(): Promise<DefaultHandler> {
  return invoke("get_default_md_handler");
}

/** Open Windows Default-apps Settings so the user can pick Downpad (§5.12). */
export function openDefaultAppsSettings(): Promise<void> {
  return invoke("open_default_apps_settings");
}

/** The OS accent color as `#rrggbb`, or null if unavailable (§6.2 "Follow system"). */
export function getSystemAccentColor(): Promise<string | null> {
  return invoke("get_system_accent_color");
}

/** Open an http, https or mailto address in the default browser or mail app. */
export function openExternalUrl(url: string): Promise<void> {
  try {
    return desktopBridge().openExternal(url);
  } catch (error) {
    return Promise.reject(error);
  }
}

/** This copy's version and where its update check stands (Settings > Updates). */
export function updateInfo(): Promise<UpdateInfo> {
  return invoke("update_info");
}

/** Start an update check. Progress and its outcome arrive as update-changed
 *  events, also when a check is already running. */
export function checkForUpdates(): Promise<void> {
  return invoke("check_for_updates");
}

/** Quit and start again, which installs the downloaded update. The usual
 *  prompt about unsaved documents can cancel it. */
export function restartToUpdate(): Promise<void> {
  return invoke("restart_to_update");
}

export function loadSettings(): Promise<Settings> {
  return invoke("load_settings");
}

export function saveSettings(settings: Settings): Promise<void> {
  return invoke("save_settings", { settings });
}

export function settingsPath(): Promise<string> {
  return invoke("settings_path");
}

/** Read the native checker's supported and active languages. */
export function getSpellcheckInfo(): Promise<SpellcheckInfo> {
  return invoke("get_spellcheck_info");
}

/** List persistent words added to the native custom dictionary. */
export function listDictionaryWords(): Promise<string[]> {
  return invoke("list_dictionary_words");
}

/** Accept a word in the native custom dictionary immediately. */
export function addDictionaryWord(word: string): Promise<void> {
  return invoke("add_dictionary_word", { word });
}

/** Remove a custom word so the native checker can flag it again. */
export function removeDictionaryWord(word: string): Promise<void> {
  return invoke("remove_dictionary_word", { word });
}

// ── Printing (§5.21) ──────────────────────────────────────────────────────
// Downpad prints through Electron directly instead of `window.print()`, so the
// browser's own print dialog — and the URL/date header it stamps on every sheet —
// never appears. Both commands start the job and return; completion arrives as
// the `print-completed` event (see ipc/events.ts).

/** Installed printers, default first (§5.21). */
export function listPrinters(): Promise<PrinterInfo[]> {
  return invoke("list_printers");
}

/** Print the current page to a printer with Downpad's own page setup. */
export function printWebview(options: NativePrintOptions): Promise<void> {
  return invoke("print_webview", { options });
}

/** Write the current page to a PDF at `path` using the same page setup. */
export function printWebviewToPdf(path: string, options: NativePrintOptions): Promise<void> {
  return invoke("print_webview_to_pdf", { path, options });
}
