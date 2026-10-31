// Default settings, mirroring spec §5.9. These are the values used until the
// backend's load_settings returns the real settings.toml contents.

import type { Settings } from "../state/types";

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  editorTheme: "light",
  accentMode: "default",
  accentColor: "#0969da",
  editorWidthMode: "fixed",
  editorWidthPx: 1188,
  fontFamily: "Segoe UI",
  editorFontScale: 1.0,

  attachmentsFolderName: "attachments",
  embedImagesAsBase64: true,
  maxEmbedSizeKB: 10240, // 10 MiB

  linkDisplay: "text-and-url",

  recentFilesMaxRetained: 500,
  recentFilesVisibleCount: 100,
  recentFilesDefaultSearch: "names",
  recentFilesKeepRemoved: false,

  defaultView: "document",
  collapseBase64InRawView: true,
  spellCheckEnabled: true,
  spellCheckLanguages: [],
  showFrontmatterPanel: true,
  maxRetainedTabEditors: 5,

  mdBulletChar: "-",
  mdEmphasisChar: "*",
  mdStrongChar: "**",
  mdHeadingStyle: "atx",
  mdHardWrap: false,

  autosaveEnabled: false,
  autosaveIntervalSeconds: 30,
  recoverySnapshotIntervalSeconds: 10,
  recoveryRetentionDays: 7,

  printVersion: "document",
  printPaperSize: "a4",
  printOrientation: "portrait",
  printMargins: "normal",
  printScalePercent: 100,
  printHeaderTitle: false,
  printHeaderDate: false,
  printFooterPageNumbers: true,
  printerName: "",
  printCopies: 1,

  hasSeenWelcome: false,
  hasCheckedDefaultHandler: false,

  autoUpdate: true,
};
