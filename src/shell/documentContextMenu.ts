// The custom right-click menu that replaced the native WebView one (spec §5.14,
// §6.1). One window-level listener serves the whole app: over editable text it
// offers the editing commands (Cut / Copy / Paste / Paste as plain text / Insert
// link / Select all) plus the document actions, and everywhere else in the app
// chrome just the document actions.
//
// Electron supplies native spelling results before the custom menu opens.
// Two things deliberately still reach their own menus:
//   • Shift+right-click anywhere keeps the native editing menu.
//   • Any right-click a more specific in-app menu already handled — the image
//     menu (§5.5), the tab strip and the Recent rows all call preventDefault and
//     open their own popup before this bubble-phase listener runs.

import { closeContextMenu, showContextMenu, type MenuItem } from "./contextMenu";
import { MENU_ICONS } from "./menuIcons";
import {
  copy,
  cut,
  editableAt,
  hasSelection,
  paste,
  selectAll,
  selectedText,
  type EditableTarget,
} from "./editorActions";
import { openTextPrompt } from "../components/TextPromptDialog";
import { desktopBridge, invoke } from "../ipc/bridge";
import type { SpellingMenuAction } from "../ipc/contracts";
import { isElectron } from "../ipc/env";

export interface DocumentMenuActions {
  /** Whether a document is open — Print / Copy as Markdown are document-scoped. */
  hasDocument: () => boolean;
  /** Open the print workspace (spec §5.21). */
  print: () => void;
  /** Copy the whole document's markdown to the clipboard (§5.10). */
  copyMarkdown: () => void;
  /** Wrap the current document selection in a link, or null when the document
   *  editor isn't the surface being right-clicked. */
  insertLink: (href: string) => boolean;
  /** Report a failed native spelling action in the app's existing notice area. */
  reportError?: (message: string) => void;
}

/** Native spelling choices for the word under this menu. */
export interface SpellingChoices {
  word: string;
  suggestions: string[];
  replace: (suggestion: string) => Promise<void>;
  add: () => Promise<void>;
}

/** Install the app-wide right-click menu and return its effect cleanup. */
export function installDocumentContextMenu(actions: DocumentMenuActions): () => void {
  type Request = { target: EditableTarget | null; x: number; y: number; shift: boolean; cancelled: boolean };
  const requests: Request[] = [];
  let pending: Request | null = null;
  const native = isElectron();
  const dismiss = (contextId: number): void => {
    void invoke("spelling_menu_action", { contextId, action: "dismiss" }).catch(() => {});
  };
  const unlisten = native ? desktopBridge().listen("spelling-context-menu", (context) => {
    // Native context events and their IPC replies retain the DOM request order.
    // Keep cancelled requests until their replies arrive, including two clicks
    // at the same coordinates, so an old reply cannot consume the next click.
    const requested = requests.shift();
    if (requested === pending) pending = null;
    if (!requested || requested.cancelled || !requested.target?.el.isConnected || Math.abs(requested.x - context.x) > 2 || Math.abs(requested.y - context.y) > 2) {
      dismiss(context.id);
      return;
    }
    const perform = async (action: SpellingMenuAction): Promise<void> => {
      try {
        await invoke("spelling_menu_action", action);
      } catch {
        actions.reportError?.("The spelling action could not be completed. Right-click the word to try again.");
      }
    };
    if (requested.shift) {
      void perform({ contextId: context.id, action: "native" });
      return;
    }
    const items = buildItems(requested.target, actions, {
      word: context.word,
      suggestions: context.suggestions,
      replace: (suggestion) => perform({ contextId: context.id, action: "replace", suggestion }),
      add: () => perform({ contextId: context.id, action: "add" }),
    }).map((item) => ({
      ...item,
      run: async (): Promise<void> => {
        try { await item.run(); } finally { dismiss(context.id); }
      },
    }));
    showContextMenu(requested.x, requested.y, items, "Edit", () => dismiss(context.id));
  }) : undefined;
  // A second input while the native answer is in flight makes that answer stale.
  const clearPending = (): void => {
    if (pending) pending.cancelled = true;
    pending = null;
  };
  const onContextMenu = (e: MouseEvent): void => {
    // A more specific in-app menu already handled this click.
    if (e.defaultPrevented) return;
    const target = editableAt(e.target as Node | null);
    if (native && (target || e.shiftKey)) {
      closeContextMenu();
      clearPending();
      pending = { target, x: e.clientX, y: e.clientY, shift: e.shiftKey, cancelled: false };
      requests.push(pending);
      // Chromium only reports the clicked misspelling when default is allowed.
      return;
    }
    // Browser builds keep their browser's native spelling menu on Shift.
    if (e.shiftKey) return;
    e.preventDefault();
    // Over text the menu holds the editing commands, elsewhere only document actions.
    showContextMenu(e.clientX, e.clientY, buildItems(target, actions), target ? "Edit" : "Document");
  };
  window.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("pointerdown", clearPending, true);
  window.addEventListener("keydown", clearPending, true);
  window.addEventListener("blur", clearPending);
  return () => {
    pending = null;
    requests.length = 0;
    unlisten?.();
    window.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("pointerdown", clearPending, true);
    window.removeEventListener("keydown", clearPending, true);
    window.removeEventListener("blur", clearPending);
    closeContextMenu();
  };
}

/** The menu for a right-click at `target` (null = app chrome, no editable). */
export function buildItems(
  target: EditableTarget | null,
  actions: DocumentMenuActions,
  spelling?: SpellingChoices,
): MenuItem[] {
  const hasDoc = actions.hasDocument();
  const documentItems: MenuItem[] = [
    {
      label: "Copy as Markdown",
      icon: MENU_ICONS.markdown,
      disabled: !hasDoc,
      separatorBefore: target !== null,
      run: () => actions.copyMarkdown(),
    },
    {
      label: "Print…",
      icon: MENU_ICONS.print,
      shortcut: "Ctrl+P",
      disabled: !hasDoc,
      run: () => actions.print(),
    },
  ];
  if (!target) return documentItems;

  const selected = hasSelection(target);
  const spellingItems: MenuItem[] = spelling?.word ? [
    ...(spelling.suggestions.length ? spelling.suggestions.map((suggestion) => ({
      label: suggestion, run: () => spelling.replace(suggestion),
    })) : [{ label: "No spelling suggestions", disabled: true, run: () => {} }]),
    { label: "Add to dictionary", run: () => spelling.add() },
  ] : [];
  return [
    ...spellingItems,
    {
      label: "Cut",
      separatorBefore: spellingItems.length > 0,
      icon: MENU_ICONS.cut,
      shortcut: "Ctrl+X",
      disabled: !selected,
      run: () => cut(target),
    },
    {
      label: "Copy",
      icon: MENU_ICONS.copy,
      shortcut: "Ctrl+C",
      disabled: !selected,
      run: () => copy(target),
    },
    // Paste stays enabled unconditionally: reading the clipboard to find out
    // whether it holds anything is async, and the menu is built synchronously.
    {
      label: "Paste",
      icon: MENU_ICONS.paste,
      shortcut: "Ctrl+V",
      run: () => paste(target, false),
    },
    {
      label: "Paste as plain text",
      icon: MENU_ICONS.pastePlain,
      shortcut: "Ctrl+Shift+V",
      run: () => paste(target, true),
    },
    {
      label: "Insert link…",
      icon: MENU_ICONS.link,
      separatorBefore: true,
      // Only meaningful over the document editor and only with text selected —
      // the link wraps the selection (§5.6).
      disabled: target.kind !== "wysiwyg" || !selected,
      run: () => promptForLink(target, actions),
    },
    {
      label: "Select all",
      icon: MENU_ICONS.selectAll,
      shortcut: "Ctrl+A",
      run: () => selectAll(target),
    },
    ...documentItems,
  ];
}

/** Ask for a URL and wrap the selection in it. Mirrors the alt-text prompt used
 *  by the image menu (§5.5) rather than introducing a second dialog style. */
async function promptForLink(target: EditableTarget, actions: DocumentMenuActions): Promise<void> {
  const selected = selectedText(target).trim();
  const href = await openTextPrompt({
    title: "Insert link",
    label: selected ? `Link URL for "${selected}"` : "Link URL",
    initialValue: "https://",
    confirmLabel: "Insert",
  });
  if (href === null) return;
  const trimmed = href.trim();
  if (trimmed) actions.insertLink(trimmed);
}
