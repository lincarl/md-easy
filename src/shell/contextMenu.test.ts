// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { closeContextMenu, showContextMenu, isContextMenuOpen } from "./contextMenu";
import { MENU_ICONS } from "./menuIcons";

afterEach(() => closeContextMenu());

const menu = (): HTMLElement => document.querySelector(".md-context-menu")!;
const rows = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".md-context-menu-item"));

describe("showContextMenu", () => {
  it("renders one row per item, with its shortcut hint and icon", () => {
    showContextMenu(10, 20, [
      { label: "Cut", shortcut: "Ctrl+X", icon: MENU_ICONS.cut, run: () => {} },
      { label: "Print…", shortcut: "Ctrl+P", icon: MENU_ICONS.print, run: () => {} },
    ], "Menu");
    expect(rows()).toHaveLength(2);
    expect(rows()[0].querySelector(".md-context-menu-label")!.textContent).toBe("Cut");
    expect(rows()[0].querySelector(".md-context-menu-key")!.textContent).toBe("Ctrl+X");
    expect(rows()[0].querySelector(".md-context-menu-icon svg")).not.toBeNull();
    expect(menu().style.left).toBe("10px");
    expect(menu().style.top).toBe("20px");
  });

  it("has a name, and gives screen readers each shortcut as a key, not as part of the row's name", () => {
    showContextMenu(0, 0, [
      { label: "Cut", shortcut: "Ctrl+X", run: () => {} },
      { label: "Paste as plain text", shortcut: "Ctrl+Shift+V", run: () => {} },
      { label: "Insert link…", run: () => {} },
    ], "Edit");
    expect(screen.getByRole("menu", { name: "Edit" })).toBe(menu());
    expect(screen.getByRole("menuitem", { name: "Cut" }).getAttribute("aria-keyshortcuts")).toBe("Control+X");
    expect(screen.getByRole("menuitem", { name: "Paste as plain text" }).getAttribute("aria-keyshortcuts"))
      .toBe("Control+Shift+V");
    expect(screen.getByRole("menuitem", { name: "Insert link…" }).hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("reserves the icon column on rows without an icon so labels stay aligned", () => {
    showContextMenu(0, 0, [
      { label: "With", icon: MENU_ICONS.copy, run: () => {} },
      { label: "Without", run: () => {} },
    ], "Menu");
    // Both rows get the slot; only the first one has glyph markup inside it.
    expect(rows()[1].querySelector(".md-context-menu-icon")).not.toBeNull();
    expect(rows()[1].querySelector(".md-context-menu-icon svg")).toBeNull();
  });

  it("omits the icon column entirely for a text-only menu", () => {
    showContextMenu(0, 0, [{ label: "Open", run: () => {} }], "Menu");
    expect(rows()[0].querySelector(".md-context-menu-icon")).toBeNull();
  });

  it("runs an enabled item and closes, but ignores a disabled one", () => {
    let ran = "";
    showContextMenu(0, 0, [
      {
        label: "Enabled",
        run: () => {
          ran += "e";
        },
      },
      {
        label: "Disabled",
        disabled: true,
        run: () => {
          ran += "d";
        },
      },
    ], "Menu");
    rows()[1].click();
    expect(ran).toBe("");
    expect(isContextMenuOpen()).toBe(true);
    rows()[0].click();
    expect(ran).toBe("e");
    expect(isContextMenuOpen()).toBe(false);
  });

  it("draws a separator above an item that asks for one", () => {
    showContextMenu(0, 0, [
      { label: "A", run: () => {} },
      { label: "B", separatorBefore: true, run: () => {} },
    ], "Menu");
    expect(menu().querySelectorAll(".md-context-menu-sep")).toHaveLength(1);
    expect(menu().children[1].className).toBe("md-context-menu-sep");
  });

  it("closes on Tab and returns focus to where it was opened", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    showContextMenu(0, 0, [{ label: "Copy", run: () => {} }], "Menu");
    expect(document.activeElement).toBe(rows()[0]);

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    rows()[0].dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(isContextMenuOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("replaces an already-open menu instead of stacking a second one", () => {
    showContextMenu(0, 0, [{ label: "First", run: () => {} }], "Menu");
    showContextMenu(0, 0, [{ label: "Second", run: () => {} }], "Menu");
    expect(document.querySelectorAll(".md-context-menu")).toHaveLength(1);
    expect(rows()[0].textContent).toBe("Second");
  });

  it("dismisses stale commands when a shortcut focuses another editor", () => {
    const editor = document.createElement("textarea");
    const nextEditor = document.createElement("textarea");
    document.body.append(editor, nextEditor);
    editor.focus();
    const dismissed = vi.fn();
    showContextMenu(0, 0, [{ label: "Replace word", run: () => {} }], "Edit", dismissed);

    nextEditor.focus();

    expect(isContextMenuOpen()).toBe(false);
    expect(dismissed).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(nextEditor);
    editor.remove();
    nextEditor.remove();
  });

  it("focuses its first item and closes immediately on Escape", () => {
    const invoker = document.createElement("button");
    document.body.append(invoker);
    invoker.focus();
    showContextMenu(0, 0, [{ label: "Open", run: () => {} }], "Menu");

    expect(document.activeElement).toBe(rows()[0]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(isContextMenuOpen()).toBe(false);
    expect(document.querySelector(".md-context-menu")).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });
});
