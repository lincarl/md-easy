import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { parse, type TomlTable } from "smol-toml";
import { parseForESLint, type AST } from "toml-eslint-parser";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import type { Settings } from "../src/state/types";
import { writeAtomic } from "./io";

const ENUMS: Partial<Record<keyof Settings, readonly unknown[]>> = {
  theme: ["system", "light", "dark"], editorTheme: ["follow-ui", "light", "dark"],
  accentMode: ["default", "system", "custom"], editorWidthMode: ["fill", "fixed"],
  linkDisplay: ["text-and-url", "text-only"], defaultView: ["document", "split", "markdown"],
  mdBulletChar: ["-", "*", "+"], mdEmphasisChar: ["*", "_"], mdStrongChar: ["**", "__"],
  mdHeadingStyle: ["atx", "setext"], printVersion: ["document", "markdown"],
  printPaperSize: ["a4", "letter", "legal", "a5"], printOrientation: ["portrait", "landscape"],
  printMargins: ["normal", "narrow", "wide", "none"],
  recentFilesDefaultSearch: ["names", "contents", "all"],
};

// Longer intervals overflow browser timers and run almost immediately.
const MAX_INTERVAL_SECONDS = Math.floor(0x7fffffff / 1000);

/** Ignore malformed keys while retaining complete defaults for older settings files. */
export function normalizeSettings(input: unknown): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  if (!input || typeof input !== "object" || Array.isArray(input)) return settings;
  const source = input as Record<string, unknown>;
  const target = settings as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = source[key];
    if (key === "defaultView" && (value === "wysiwyg" || value === "raw")) {
      settings.defaultView = value === "raw" ? "split" : "document";
    } else if (key === "mdHardWrap") {
      if (value === false || (typeof value === "number" && Number.isInteger(value) && value > 0)) target[key] = value;
    } else if (key === "spellCheckLanguages") {
      if (Array.isArray(value) && value.every((language: unknown) =>
        typeof language === "string" && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language))) {
        settings.spellCheckLanguages = [...new Set(value)];
      }
    } else if (typeof value === typeof DEFAULT_SETTINGS[key] &&
      (typeof value !== "number" || (Number.isFinite(value) && value >= 0)) &&
      (!ENUMS[key] || ENUMS[key]?.includes(value))) {
      target[key] = value;
    }
  }
  settings.recentFilesMaxRetained = Math.max(10, Math.min(100_000, Math.floor(settings.recentFilesMaxRetained)));
  settings.recentFilesVisibleCount = Math.max(1, Math.min(100_000, Math.floor(settings.recentFilesVisibleCount), settings.recentFilesMaxRetained));
  settings.maxRetainedTabEditors = Math.max(1, Math.min(20, Math.floor(settings.maxRetainedTabEditors)));
  settings.printScalePercent = Math.max(50, Math.min(200, Math.round(settings.printScalePercent)));
  settings.printCopies = Math.max(1, Math.min(999, Math.floor(settings.printCopies)));
  settings.recoveryRetentionDays = Math.max(1, Math.floor(settings.recoveryRetentionDays));
  settings.recoverySnapshotIntervalSeconds = Math.max(2, Math.min(MAX_INTERVAL_SECONDS, Math.floor(settings.recoverySnapshotIntervalSeconds)));
  settings.autosaveIntervalSeconds = Math.max(5, Math.min(MAX_INTERVAL_SECONDS, Math.floor(settings.autosaveIntervalSeconds)));
  return settings;
}

/** Patch valid settings while preserving malformed files for the user to repair. */
export function patchSettingsToml(existing: string, settings: Settings): string {
  let original: TomlTable;
  try {
    original = parse(existing);
  } catch (error) {
    throw new Error("Cannot save settings because settings.toml contains invalid TOML. Fix the file's syntax before saving settings.", { cause: error });
  }

  try {
    // The syntax parser rejects a leading BOM, but settings loading accepts it.
    const bom = existing.startsWith("\uFEFF") ? "\uFEFF" : "";
    let text = existing.slice(bom.length);
    const root = parseForESLint(text, { tomlVersion: "1.1" }).ast.body[0];
    const missing = new Map<string, string>((Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).map((key) => {
      const value = settings[key];
      return [key, Object.is(value, -0) ? "-0.0" : JSON.stringify(value).replace(/\u007f/g, "\\u007f")];
    }));
    const replacements: { range: AST.Range; text: string }[] = [];
    for (const node of root.body) {
      if (node.type !== "TOMLKeyValue" || node.key.keys.length !== 1) continue;
      const keyNode = node.key.keys[0]!;
      const key = keyNode.type === "TOMLBare" ? keyNode.name : keyNode.value;
      const scalar = missing.get(key);
      if (scalar === undefined) continue;
      replacements.push({ range: node.value.range, text: scalar });
      missing.delete(key);
    }

    // Insert root defaults before a real table, retaining the table's indentation.
    const table = root.body.find((node) => node.type === "TOMLTable");
    const insertion = table ? text.lastIndexOf("\n", table.range[0] - 1) + 1 : text.length;
    if (missing.size > 0) {
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const separator = insertion === 0 || text[insertion - 1] === "\n" ? "" : eol;
      const additions = [...missing].map(([key, scalar]) => `${key} = ${scalar}${eol}`).join("");
      replacements.push({ range: [insertion, insertion], text: separator + additions });
    }
    // Apply original source ranges from right to left so earlier offsets stay valid.
    replacements.sort((left, right) => right.range[0] - left.range[0]);
    for (const replacement of replacements) {
      text = text.slice(0, replacement.range[0]) + replacement.text + text.slice(replacement.range[1]);
    }
    const output = bom + text;
    if (!isDeepStrictEqual({ ...parse(output) }, { ...original, ...settings })) {
      throw new Error("The settings update changed unrelated TOML values or did not update root settings.");
    }
    return output;
  } catch (error) {
    throw new Error("Cannot save settings because this TOML structure cannot be updated safely. The original file was preserved.", { cause: error });
  }
}

/** Reject invalid UTF-8 without replacing bytes, and retain a leading BOM. */
async function readSettingsText(path: string): Promise<string> {
  const bytes = await readFile(path);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error("Cannot save settings because settings.toml contains invalid UTF-8. Convert the file to UTF-8 before saving settings.", { cause: error });
  }
}

export async function loadSettingsFile(path: string): Promise<Settings> {
  let text: string;
  try {
    text = await readSettingsText(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await writeAtomic(path, patchSettingsToml("", DEFAULT_SETTINGS));
    }
    return { ...DEFAULT_SETTINGS };
  }
  try { return normalizeSettings(parse(text)); } catch { return { ...DEFAULT_SETTINGS }; }
}

export async function saveSettingsFile(path: string, input: unknown): Promise<void> {
  const existing = await readSettingsText(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  await writeAtomic(path, patchSettingsToml(existing, normalizeSettings(input)));
}
