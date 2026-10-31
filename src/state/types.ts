// Canonical application state shapes. See docs/design.md §4.
//
// The single source of truth is `DocumentState.markdown`. Both the WYSIWYG
// (Milkdown/Crepe) and raw (CodeMirror) views are *views* over this one string;
// neither is authoritative. Switching views re-mounts the inactive editor
// against the current string (spec §8.3).

import type { MarginPreset, Orientation, PaperSize, PrintVersion } from "../print/paper";

export type ViewMode = "recent" | "wysiwyg" | "raw";

/**
 * Which editor panes are shown (spec §6.1), chosen via the toolbar's three-segment
 * Document | Split | Markdown control:
 * - `"document"` — only the document (WYSIWYG) view.
 * - `"split"` — the document and the raw Markdown source side by side ("Split").
 * - `"markdown"` — only the raw Markdown source.
 * Persists across tab switches.
 */
export type EditorLayout = "document" | "split" | "markdown";

export type Eol = "lf" | "crlf";

/** How WYSIWYG edits are serialized back to markdown (spec §5.16). */
export interface SerializerStyle {
  bullet: "-" | "*" | "+";
  emphasis: "*" | "_";
  strong: "**" | "__";
  headingStyle: "atx" | "setext";
  /** false = no hard wrap; a number = hard-wrap column. */
  hardWrap: false | number;
}

export interface DocumentState {
  /** THE single source of truth. Includes frontmatter, LF-normalized internally. */
  markdown: string;
  /** Absolute path, or null for an untitled buffer. */
  filePath: string | null;
  /** Whether `markdown` differs from `savedMarkdown`. While that text is
   *  unknown, any edit counts as unsaved. */
  isDirty: boolean;
  /** The text last read from or written to the file, or the starting text of a
   *  document with no file ("" for a new one). Null when unknown, as for a
   *  recovered snapshot or while a save is being written. */
  savedMarkdown: string | null;
  /** Detected on open, re-applied on write (spec §5.18). */
  eol: Eol;
  /** Whether the opened file had a BOM (stripped on save). */
  hadBom: boolean;
  /** Last known on-disk mtime (ms); used to suppress self-write watcher events (§5.1). */
  modifiedMs: number;
  /** WYSIWYG-only UI state for the collapsible frontmatter block (spec §5.17). */
  frontmatterCollapsed: boolean;
}

/**
 * One open document in the tab strip (spec §5.19). Each tab carries its own full
 * DocumentState; the active tab's `doc` is mirrored into `AppState.doc` so the
 * single-source-of-truth invariant and every existing `doc` reader keep working.
 */
export interface Tab {
  /** Stable identity (untitled buffers have no path, so paths can't be the id). */
  id: string;
  doc: DocumentState;
  /** Set while Downpad cannot build this tab's Document view, for example
   *  because the parser overflows its stack. The tab then shows its Markdown
   *  alone, whatever the window's layout (`shownLayout`). */
  documentViewFailure?: DocumentViewFailure;
  /** Whether files dropped on the document, or images pasted into it, are
   *  still on their way into it (§5.4, §5.5). The tab keeps this document
   *  until they are in, and counts as unsaved meanwhile
   *  (`hasUnsavedChanges`). */
  filesPending?: boolean;
}

/** Why a tab's Document view could not be built, for the notice that says so. */
export interface DocumentViewFailure {
  /** The error's message. */
  message: string;
  /** Whether the user dismissed the notice for this failure. */
  dismissed: boolean;
}

/** Whether closing a tab would lose changes: unsaved edits to its document,
 *  or files dropped on it or pasted into it that are not in yet (§5.4, §5.5,
 *  §5.19). */
export function hasUnsavedChanges(tab: Tab): boolean {
  return tab.doc.isDirty || tab.filesPending === true;
}

/** A fresh, empty untitled document buffer. */
export function blankDoc(): DocumentState {
  return {
    markdown: "",
    filePath: null,
    isDirty: false,
    savedMarkdown: "",
    eol: "lf",
    hadBom: false,
    modifiedMs: 0,
    frontmatterCollapsed: false,
  };
}

export interface FindState {
  open: boolean;
  query: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** 1-based index of the current match, 0 when none. */
  current: number;
  total: number;
}

export type BannerKind = "file-changed" | "large-file" | "info" | "error";

export interface BannerState {
  kind: BannerKind;
  message: string;
  /** Optional named actions, e.g. [{ id: "reload", label: "Reload" }]. */
  actions?: { id: string; label: string }[];
}

export interface AppState {
  view: ViewMode;
  /** UUID for this app session (recovery snapshots, spec §5.11). */
  sessionId: string;
  /** The ACTIVE document — a mirror of the active tab's `doc` (spec §5.19), or a
   *  blank buffer when no tab is open. Existing code reads this slice directly. */
  doc: DocumentState;
  /** Open documents, left-to-right (spec §5.19). May be empty (→ Recent view). */
  tabs: Tab[];
  /** Id of the active tab, or null when no document is open. */
  activeTabId: string | null;
  /** Which editor panes are shown — the document alone, the document and the
   *  Markdown source side by side, or the Markdown source alone (§6.1). Driven by
   *  the toolbar's Document | Split | Markdown control; persists across tab switches.
   *  A tab whose Document view cannot be built shows its Markdown alone instead
   *  (`shownLayout`), without changing this. */
  editorLayout: EditorLayout;
  settings: Settings;
  find: FindState;
  banner: BannerState | null;
  saveStatus: { lastSavedAt: number | null; autosaving: boolean };
  /** Whether startup (`AppRuntime.bootstrap`) has finished. It has then shown
   *  the first document or the Recent view and put the keyboard shortcuts and
   *  desktop events in place. The app shell shows it as `data-started`, which
   *  the Electron tests wait for before they act. */
  started: boolean;
}

// ── Settings (mirror of settings.toml; see spec §5.9 and ipc/contracts) ──

export interface Settings {
  /** UI (chrome) theme (spec §6.2). */
  theme: "system" | "light" | "dark";
  /** Document/text theme (spec §6.2): follow the UI theme, or pin light/dark so a
   *  dark-UI user can still read documents on a light page (and vice versa). */
  editorTheme: "follow-ui" | "light" | "dark";
  /** Accent (highlight) color source (spec §6.2): "default" = the theme's design accent,
   *  "system" = the Windows accent color, "custom" = `accentColor`. */
  accentMode: "default" | "system" | "custom";
  /** Custom accent color as a #rrggbb hex string; used when accentMode = "custom". */
  accentColor: string;
  /** Page width mode (spec §6.1): "fill" = the editor column fills the window and
   *  adapts on resize; "fixed" = capped at `editorWidthPx`. */
  editorWidthMode: "fill" | "fixed";
  editorWidthPx: number;
  fontFamily: string;
  /** Relative size of the document text in the editor, as a multiplier of the
   *  base size (spec §5.20). 1.0 = 100%. Driven by the toolbar +/- buttons and
   *  the "Document text size" setting; applies to both WYSIWYG and raw views. */
  editorFontScale: number;

  attachmentsFolderName: string;
  embedImagesAsBase64: boolean;
  maxEmbedSizeKB: number;

  linkDisplay: "text-and-url" | "text-only";

  recentFilesMaxRetained: number;
  recentFilesVisibleCount: number;
  recentFilesDefaultSearch: "names" | "contents" | "all";
  /** Show missing paths without removing their retained history. */
  recentFilesKeepRemoved: boolean;

  /** Which editor layout new documents open in (spec §6.1): the document view,
   *  the side-by-side split ("both"), or the Markdown source. Legacy values from
   *  settings files predating the three-way control ("wysiwyg"/"raw") are mapped
   *  by `layoutFromDefaultView`. */
  defaultView: EditorLayout;
  collapseBase64InRawView: boolean;
  spellCheckEnabled: boolean;
  /** Languages checked together. An empty list follows the system languages. */
  spellCheckLanguages: string[];
  /** Whether a leading YAML `---` block is shown above the WYSIWYG editor as a
   *  VS Code-style editable key/value table (spec §5.17). On by default. Either
   *  way the YAML is split off and kept byte-for-byte (never fed through the
   *  Markdown engine); scalar edits in the table patch the YAML line-for-line so
   *  the file's formatting is preserved. With it off, the frontmatter is hidden
   *  here but still preserved and editable in the Markdown (raw) view. */
  showFrontmatterPanel: boolean;
  /** Number of tabs (most-recently-used) whose editors stay live so their undo
   *  history is preserved across tab switches and the WYSIWYG⇄raw toggle (spec
   *  §5.19). Older tabs rebuild from text on revisit (their undo resets). 1–20. */
  maxRetainedTabEditors: number;

  mdBulletChar: "-" | "*" | "+";
  mdEmphasisChar: "*" | "_";
  mdStrongChar: "**" | "__";
  mdHeadingStyle: "atx" | "setext";
  mdHardWrap: false | number;

  autosaveEnabled: boolean;
  autosaveIntervalSeconds: number;
  recoverySnapshotIntervalSeconds: number;
  recoveryRetentionDays: number;

  // ── Printing (spec §5.21). The print workspace opens with these and writes
  // back whatever the user changes, so the next print starts where they left off.

  /** Which rendering goes on paper: the formatted document or the Markdown source. */
  printVersion: PrintVersion;
  printPaperSize: PaperSize;
  printOrientation: Orientation;
  printMargins: MarginPreset;
  /** Document scale on the page as a percentage; 100 = as laid out. 50–200. */
  printScalePercent: number;
  /** Running header: the file name on the left, today's date on the right. */
  printHeaderTitle: boolean;
  printHeaderDate: boolean;
  /** Running footer: "n / total". */
  printFooterPageNumbers: boolean;
  /** Last chosen printer; empty means the system default. */
  printerName: string;
  printCopies: number;

  hasSeenWelcome: boolean;
  /** Whether the one-time first-run "set Downpad as the default .md app?" check
   *  has run (spec §5.12). Once true it never runs again, so normal launches
   *  spend no time checking the registry or prompting. */
  hasCheckedDefaultHandler: boolean;

  /** Check for a new release every 30 days, download it, and install it the
   *  next time Downpad starts. Only copies installed from a release package
   *  update themselves. */
  autoUpdate: boolean;
}

export interface RecentEntry {
  /** Absolute path as last opened; original spelling preserved for display. */
  path: string;
  /** Last opened, epoch milliseconds (UTC); larger means more recent. */
  lastOpenedMs: number;
  /** Favorite (starred) flag. */
  favorite: boolean;
}

/**
 * The editor layout new documents open in, derived from `defaultView` (spec §6.1).
 * Tolerant of legacy settings values written before the three-way Document | Split
 * | Markdown control existed: `"wysiwyg"` → the document view, and `"raw"` → the
 * split (its last-shipped meaning, where a `raw` default opened with the Markdown
 * source already showing). Anything unrecognized falls back to the document view.
 */
export function layoutFromDefaultView(s: Pick<Settings, "defaultView">): EditorLayout {
  switch (s.defaultView as string) {
    case "markdown":
      return "markdown";
    case "split":
    case "raw": // legacy: a "raw" default opened with the Markdown split showing
      return "split";
    case "document":
    case "wysiwyg": // legacy: the document-only view
    default:
      return "document";
  }
}

/** The layout the active tab is shown in: the window's layout, or the Markdown
 *  view alone while the tab's Document view cannot be built. */
export function shownLayout(state: Pick<AppState, "tabs" | "activeTabId" | "editorLayout">): EditorLayout {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  return active?.documentViewFailure ? "markdown" : state.editorLayout;
}

/** Derive the WYSIWYG serializer style from settings (spec §5.16). */
export function serializerStyleFromSettings(s: Settings): SerializerStyle {
  return {
    bullet: s.mdBulletChar,
    emphasis: s.mdEmphasisChar,
    strong: s.mdStrongChar,
    headingStyle: s.mdHeadingStyle,
    hardWrap: s.mdHardWrap,
  };
}
