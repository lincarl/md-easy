// Editing actions behind the custom right-click menu (spec §6.1). They act on
// whatever editable currently holds the selection — the WYSIWYG document
// (ProseMirror), the Markdown source (CodeMirror), or a plain form field — via
// DOM-level operations, so no editor instance has to be threaded through the
// shell.
//
// Cut/Copy/Select all go through `document.execCommand`, which routes into each
// editor's own clipboard serialization (ProseMirror writes markdown-aware HTML,
// CodeMirror writes the raw text) and lands in their undo history.
//
// Paste cannot use execCommand — Chromium refuses `execCommand("paste")` from
// script. Instead the clipboard is read through the async Clipboard API and
// replayed as a synthetic `paste` ClipboardEvent on the editable, so the app's
// own smart-paste pipeline (editor/wysiwyg/pasteHandler, spec §5.4) handles
// images / HTML / markdown exactly as it does for a real Ctrl+V.
//
// Undo and Redo from a native menu (`undoOrRedo`) reach the editors the same
// way, as the beforeinput event each editor's history handles.

import type { HistoryCommand } from "../ipc/bridge";

/** The kinds of editable surface the menu can act on. */
export type EditableKind = "wysiwyg" | "raw" | "field";

export interface EditableTarget {
  el: HTMLElement;
  kind: EditableKind;
}

/** Matches the editable surfaces in the app: the two editors and form fields. */
const EDITABLE_SELECTOR =
  '.ProseMirror, .cm-content, [contenteditable="true"], [contenteditable="plaintext-only"], input, textarea';

/** The editable containing `node`, or null when the point isn't over one. */
export function editableAt(node: Node | null): EditableTarget | null {
  const start = node instanceof Element ? node : node?.parentElement ?? null;
  const el = start?.closest<HTMLElement>(EDITABLE_SELECTOR);
  if (!el) return null;
  // CodeMirror first: Crepe embeds a `.cm-content` code editor *inside* the
  // ProseMirror document for code blocks, and inside one the raw-text commands
  // are the right ones (and a link mark would be meaningless).
  const cm = el.closest<HTMLElement>(".cm-content");
  if (cm) return { el: cm, kind: "raw" };
  const pm = el.closest<HTMLElement>(".ProseMirror");
  if (pm) return { el: pm, kind: "wysiwyg" };
  return { el, kind: "field" };
}

/** Whether `target` currently has a non-empty selection (drives Cut/Copy state). */
export function hasSelection(target: EditableTarget): boolean {
  if (target.el instanceof HTMLInputElement || target.el instanceof HTMLTextAreaElement) {
    const field = target.el;
    return typeof field.selectionStart === "number" && field.selectionStart !== field.selectionEnd;
  }
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && target.el.contains(sel.anchorNode);
}

/** The selected text, used for the link prompt and as a paste fallback. */
export function selectedText(target: EditableTarget): string {
  if (target.el instanceof HTMLInputElement || target.el instanceof HTMLTextAreaElement) {
    const field = target.el;
    return field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
  }
  return window.getSelection()?.toString() ?? "";
}

export function cut(target: EditableTarget): void {
  target.el.focus();
  document.execCommand("cut");
}

export function copy(target: EditableTarget): void {
  target.el.focus();
  document.execCommand("copy");
}

export function selectAll(target: EditableTarget): void {
  target.el.focus();
  document.execCommand("selectAll");
}

/**
 * Paste the clipboard into `target`. `plain` strips formatting by using only the
 * text/plain flavor. Rich pastes are replayed as a synthetic `paste` event so the
 * smart-paste pipeline runs; if nothing consumes that event (a plain form field,
 * or an engine that ignores synthetic clipboard events) the plain text is
 * inserted directly so the action never silently does nothing.
 */
export async function paste(target: EditableTarget, plain: boolean): Promise<void> {
  target.el.focus();
  const data = await readClipboard(plain);
  if (!data) return;
  if (!plain && target.kind !== "field" && dispatchPaste(target.el, data.transfer)) return;
  if (data.text) document.execCommand("insertText", false, data.text);
}

interface ClipboardPayload {
  transfer: DataTransfer;
  text: string;
}

/** Read the clipboard into a DataTransfer. Falls back to text-only when the rich
 *  read is unavailable or denied (e.g. no clipboard-read permission). */
async function readClipboard(plain: boolean): Promise<ClipboardPayload | null> {
  const transfer = new DataTransfer();
  if (!plain) {
    try {
      let text = "";
      for (const item of await navigator.clipboard.read()) {
        for (const type of item.types) {
          const blob = await item.getType(type);
          if (type.startsWith("image/")) {
            transfer.items.add(new File([blob], `pasted.${type.split("/")[1] || "png"}`, { type }));
          } else if (type === "text/plain" || type === "text/html") {
            const value = await blob.text();
            transfer.setData(type, value);
            if (type === "text/plain") text = value;
          }
        }
      }
      if (transfer.types.length) return { transfer, text };
    } catch {
      // Rich read unavailable — fall through to the text-only path.
    }
  }
  const text = await navigator.clipboard.readText().catch(() => "");
  if (!text) return null;
  transfer.setData("text/plain", text);
  return { transfer, text };
}

/** Replay a paste on `el`; true when an editor consumed it. */
function dispatchPaste(el: HTMLElement, transfer: DataTransfer): boolean {
  let event: ClipboardEvent;
  try {
    event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
  } catch {
    return false; // engine without a constructible ClipboardEvent
  }
  el.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * Run Undo or Redo, chosen in a native menu, in what has the focus. Chromium's
 * own undo knows nothing of the editors' histories, so the document, its
 * frontmatter table and the Markdown source get their editor's undo or redo,
 * through the beforeinput event their histories handle. A plain text field,
 * such as the find card's, keeps Chromium's own.
 */
export function undoOrRedo(command: HistoryCommand): void {
  // The command comes from the main process.
  if (command !== "undo" && command !== "redo") return;
  const focused = document.activeElement;
  // The frontmatter table passes the event on to the document's history. The
  // document gets it at its root, as a code block's editor stops events
  // inside it from reaching ProseMirror.
  const editor =
    focused?.closest(".frontmatter-table-wrap") ? focused : (focused?.closest(".ProseMirror") ?? focused?.closest(".cm-content"));
  if (!editor) {
    document.execCommand(command);
    return;
  }
  const inputType = command === "undo" ? "historyUndo" : "historyRedo";
  editor.dispatchEvent(new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true }));
}
