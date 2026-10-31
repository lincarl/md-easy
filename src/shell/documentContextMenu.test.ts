// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildItems, installDocumentContextMenu, type DocumentMenuActions } from "./documentContextMenu";
import type { ElectronBridge } from "../ipc/bridge";
import type { SpellingMenuContext } from "../ipc/contracts";
import type { EditableTarget } from "./editorActions";
import { editableAt, hasSelection, selectedText } from "./editorActions";
import type { MenuItem } from "./contextMenu";

function actions(overrides: Partial<DocumentMenuActions> = {}): DocumentMenuActions {
  return {
    hasDocument: () => true,
    print: () => {},
    copyMarkdown: () => {},
    insertLink: () => true,
    ...overrides,
  };
}

/**
 * An editable to right-click, with `selected` standing in for the browser
 * selection — jsdom never reports one, and `hasSelection` checks that the
 * selection anchor is *inside* the editable, so the stub has to anchor there.
 */
function target(kind: EditableTarget["kind"], selected = ""): EditableTarget {
  const el = document.createElement("div");
  document.body.appendChild(el);
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: selected === "",
    anchorNode: el,
    toString: () => selected,
  } as unknown as Selection);
  return { el, kind };
}

const labels = (items: MenuItem[]): string[] => items.map((i) => i.label);
const byLabel = (items: MenuItem[], label: string): MenuItem =>
  items.find((i) => i.label === label)!;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  delete window.downpadDesktop;
});

beforeEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("buildItems", () => {
  it("recognizes plaintext-only frontmatter fields and their text selection", () => {
    const field = document.createElement("div");
    field.setAttribute("contenteditable", "plaintext-only");
    field.textContent = "Draft notes";
    document.body.append(field);
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(field);
    selection.addRange(range);
    const editable = editableAt(field)!;
    expect(editable).toEqual({ el: field, kind: "field" });
    expect(hasSelection(editable)).toBe(true);
    expect(selectedText(editable)).toBe("Draft notes");
    expect(byLabel(buildItems(editable, actions()), "Copy").disabled).toBe(false);
    expect(byLabel(buildItems(editable, actions()), "Insert link…").disabled).toBe(true);
  });

  it("offers only the document actions off an editable, and exactly one Print entry", () => {
    const items = buildItems(null, actions());
    expect(labels(items)).toEqual(["Copy as Markdown", "Print…"]);
    // The version choice lives in the print workspace, never as a submenu here.
    expect(items.filter((i) => i.label.startsWith("Print"))).toHaveLength(1);
  });

  it("disables the document actions when nothing is open", () => {
    const items = buildItems(null, actions({ hasDocument: () => false }));
    expect(byLabel(items, "Print…").disabled).toBe(true);
    expect(byLabel(items, "Copy as Markdown").disabled).toBe(true);
  });

  it("adds the editing commands over editable text", () => {
    const items = buildItems(target("wysiwyg"), actions());
    expect(labels(items)).toEqual([
      "Cut",
      "Copy",
      "Paste",
      "Paste as plain text",
      "Insert link…",
      "Select all",
      "Copy as Markdown",
      "Print…",
    ]);
  });

  it("greys out the selection-dependent commands when nothing is selected", () => {
    const items = buildItems(target("wysiwyg"), actions());
    expect(byLabel(items, "Cut").disabled).toBe(true);
    expect(byLabel(items, "Copy").disabled).toBe(true);
    expect(byLabel(items, "Insert link…").disabled).toBe(true);
    // Paste can't be checked synchronously, so it is never greyed out.
    expect(byLabel(items, "Paste").disabled).toBeUndefined();
    expect(byLabel(items, "Select all").disabled).toBeUndefined();
  });

  it("enables cut/copy/link once there is a selection", () => {
    const items = buildItems(target("wysiwyg", "some words"), actions());
    expect(byLabel(items, "Cut").disabled).toBe(false);
    expect(byLabel(items, "Copy").disabled).toBe(false);
    expect(byLabel(items, "Insert link…").disabled).toBe(false);
  });

  it("keeps Insert link off the Markdown source pane, where a link mark has no meaning", () => {
    const items = buildItems(target("raw", "some words"), actions());
    expect(byLabel(items, "Insert link…").disabled).toBe(true);
    expect(byLabel(items, "Cut").disabled).toBe(false);
  });

  it("routes Print and Copy as Markdown to the shell", () => {
    const print = vi.fn();
    const copyMarkdown = vi.fn();
    const items = buildItems(null, actions({ print, copyMarkdown }));
    byLabel(items, "Print…").run();
    byLabel(items, "Copy as Markdown").run();
    expect(print).toHaveBeenCalledOnce();
    expect(copyMarkdown).toHaveBeenCalledOnce();
  });

  it("adds native corrections and dictionary actions before the existing editing menu", async () => {
    const replace = vi.fn(async () => {});
    const add = vi.fn(async () => {});
    const items = buildItems(target("wysiwyg"), actions(), { word: "speling", suggestions: ["spelling"], replace, add });
    expect(labels(items).slice(0, 3)).toEqual(["spelling", "Add to dictionary", "Cut"]);
    expect(byLabel(items, "Cut").separatorBefore).toBe(true);
    await byLabel(items, "spelling").run();
    await byLabel(items, "Add to dictionary").run();
    expect(replace).toHaveBeenCalledWith("spelling");
    expect(add).toHaveBeenCalledOnce();
    const noSuggestions = buildItems(target("raw"), actions(), { word: "zorblax", suggestions: [], replace, add });
    expect(byLabel(noSuggestions, "No spelling suggestions").disabled).toBe(true);
    expect(labels(noSuggestions)).toContain("Add to dictionary");
    expect(labels(buildItems(target("raw"), actions(), { word: "", suggestions: [], replace, add }))).not.toContain("Add to dictionary");
  });
});

describe("installDocumentContextMenu", () => {
  /** Fire a bubbling, cancelable contextmenu and report what happened. */
  function rightClick(el: Element, init: MouseEventInit = {}): { prevented: boolean; menu: boolean } {
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(ev);
    return {
      prevented: ev.defaultPrevented,
      menu: document.querySelector(".md-context-menu") !== null,
    };
  }

  beforeEach(async () => {
    document.querySelector(".md-context-menu")?.remove();
    const { installDocumentContextMenu } = await import("./documentContextMenu");
    cleanups.push(installDocumentContextMenu(actions()));
  });

  it("replaces the native menu everywhere in the app", () => {
    const chrome = document.createElement("button");
    document.body.appendChild(chrome);
    const result = rightClick(chrome);
    expect(result.prevented).toBe(true);
    expect(result.menu).toBe(true);
  });

  it("names the menu for what it holds", () => {
    const chrome = document.createElement("button");
    const editable = document.createElement("textarea");
    document.body.append(chrome, editable);
    rightClick(chrome);
    expect(document.querySelector(".md-context-menu")?.getAttribute("aria-label")).toBe("Document");
    rightClick(editable);
    expect(document.querySelector(".md-context-menu")?.getAttribute("aria-label")).toBe("Edit");
  });

  it("lets Shift+right-click through so Chromium spell-check suggestions survive (§5.14)", () => {
    const editable = document.createElement("div");
    editable.className = "ProseMirror";
    document.body.appendChild(editable);
    const result = rightClick(editable, { shiftKey: true });
    expect(result.prevented).toBe(false); // native menu opens instead
    expect(result.menu).toBe(false);
  });

  it("defers to a menu that already handled the click (images, tabs, Recent rows)", () => {
    const row = document.createElement("div");
    document.body.appendChild(row);
    row.addEventListener("contextmenu", (e) => e.preventDefault());
    expect(rightClick(row).menu).toBe(false);
  });
});

describe("native spelling menu bridge", () => {
  let receive: (context: SpellingMenuContext) => void;
  let invoke: ReturnType<typeof vi.fn>;
  let editable: HTMLTextAreaElement;
  const reportError = vi.fn();

  beforeEach(() => {
    invoke = vi.fn().mockResolvedValue(undefined);
    window.downpadDesktop = {
      platform: "linux", invoke,
      listen: (_event: string, handler: typeof receive) => { receive = handler; return () => {}; },
    } as unknown as ElectronBridge;
    editable = document.createElement("textarea");
    document.body.append(editable);
    cleanups.push(installDocumentContextMenu(actions({ reportError })));
  });

  /** Request a menu through the DOM, then deliver Chromium's asynchronous spelling result. */
  function open(id = 1, shiftKey = false): void {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30, shiftKey });
    editable.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    receive({ id, x: 21, y: 31, word: "speling", suggestions: ["spelling"] });
  }

  it("routes a correction to its native context and clears the context after the action", async () => {
    open(7);
    const button = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((item) => item.textContent === "spelling");
    button!.click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("spelling_menu_action", { contextId: 7, action: "dismiss" }));
    expect(invoke).toHaveBeenCalledWith("spelling_menu_action", { contextId: 7, action: "replace", suggestion: "spelling" });
    expect(document.querySelector(".md-context-menu")).toBeNull();
  });

  it("invalidates dismissed and delayed menus instead of applying stale corrections", () => {
    open(2);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(invoke).toHaveBeenCalledWith("spelling_menu_action", { contextId: 2, action: "dismiss" });
    editable.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 30 }));
    window.dispatchEvent(new Event("pointerdown"));
    receive({ id: 3, x: 20, y: 30, word: "speling", suggestions: ["spelling"] });
    expect(document.querySelector(".md-context-menu")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("spelling_menu_action", { contextId: 3, action: "dismiss" });
  });

  it("preserves Shift+right-click and reports failed spelling actions", async () => {
    open(4, true);
    expect(invoke).toHaveBeenCalledWith("spelling_menu_action", { contextId: 4, action: "native" });
    expect(document.querySelector(".md-context-menu")).toBeNull();
    open(5);
    invoke.mockRejectedValueOnce(new Error("Native failure"));
    const button = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((item) => item.textContent === "Add to dictionary");
    button!.click();
    await vi.waitFor(() => expect(reportError).toHaveBeenCalled());
  });

  it("does not pair a cancelled reply with a newer click at the same coordinates", () => {
    const request = (): void => {
      editable.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 30 }));
    };
    request();
    window.dispatchEvent(new Event("pointerdown"));
    request();
    receive({ id: 1, x: 20, y: 30, word: "oldword", suggestions: ["Old correction"] });
    expect(document.querySelector(".md-context-menu")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("spelling_menu_action", { contextId: 1, action: "dismiss" });
    receive({ id: 2, x: 20, y: 30, word: "newword", suggestions: ["New correction"] });
    expect(document.querySelector(".md-context-menu")?.textContent).toContain("New correction");
    expect(invoke).not.toHaveBeenCalledWith("spelling_menu_action", { contextId: 2, action: "dismiss" });
  });
});
