// The preload API is the renderer's only access to Electron and the filesystem.
// Keep its command and event types shared with the main process and preload.

import type { Eol, RecentEntry, Settings } from "../state/types";
import type {
  DefaultHandler,
  FileMeta,
  FilePayload,
  FileStat,
  ImageBytes,
  NativePrintOptions,
  PrintCompleted,
  PrinterInfo,
  SearchHit,
  SearchOpts,
  SearchSummary,
  Session,
  Snapshot,
  SpellcheckInfo,
  SpellingMenuContext,
  SpellingMenuAction,
  UpdateInfo,
} from "./contracts";

export interface DesktopCommandArgs {
  read_file: { path: string };
  write_file: { path: string; content: string; eol: Eol };
  path_exists: { path: string };
  watch_file: { path: string };
  unwatch_file: undefined;
  ensure_attachments_dir: { docPath: string; folderName: string };
  write_attachment: { docPath: string; folderName: string; fileName: string; bytes: Uint8Array };
  read_image_bytes: { path: string };
  get_recent_files: { limit: number | null };
  record_file_opened: { path: string; openedAtMs: number };
  remove_recent: { path: string };
  set_favorite: { path: string; favorite: boolean };
  stat_files: { paths: string[] };
  search_recent_contents: { searchId: string; query: string; opts: SearchOpts };
  cancel_search: { searchId: string };
  write_snapshot: { snapshot: Snapshot };
  delete_snapshot: { sessionId: string };
  list_recovery_snapshots: undefined;
  load_session: undefined;
  save_session: { session: Session };
  get_launch_args: undefined;
  get_default_md_handler: undefined;
  open_default_apps_settings: undefined;
  get_system_accent_color: undefined;
  load_settings: undefined;
  save_settings: { settings: Settings };
  settings_path: undefined;
  get_spellcheck_info: undefined;
  list_dictionary_words: undefined;
  add_dictionary_word: { word: string };
  remove_dictionary_word: { word: string };
  spelling_menu_action: SpellingMenuAction;
  list_printers: undefined;
  print_webview: { options: NativePrintOptions };
  print_webview_to_pdf: { path: string; options: NativePrintOptions };
  update_info: undefined;
  check_for_updates: undefined;
  restart_to_update: undefined;
}

export interface DesktopCommandResults {
  read_file: FilePayload;
  write_file: FileMeta;
  path_exists: boolean;
  watch_file: void;
  unwatch_file: void;
  ensure_attachments_dir: string;
  write_attachment: string;
  read_image_bytes: ImageBytes;
  get_recent_files: RecentEntry[];
  record_file_opened: RecentEntry;
  remove_recent: void;
  set_favorite: RecentEntry;
  stat_files: FileStat[];
  search_recent_contents: SearchSummary;
  cancel_search: void;
  write_snapshot: void;
  delete_snapshot: void;
  list_recovery_snapshots: Snapshot[];
  load_session: Session;
  save_session: void;
  get_launch_args: string | null;
  get_default_md_handler: DefaultHandler;
  open_default_apps_settings: void;
  get_system_accent_color: string | null;
  load_settings: Settings;
  save_settings: void;
  settings_path: string;
  get_spellcheck_info: SpellcheckInfo;
  list_dictionary_words: string[];
  add_dictionary_word: void;
  remove_dictionary_word: void;
  spelling_menu_action: void;
  list_printers: PrinterInfo[];
  print_webview: void;
  print_webview_to_pdf: void;
  update_info: UpdateInfo;
  check_for_updates: void;
  restart_to_update: void;
}

/** Undo or Redo, chosen in a native menu. */
export type HistoryCommand = "undo" | "redo";

export interface DesktopEventPayloads {
  "spelling-context-menu": SpellingMenuContext;
  "settings-changed": Settings;
  "file-changed": { path: string; modifiedMs: number };
  "open-file-requested": { path: string };
  "print-completed": PrintCompleted;
  "search-result": { searchId: string; hit: SearchHit };
  "close-requested": void;
  "history-requested": HistoryCommand;
  "update-changed": UpdateInfo;
}

export interface FileDialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
  filters?: FileDialogFilter[];
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileDialogFilter[];
}

export interface AskDialogOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
  cancelLabel?: string;
}

/** The action chosen for a document with unsaved changes. */
export type SaveChangesChoice = "save" | "discard" | "cancel";

export interface ElectronBridge {
  readonly platform: string;
  invoke<K extends keyof DesktopCommandArgs>(
    command: K,
    args?: DesktopCommandArgs[K],
  ): Promise<DesktopCommandResults[K]>;
  listen<K extends keyof DesktopEventPayloads>(
    event: K,
    handler: (payload: DesktopEventPayloads[K]) => void,
  ): () => void;
  openDialog(options: OpenDialogOptions): Promise<string | string[] | null>;
  saveDialog(options: SaveDialogOptions): Promise<string | null>;
  ask(message: string, options?: AskDialogOptions): Promise<boolean>;
  confirmSaveChanges(message: string): Promise<SaveChangesChoice>;
  openExternal(url: string): Promise<void>;
  revealItemInFolder(path: string): Promise<void>;
  setTheme(theme: "light" | "dark" | "system"): Promise<void>;
  getPathForFile(file: File): string;
  convertFileSrc(path: string): Promise<string | null>;
  closeWindow(): Promise<void>;
  cancelWindowClose(): Promise<void>;
}

declare global {
  interface Window {
    downpadDesktop?: ElectronBridge;
  }
}

/** Resolve the installed app's preload API or explain why it is unavailable. */
export function desktopBridge(): ElectronBridge {
  const bridge = typeof window === "undefined" ? undefined : window.downpadDesktop;
  if (!bridge) throw new Error("This action needs the installed Downpad app.");
  return bridge;
}

export function invoke<K extends keyof DesktopCommandArgs>(
  command: K,
  args?: DesktopCommandArgs[K],
): Promise<DesktopCommandResults[K]> {
  try {
    return desktopBridge().invoke(command, args);
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Return a URL for a local image without exposing filesystem APIs to the page,
 *  or null when the image file does not exist. */
export function convertFileSrc(path: string): Promise<string | null> {
  return desktopBridge().convertFileSrc(path);
}
