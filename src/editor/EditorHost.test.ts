// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import { Store } from "../state/store";
import { hasUnsavedChanges, type AppState } from "../state/types";
import type { WysiwygContext } from "./wysiwyg/context";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fakeEditors = vi.hoisted(() => ({
  mountPromise: Promise.resolve() as Promise<void>,
  destroyPromise: Promise.resolve() as Promise<void>,
  mountCalls: 0,
  destroyCalls: 0,
  /** The text and serializer bullet each document pane was built with, in order. */
  mounted: [] as Array<{ markdown: string; bullet: string }>,
  /** What each document pane was given of the app, in order. */
  contexts: [] as WysiwygContext[],
  /** Runs as each document pane starts to build, to simulate an edit then. */
  duringMount: null as (() => void) | null,
  /** What the document pane writes, its own form of the tab's text or typing. */
  markdown: "document pane's form",
  /** Whether the document pane holds typing it has not reported yet. */
  pending: false,
  reportCalls: 0,
  /** Whether each report kept a typed closing mark waiting, in order. */
  keptTypedMarks: [] as boolean[],
  /** The text the split last mirrored into the document pane. */
  mirrored: null as string | null,
  /** The document pane's change callback, to simulate its delayed report. */
  wysiwygChange: null as ((markdown: string) => void) | null,
  /** The Markdown pane's change callback, to simulate typing in it. */
  rawChange: null as ((text: string) => void) | null,
  /** The Markdown pane's current text. */
  rawText: null as string | null,
  /** Whether each reveal of a Markdown pane asked it to take focus. */
  rawShowFocus: [] as boolean[],
  /** Each pane's find change callback, to simulate an edit with the card open. */
  wysiwygFindChange: null as (() => void) | null,
  rawFindChange: null as (() => void) | null,
  /** When each document pane build starts and ends, and when the host forgets
   *  the image answers, in order. */
  events: [] as string[],
  /** The viewport point the document pane last aimed a drop at. */
  droppedAt: null as [number, number] | null,
  /** The drop target the document pane's last insert went to, if any. */
  insertedAt: null as { pos: number } | null,
  /** The element of the document pane that took the last insert. */
  insertedInto: null as HTMLElement | null,
  /** The drop targets the document panes keep in step with edits. */
  heldTargets: new Set<{ pos: number }>(),
  /** The viewport point the Markdown pane last aimed a drop at. */
  rawDroppedAt: null as [number, number] | null,
  /** The drop target the Markdown pane's last insert went to, if any. */
  rawInsertedAt: null as { pos: number } | null,
  /** Whether the last insert in either pane moved the caret after the file. */
  movedCaret: null as boolean | null,
  /** Whether the document pane finds where a dropped file goes in the source. */
  findsSource: true,
  /** The source change the Markdown pane last made for a file dropped on the
   *  document pane. */
  rawEdit: null as { from: number; to: number; insert: string } | null,
}));

/** The counts each fake pane reports, so a test can tell which pane answered. */
const DOCUMENT_COUNTS = { current: 1, total: 3 };
const MARKDOWN_COUNTS = { current: 0, total: 4 };

vi.mock("./wysiwyg/WysiwygEditor", () => ({
  WysiwygEditor: class {
    private onChange: ((markdown: string) => void) | null = null;
    private root: HTMLElement | null = null;

    async mount(
      root: HTMLElement,
      markdown: string,
      cb: { onChange(markdown: string): void; onFindChange?(): void },
      style: { bullet: string },
      context: WysiwygContext,
    ): Promise<void> {
      fakeEditors.mountCalls += 1;
      fakeEditors.mounted.push({ markdown, bullet: style.bullet });
      fakeEditors.contexts.push(context);
      fakeEditors.events.push(`build ${markdown}`);
      fakeEditors.duringMount?.();
      this.root = root;
      this.onChange = cb.onChange;
      fakeEditors.wysiwygChange = cb.onChange;
      fakeEditors.wysiwygFindChange = cb.onFindChange ?? null;
      await fakeEditors.mountPromise;
      fakeEditors.events.push(`built ${markdown}`);
    }

    getMarkdown(): string {
      return fakeEditors.markdown;
    }

    /** Like the real editor, report held-back typing through `onChange`. */
    reportPendingChange({ keepTypedMark = false }: { keepTypedMark?: boolean } = {}): void {
      fakeEditors.reportCalls += 1;
      fakeEditors.keptTypedMarks.push(keepTypedMark);
      if (!fakeEditors.pending) return;
      fakeEditors.pending = false;
      this.onChange?.(fakeEditors.markdown);
    }

    /** Like the real editor, aim a drop at a viewport point. */
    dropTargetAt(x: number, y: number): { pos: number } {
      fakeEditors.droppedAt = [x, y];
      const target = { pos: 7 };
      fakeEditors.heldTargets.add(target);
      return target;
    }

    releaseDropTarget(target: { pos: number }): void {
      fakeEditors.heldTargets.delete(target);
    }

    /** Like the real editor, aim pasted images at the caret. */
    caretTarget(): { pos: number } {
      const target = { pos: 5 };
      fakeEditors.heldTargets.add(target);
      return target;
    }

    /** Like the real editor with the find card's current match in the
     *  frontmatter table, focus that table's cell. */
    focus(): void {
      if (!this.root) return;
      const cell = this.root.querySelector("input") ?? this.root.appendChild(document.createElement("input"));
      cell.focus();
    }

    /** Take focus with a caret in the document text. */
    focusText(): void {
      if (!this.root) return;
      const caret = this.root.querySelector("textarea") ?? this.root.appendChild(document.createElement("textarea"));
      caret.focus();
    }

    /** Like the real editor, hold the insert back until typing pauses, and
     *  give the target for the drop's next file, a new one after a file that
     *  went in at the caret. */
    insertMarkdown(markdown: string, target: { pos: number } | null = null, moveCaret = true): { pos: number } {
      fakeEditors.markdown = `${fakeEditors.markdown}\n\n${markdown}`;
      fakeEditors.pending = true;
      fakeEditors.insertedAt = target;
      fakeEditors.insertedInto = this.root;
      fakeEditors.movedCaret = moveCaret;
      const next = target ?? { pos: 11 };
      fakeEditors.heldTargets.add(next);
      return next;
    }

    /** Like the real editor, insert the file and give the change to the
     *  source that puts it in the same place, here at the end. */
    insertMarkdownWithSource(markdown: string, target: { pos: number }, source: string) {
      this.insertMarkdown(markdown, target, false);
      const end = source.length;
      return fakeEditors.findsSource ? { from: end, to: end, insert: `\n\n${markdown}`, assoc: -1 as const } : null;
    }

    /** The pane now shows the mirrored text, dropping anything it held. */
    setMarkdown(markdown: string): void {
      fakeEditors.mirrored = markdown;
      fakeEditors.markdown = markdown;
    }

    currentCounts() {
      return DOCUMENT_COUNTS;
    }

    async destroy(): Promise<void> {
      fakeEditors.destroyCalls += 1;
      await fakeEditors.destroyPromise;
    }

    onShow(): void {}
  },
}));

vi.mock("./raw/RawEditor", () => ({
  RawEditor: class {
    private root: HTMLElement | null = null;
    private onChange: ((text: string) => void) | null = null;

    /** The fake editor has no CodeMirror attributes to configure. */
    setSpellcheck(_enabled: boolean): void {}

    mount(root: HTMLElement, text: string, cb: { onChange(text: string): void; onFindChange?(): void }): void {
      this.root = root;
      this.onChange = cb.onChange;
      fakeEditors.rawText = text;
      fakeEditors.rawChange = cb.onChange;
      fakeEditors.rawFindChange = cb.onFindChange ?? null;
    }

    getText(): string {
      return fakeEditors.rawText ?? "";
    }

    setText(text: string): void {
      fakeEditors.rawText = text;
    }

    currentCounts() {
      return MARKDOWN_COUNTS;
    }

    /** Like the real editor, aim a drop at a viewport point. */
    dropTargetAt(x: number, y: number): { pos: number } {
      fakeEditors.rawDroppedAt = [x, y];
      return { pos: 3 };
    }

    /** Like the real editor, aim a file at the caret as a paragraph of its own. */
    blockTargetAtCaret(): { pos: number; newBlock: boolean } {
      return { pos: 0, newBlock: true };
    }

    releaseDropTarget(): void {}

    /** Like the real editor, add the text at the target or the caret, here
     *  the end either way, report the edit at once, and give the target for
     *  the drop's next file. */
    insertText(text: string, target: { pos: number } | null = null, moveCaret = true): { pos: number } {
      fakeEditors.rawText = `${fakeEditors.rawText ?? ""}${text}`;
      fakeEditors.rawInsertedAt = target;
      fakeEditors.movedCaret = moveCaret;
      this.onChange?.(fakeEditors.rawText);
      return target ?? { pos: fakeEditors.rawText.length };
    }

    /** Like the real editor, make a change to the text and report it. */
    applyDropEdit(edit: { from: number; to: number; insert: string }): void {
      const text = fakeEditors.rawText ?? "";
      fakeEditors.rawText = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
      fakeEditors.rawEdit = edit;
      this.onChange?.(fakeEditors.rawText);
    }

    /** Take focus with a caret in the pane. */
    focus(): void {
      if (!this.root) return;
      const caret = this.root.querySelector("textarea") ?? this.root.appendChild(document.createElement("textarea"));
      caret.focus();
    }

    destroy(): void {}
    onShow(focus = true): void {
      fakeEditors.rawShowFocus.push(focus);
    }
  },
}));

vi.mock("./wysiwyg/spellcheck", () => ({ applySpellcheck: vi.fn() }));

vi.mock("./wysiwyg/imageView", () => ({
  forgetImageAnswers: (): void => {
    fakeEditors.events.push("forget image answers");
  },
}));

import { EditorHost } from "./EditorHost";

/** The classes of the visible panes. */
const shown = (root: HTMLElement): string[] =>
  [...root.querySelectorAll<HTMLElement>(".editor-pane:not([hidden])")].map((pane) => pane.className);
const failureOf = (store: Store, tabId: string) =>
  store.get().tabs.find((tab) => tab.id === tabId)?.documentViewFailure;

function makeStore(): Store {
  const doc = {
    markdown: "original markdown",
    filePath: null,
    isDirty: false,
    savedMarkdown: "original markdown",
    eol: "lf" as const,
    hadBom: false,
    modifiedMs: 0,
    frontmatterCollapsed: false,
  };
  const initial: AppState = {
    view: "wysiwyg",
    sessionId: "editor-host-test",
    doc,
    tabs: [{ id: "tab-1", doc }],
    activeTabId: "tab-1",
    editorLayout: "document",
    settings: DEFAULT_SETTINGS,
    find: {
      open: false,
      query: "",
      replace: "",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      current: 0,
      total: 0,
    },
    banner: null,
    saveStatus: { lastSavedAt: null, autosaving: false },
    started: false,
  };
  return new Store(initial);
}

beforeEach(() => {
  fakeEditors.mountPromise = Promise.resolve();
  fakeEditors.destroyPromise = Promise.resolve();
  fakeEditors.mountCalls = 0;
  fakeEditors.destroyCalls = 0;
  fakeEditors.mounted = [];
  fakeEditors.contexts = [];
  fakeEditors.duringMount = null;
  fakeEditors.markdown = "document pane's form";
  fakeEditors.pending = false;
  fakeEditors.reportCalls = 0;
  fakeEditors.keptTypedMarks = [];
  fakeEditors.mirrored = null;
  fakeEditors.wysiwygChange = null;
  fakeEditors.rawChange = null;
  fakeEditors.rawText = null;
  fakeEditors.rawShowFocus = [];
  fakeEditors.wysiwygFindChange = null;
  fakeEditors.rawFindChange = null;
  fakeEditors.events = [];
  fakeEditors.droppedAt = null;
  fakeEditors.insertedAt = null;
  fakeEditors.insertedInto = null;
  fakeEditors.heldTargets.clear();
  fakeEditors.rawDroppedAt = null;
  fakeEditors.rawInsertedAt = null;
  fakeEditors.movedCaret = null;
  fakeEditors.findsSource = true;
  fakeEditors.rawEdit = null;
});

describe("EditorHost terminal disposal", () => {
  it("silences and detaches an in-flight build, leaving its tab's markdown alone", async () => {
    const mount = deferred();
    const destroy = deferred();
    fakeEditors.mountPromise = mount.promise;
    fakeEditors.destroyPromise = destroy.promise;

    const root = document.createElement("div");
    const reactOwnedSibling = document.createElement("div");
    reactOwnedSibling.dataset.owner = "react";
    root.appendChild(reactOwnedSibling);
    const store = makeStore();
    const host = new EditorHost(root, store);

    const presenting = host.reloadActiveDoc();
    expect(fakeEditors.mountCalls).toBe(1);
    expect(root.querySelector(".editor-pane-wysiwyg")).not.toBeNull();

    const firstDispose = host.dispose();
    const secondDispose = host.dispose();
    expect(secondDispose).toBe(firstDispose);
    expect(fakeEditors.destroyCalls).toBe(1);
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();
    // Terminal cleanup removes only editor-owned DOM, never a replacement or
    // sibling owned by React.
    expect(root.firstElementChild).toBe(reactOwnedSibling);

    let disposeSettled = false;
    void firstDispose.then(() => {
      disposeSettled = true;
    });
    await Promise.resolve();
    expect(disposeSettled).toBe(false);

    mount.resolve();
    await presenting;
    // A dead WYSIWYG build must not write over the canonical document after
    // React has disposed its host.
    expect(store.get().doc.markdown).toBe("original markdown");
    expect(store.get().doc.isDirty).toBe(false);
    expect(disposeSettled).toBe(false);

    destroy.resolve();
    await firstDispose;
    expect(disposeSettled).toBe(true);
    expect(host.isMounted()).toBe(false);

    // Disposal is terminal; later runtime work is harmless and cannot recreate
    // an editor in the old root.
    await host.reloadActiveDoc();
    expect(fakeEditors.mountCalls).toBe(1);
    expect(root.firstElementChild).toBe(reactOwnedSibling);
  });

  it("does not resurrect a tab closed while its editor is being created", async () => {
    const mount = deferred();
    const destroy = deferred();
    fakeEditors.mountPromise = mount.promise;
    fakeEditors.destroyPromise = destroy.promise;

    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    const presenting = host.reloadActiveDoc();
    expect(fakeEditors.mountCalls).toBe(1);

    store.closeTab("tab-1");
    const discarding = host.discardTab("tab-1");
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();

    mount.resolve();
    await presenting;
    expect(store.get().activeTabId).toBeNull();
    expect(store.get().tabs).toHaveLength(0);
    expect(host.isMounted()).toBe(false);
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();

    destroy.resolve();
    await discarding;
    await host.dispose();
    expect(fakeEditors.destroyCalls).toBe(1);
  });

  it("waits for a pane already detached by an in-flight reload", async () => {
    const root = document.createElement("div");
    const host = new EditorHost(root, makeStore());
    await host.reloadActiveDoc();

    const destroy = deferred();
    fakeEditors.destroyPromise = destroy.promise;
    const reloading = host.reload();
    expect(fakeEditors.destroyCalls).toBe(1);
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();

    const disposing = host.dispose();
    let disposeSettled = false;
    void disposing.then(() => {
      disposeSettled = true;
    });
    await Promise.resolve();
    expect(disposeSettled).toBe(false);

    destroy.resolve();
    await reloading;
    await disposing;
    expect(disposeSettled).toBe(true);
    expect(fakeEditors.destroyCalls).toBe(1);
  });
});

describe("EditorHost document view failure", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the tab's Markdown alone and records why, then Try again builds the document pane", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("split");
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));

    await host.reloadActiveDoc();
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();
    expect(root.classList.contains("split")).toBe(false);
    expect(failureOf(store, "tab-1")).toEqual({ message: "create failed", dismissed: false });
    expect(fakeEditors.destroyCalls).toBe(1);
    // Find searches the Markdown pane it shows.
    expect(host.counts()).toEqual(MARKDOWN_COUNTS);
    // Typing there edits this tab.
    fakeEditors.rawChange!("fixed text");
    expect(store.get().doc).toMatchObject({ markdown: "fixed text", isDirty: true });

    fakeEditors.mountPromise = Promise.resolve();
    await host.retryDocumentView();
    expect(fakeEditors.mountCalls).toBe(2);
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw", "editor-pane editor-pane-wysiwyg"]);
    expect(root.classList.contains("split")).toBe(true);
    expect(failureOf(store, "tab-1")).toBeUndefined();
    expect(host.counts()).toEqual(DOCUMENT_COUNTS);

    await host.dispose();
    expect(fakeEditors.destroyCalls).toBe(2);
  });

  it("keeps the Markdown view and shows the new error when Try again fails", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();
    store.setDocumentViewFailure("tab-1", { message: "create failed", dismissed: true });

    expect(fakeEditors.rawShowFocus).toEqual([true]);

    fakeEditors.mountPromise = Promise.reject(new Error("failed again"));
    await host.retryDocumentView();
    expect(fakeEditors.mountCalls).toBe(2);
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    expect(failureOf(store, "tab-1")).toEqual({ message: "failed again", dismissed: false });
    // Focus stays on Try again, so pressing Enter again tries again instead of
    // typing a line break into the Markdown view.
    expect(fakeEditors.rawShowFocus).toEqual([true, false]);
    await host.dispose();
  });

  it("tries the document pane again in the Markdown layout, keeping it hidden", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();
    // Another tab chooses the Markdown layout for the window.
    fakeEditors.mountPromise = Promise.resolve();
    store.addTab({ ...store.get().doc, markdown: "other" });
    await host.reloadActiveDoc();
    await host.setLayout("markdown");
    store.activateTab("tab-1");
    await host.showActiveDoc();

    await host.retryDocumentView();
    expect(fakeEditors.mountCalls).toBe(3);
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    // Built and hidden, next to the other tab's.
    expect(root.querySelectorAll(".editor-pane-wysiwyg[hidden]")).toHaveLength(2);
    expect(failureOf(store, "tab-1")).toBeUndefined();
    await host.dispose();
  });

  it("shows no other tab's pane under a failing tab, and other tabs keep the window's layout", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const first = root.querySelector<HTMLElement>(".editor-pane-wysiwyg")!;

    const second = store.addTab({ ...store.get().doc, markdown: "> deep" });
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();
    expect(first.hidden).toBe(true);
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    expect(fakeEditors.rawText).toBe("> deep");
    fakeEditors.rawChange!("> deeper");
    expect(store.get().tabs.map((tab) => tab.doc.markdown)).toEqual(["original markdown", "> deeper"]);

    store.activateTab("tab-1");
    await host.showActiveDoc();
    expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg"]);
    expect(first.hidden).toBe(false);

    // Returning to the failing tab shows its Markdown again without trying again.
    store.activateTab(second);
    await host.showActiveDoc();
    expect(fakeEditors.mountCalls).toBe(2);
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    await host.dispose();
  });

  it("tries the document pane again when the document layout is chosen again", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();

    // The window has the document layout already.
    fakeEditors.mountPromise = Promise.resolve();
    await host.setLayout("document");
    expect(fakeEditors.mountCalls).toBe(2);
    expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg"]);
    expect(failureOf(store, "tab-1")).toBeUndefined();
    await host.dispose();
  });
});

describe("EditorHost find count", () => {
  it("passes on edits only from the pane the find card searches", async () => {
    const host = new EditorHost(document.createElement("div"), makeStore());
    const recount = vi.fn();
    host.setFindChangeHandler(recount);
    host.initLayout("split");
    await host.reloadActiveDoc();

    // The split searches the document pane. A Markdown edit reaches it by mirror sync.
    fakeEditors.rawFindChange!();
    expect(recount).not.toHaveBeenCalled();
    fakeEditors.wysiwygFindChange!();
    expect(recount).toHaveBeenCalledOnce();
    expect(host.counts()).toEqual(DOCUMENT_COUNTS);

    // The Markdown view searches the Markdown pane; the hidden document pane is ignored.
    await host.setLayout("markdown");
    fakeEditors.wysiwygFindChange!();
    expect(recount).toHaveBeenCalledOnce();
    fakeEditors.rawFindChange!();
    expect(recount).toHaveBeenCalledTimes(2);
    expect(host.counts()).toEqual(MARKDOWN_COUNTS);

    await host.dispose();
    fakeEditors.rawFindChange!();
    expect(recount).toHaveBeenCalledTimes(2);
  });
});

describe("EditorHost split divider", () => {
  it("exposes and changes the split ratio from the keyboard", async () => {
    const root = document.createElement("div");
    const host = new EditorHost(root, makeStore());
    host.initLayout("split");
    await host.reloadActiveDoc();
    const divider = root.querySelector<HTMLElement>(".split-divider")!;

    expect(divider.tabIndex).toBe(0);
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(divider.getAttribute("aria-valuenow")).toBe("52");
    expect(root.style.getPropertyValue("--split-left")).toBe("52.000%");

    await host.dispose();
  });
});

describe("EditorHost build", () => {
  it("opens both split panes on the tab's exact text", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    host.initLayout("split");
    await host.reloadActiveDoc();

    // The document pane writes the text its own way, but nothing was edited.
    expect(store.get().doc).toMatchObject({ markdown: "original markdown", isDirty: false });
    expect(fakeEditors.rawText).toBe("original markdown");
    await host.dispose();
  });
});

describe("EditorHost changes while a document pane builds", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Start `show`, which builds a document pane, make `change` while that build
   *  waits, then let it finish. Any later build ends as `later` does. */
  async function changeWhileBuilding(
    show: () => Promise<void>,
    change: () => void,
    later: Promise<void> = Promise.resolve(),
  ): Promise<void> {
    const mount = deferred();
    fakeEditors.mountPromise = mount.promise;
    const showing = show();
    expect(fakeEditors.mounted).not.toHaveLength(0);
    fakeEditors.mountPromise = later;
    change();
    mount.resolve();
    await showing;
  }

  it("shows Try again's document pane with the Markdown typed while it builds, and keeps its edits", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();
    fakeEditors.rawChange!("fixed text");

    await changeWhileBuilding(
      () => host.retryDocumentView(),
      () => fakeEditors.rawChange!("fixed text, typed while it opens"),
    );

    expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg"]);
    expect(failureOf(store, "tab-1")).toBeUndefined();
    // An edit in it reaches the tab, and it was built from the latest text.
    fakeEditors.wysiwygChange!("fixed text, typed while it opens, then the document");
    expect(store.get().doc.markdown).toBe("fixed text, typed while it opens, then the document");
    expect(fakeEditors.mounted.at(-1)?.markdown).toBe("fixed text, typed while it opens");
    await host.dispose();
  });

  it("keeps the Markdown view and the notice when the text typed while Try again builds cannot be shown", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();
    fakeEditors.rawChange!("fixed text");

    await changeWhileBuilding(
      () => host.retryDocumentView(),
      () => fakeEditors.rawChange!("> deep again"),
      Promise.reject(new Error("failed again")),
    );

    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();
    expect(failureOf(store, "tab-1")).toEqual({ message: "failed again", dismissed: false });
    expect(fakeEditors.mounted.at(-1)?.markdown).toBe("> deep again");
    await host.dispose();
  });

  it.each(["document", "split"] as const)(
    "shows the %s layout's new document pane with the Markdown typed while it builds, and keeps its edits",
    async (layout) => {
      const root = document.createElement("div");
      const store = makeStore();
      const host = new EditorHost(root, store);
      host.initLayout("markdown");
      await host.reloadActiveDoc();

      await changeWhileBuilding(
        () => host.setLayout(layout),
        () => fakeEditors.rawChange!("typed while it opens"),
      );

      expect(root.querySelector(".editor-pane-wysiwyg:not([hidden])")).not.toBeNull();
      fakeEditors.wysiwygChange!("typed while it opens, then the document");
      expect(store.get().doc.markdown).toBe("typed while it opens, then the document");
      expect(fakeEditors.mounted.at(-1)?.markdown).toBe("typed while it opens");
      await host.dispose();
    },
  );

  /** Replace the active tab's text the way a reload from disk does, then show it. */
  function reloadFromDisk(store: Store, host: EditorHost, markdown: string): Promise<void> {
    store.replaceActiveDoc({ ...store.get().doc, markdown, savedMarkdown: markdown, isDirty: false });
    return host.reloadActiveDoc();
  }

  it.each([
    ["the split", false],
    ["a failing tab", true],
  ])("keeps the reloaded text when typing lands in the old Markdown pane of %s while the document pane builds", async (_name, failing) => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("split");
    if (failing) fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();
    // The Markdown pane on screen keeps the text from before the reload until
    // the document pane is built.
    const typeInOldPane = fakeEditors.rawChange!;

    await changeWhileBuilding(
      () => reloadFromDisk(store, host, "text from disk"),
      () => typeInOldPane("original markdown, typed during the reload"),
    );

    expect(store.get().doc).toMatchObject({ markdown: "text from disk", isDirty: false });
    // One build for the reload, from the text on disk.
    expect(fakeEditors.mounted.map((build) => build.markdown)).toEqual(["original markdown", "text from disk"]);
    expect(fakeEditors.rawText).toBe("text from disk");
    expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg", "editor-pane editor-pane-raw"]);
    expect(failureOf(store, "tab-1")).toBeUndefined();
    // The Markdown pane built for the reload takes edits.
    fakeEditors.rawChange!("text from disk, typed after");
    expect(store.get().doc.markdown).toBe("text from disk, typed after");
    await host.dispose();
  });

  /** The elements of the visible panes. */
  const shownPanes = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".editor-pane:not([hidden])")];

  /** Start `show`, wait until it begins to build a document pane, and hold that
   *  build until `change` has run. Later builds finish at once. */
  async function changeDuringMount(show: () => Promise<void>, change: () => Promise<void> | void): Promise<void> {
    const mount = deferred();
    fakeEditors.mountPromise = mount.promise;
    const builds = fakeEditors.mountCalls;
    const showing = show();
    await vi.waitFor(() => expect(fakeEditors.mountCalls).toBe(builds + 1));
    fakeEditors.mountPromise = Promise.resolve();
    const changing = change();
    mount.resolve();
    await Promise.all([showing, changing]);
  }

  it.each([
    ["switching tabs", false],
    ["opening a new tab", true],
  ])("shows the active tab's panes after %s while a reload builds, in place of the old Markdown pane", async (_name, newTab) => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("split");
    await host.reloadActiveDoc();
    const oldMarkdownPane = root.querySelector<HTMLElement>(".editor-pane-raw")!;
    const typeInOldPane = fakeEditors.rawChange!;
    const second = store.addTab({ ...store.get().doc, markdown: "second tab" });
    await host.reloadActiveDoc();
    const secondPanes = shownPanes(root);
    store.activateTab("tab-1");
    await host.showActiveDoc();
    expect(shownPanes(root)).toContain(oldMarkdownPane);

    await changeDuringMount(
      () => reloadFromDisk(store, host, "text from disk"),
      () => {
        if (newTab) {
          store.addTab({ ...store.get().doc, markdown: "" });
          return host.reloadActiveDoc();
        }
        store.activateTab(second);
        return host.showActiveDoc();
      },
    );

    // The window shows the active tab, never tab-1's Markdown pane from before
    // the reload, where typing would be dropped.
    expect(oldMarkdownPane.hidden).toBe(true);
    if (newTab) {
      expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg", "editor-pane editor-pane-raw"]);
      expect(fakeEditors.rawText).toBe("");
      // The build for the reload keeps the image answers it waited for.
      expect(fakeEditors.events.slice(-5)).toEqual([
        "build text from disk",
        "built text from disk",
        "forget image answers",
        "build ",
        "built ",
      ]);
    } else {
      expect(shownPanes(root)).toEqual(secondPanes);
    }
    // A stale report from the old pane changes nothing.
    typeInOldPane("original markdown, typed after the switch");
    expect(store.get().tabs.find((tab) => tab.id === "tab-1")?.doc.markdown).toBe("text from disk");

    // Back on tab-1, both panes show the text from disk.
    store.activateTab("tab-1");
    await host.showActiveDoc();
    expect(fakeEditors.rawText).toBe("text from disk");
    expect(fakeEditors.mounted.map((build) => build.markdown)).toEqual(
      ["original markdown", "second tab", "text from disk", ...(newTab ? [""] : [])],
    );
    await host.dispose();
  });

  it.each(["document", "split"] as const)(
    "shows the text from disk in the %s layout when a reload comes while the layout switch builds",
    async (layout) => {
      const root = document.createElement("div");
      const store = makeStore();
      const host = new EditorHost(root, store);
      host.initLayout("markdown");
      await host.reloadActiveDoc();
      const typeInOldPane = fakeEditors.rawChange!;

      await changeDuringMount(
        () => host.setLayout(layout),
        () => {
          const reloading = reloadFromDisk(store, host, "text from disk");
          // The Markdown pane on screen still holds the text from before.
          typeInOldPane("original markdown, typed during the reload");
          return reloading;
        },
      );

      expect(store.get().doc).toMatchObject({ markdown: "text from disk", isDirty: false });
      // The build that began before the reload is done again from the text on
      // disk, which asks about its images again. The first build keeps the
      // image answers it waited for.
      expect(fakeEditors.events).toEqual([
        "forget image answers",
        "build original markdown",
        "built original markdown",
        "forget image answers",
        "build text from disk",
        "built text from disk",
      ]);
      expect(root.querySelectorAll(".editor-pane-wysiwyg")).toHaveLength(1);
      expect(shown(root)).toEqual(
        layout === "split"
          ? ["editor-pane editor-pane-wysiwyg", "editor-pane editor-pane-raw"]
          : ["editor-pane editor-pane-wysiwyg"],
      );
      // The document pane on screen takes edits, on top of the text from disk.
      fakeEditors.wysiwygChange!("text from disk, edited in the document");
      expect(store.get().doc.markdown).toBe("text from disk, edited in the document");
      await host.dispose();
    },
  );

  // The app passes on one choice at a time, because AppRuntime ignores a second
  // layout chosen while the first waits. The last case checks EditorHost's own
  // contract for a second choice.
  it.each([
    [["split"], ["editor-pane editor-pane-wysiwyg", "editor-pane editor-pane-raw"]],
    [["markdown"], ["editor-pane editor-pane-raw"]],
    [["split", "markdown"], ["editor-pane editor-pane-raw"]],
  ] as const)("shows the text from disk in the last layout of %j chosen while the reload builds", async (layouts, panes) => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    let shownOnceChosen: string[] = [];

    await changeDuringMount(
      () => reloadFromDisk(store, host, "text from disk"),
      async () => {
        await Promise.all(layouts.map((layout) => host.setLayout(layout)));
        shownOnceChosen = shown(root);
      },
    );

    // The choice waits for the reload, then shows its layout.
    expect(shownOnceChosen).toEqual(panes);
    expect(shown(root)).toEqual(panes);
    // One build for the reload, from the text on disk.
    expect(fakeEditors.mounted.map((build) => build.markdown)).toEqual(["original markdown", "text from disk"]);
    expect(fakeEditors.rawText).toBe("text from disk");
    // The Markdown pane on screen takes edits.
    fakeEditors.rawChange!("text from disk, typed after");
    expect(store.get().doc.markdown).toBe("text from disk, typed after");
    await host.dispose();
  });

  it("tries a failing tab's document pane again when it is reloaded while another tab's pane builds", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();
    expect(failureOf(store, "tab-1")).toBeDefined();
    store.addTab({ ...store.get().doc, markdown: "second tab" });

    await changeDuringMount(
      () => host.reloadActiveDoc(),
      () => {
        store.activateTab("tab-1");
        return reloadFromDisk(store, host, "text from disk");
      },
    );

    expect(failureOf(store, "tab-1")).toBeUndefined();
    expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg"]);
    expect(fakeEditors.mounted.at(-1)?.markdown).toBe("text from disk");
    await host.dispose();
  });

  it.each(["Markdown", "document"] as const)(
    "builds both split panes from the text on disk when a reload comes while settings rebuild the document pane, with a %s edit's mirror pending",
    async (source) => {
      const root = document.createElement("div");
      const store = makeStore();
      const host = new EditorHost(root, store);
      host.initLayout("split");
      await host.reloadActiveDoc();
      const oldMarkdownPane = root.querySelector<HTMLElement>(".editor-pane-raw")!;
      // The edit schedules its mirror into the other pane.
      if (source === "Markdown") fakeEditors.rawChange!("original markdown, edited");
      else fakeEditors.wysiwygChange!("original markdown, edited");

      await changeDuringMount(
        () => {
          store.set({ settings: { ...store.get().settings, mdBulletChar: "*" } });
          return host.reload();
        },
        () => {
          const reloading = reloadFromDisk(store, host, "text from disk");
          // The mirror runs while the document pane builds, as its timer or a
          // click in the split does.
          host.flush();
          return reloading;
        },
      );

      expect(store.get().doc).toMatchObject({ markdown: "text from disk", isDirty: false });
      // The document pane built from the edited text is built again from the
      // text on disk, after the image answers are forgotten, so it has no undo
      // history from before the reload.
      expect(fakeEditors.events.slice(-5)).toEqual([
        "build original markdown, edited",
        "built original markdown, edited",
        "forget image answers",
        "build text from disk",
        "built text from disk",
      ]);
      // The Markdown pane is built again too.
      expect(root.contains(oldMarkdownPane)).toBe(false);
      expect(fakeEditors.rawText).toBe("text from disk");
      expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg", "editor-pane editor-pane-raw"]);
      await host.dispose();
    },
  );

  it("builds the shown document pane again with settings changed after a tab switch built it", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    store.set({ settings: { ...store.get().settings, maxRetainedTabEditors: 1 } });
    const host = new EditorHost(root, store);
    host.initLayout("document");
    await host.reloadActiveDoc();
    store.addTab({ ...store.get().doc, markdown: "second tab" });
    // The switch builds the second tab's pane, then evicts the first tab's.
    // Hold that eviction, so the settings change lands after the build.
    let release!: () => void;
    fakeEditors.destroyPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const switching = host.showActiveDoc();
    await vi.waitFor(() => expect(fakeEditors.destroyCalls).toBe(1));
    store.set({ settings: { ...store.get().settings, mdBulletChar: "*" } });
    const reloading = host.reload();
    release();
    await Promise.all([switching, reloading]);

    expect(fakeEditors.mounted).toEqual([
      { markdown: "original markdown", bullet: "-" },
      { markdown: "second tab", bullet: "-" },
      { markdown: "second tab", bullet: "*" },
    ]);
    expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg"]);
    await host.dispose();
  });

  it("builds the document pane again with settings changed while it builds", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("markdown");
    await host.reloadActiveDoc();

    await changeWhileBuilding(
      () => host.setLayout("document"),
      () => {
        store.set({ settings: { ...store.get().settings, mdBulletChar: "*" } });
        void host.reload();
      },
    );

    expect(fakeEditors.mounted.map((build) => build.bullet)).toEqual(["-", "*"]);
    expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg"]);
    expect(root.querySelectorAll(".editor-pane-wysiwyg")).toHaveLength(1);
    await host.dispose();
  });

  it("stops building and shows the Markdown with the notice while the typing never pauses", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("markdown");
    await host.reloadActiveDoc();
    let keystrokes = 0;
    fakeEditors.duringMount = () => fakeEditors.rawChange!(`typed ${++keystrokes}`);

    await host.setLayout("document");

    expect(fakeEditors.mountCalls).toBe(5);
    // Every pane built is destroyed again.
    expect(fakeEditors.destroyCalls).toBe(5);
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    expect(failureOf(store, "tab-1")).toEqual({
      message: "the text kept changing while the view opened",
      dismissed: false,
    });
    expect(store.get().doc.markdown).toBe("typed 5");
    await host.dispose();
  });
});

describe("EditorHost image storage", () => {
  it("gives a document pane its tab's path, and no path once the tab is closed", async () => {
    const store = makeStore();
    store.patchDoc({ filePath: "/docs/notes.md" });
    const host = new EditorHost(document.createElement("div"), store);
    await host.reloadActiveDoc();
    const context = fakeEditors.contexts[0]!;

    // Another tab in front leaves the pane its own document's path.
    store.addTab({ ...store.get().doc, filePath: "/other/other.md" });
    expect(context.getFilePath()).toBe("/docs/notes.md");
    // An image stored for the pane after its tab closed never goes beside
    // the document in front then.
    store.closeTab("tab-1");
    expect(context.getFilePath()).toBeNull();
    await host.dispose();
  });
});

describe("EditorHost pasted images", () => {
  it("hands images pasted into a document pane to the app with the pane's tab, and puts them in at its caret, as unsaved until the paste ends", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const store = makeStore();
    const host = new EditorHost(root, store);
    const pasted: Array<[string, File[]]> = [];
    host.setPasteHandler((tabId, files) => pasted.push([tabId, files]));
    await host.reloadActiveDoc();
    const image = new File([], "image.png", { type: "image/png" });

    fakeEditors.contexts[0]!.pasteImages?.([image]);
    expect(pasted).toEqual([["tab-1", [image]]]);
    const paste = host.aimPaste("tab-1")!;
    expect(hasUnsavedChanges(store.get().tabs[0]!)).toBe(true);
    expect(await host.insertDropped(paste, "![](attachments/img.png)")).toBe(true);

    // The caret's place the pane gave when the image was pasted.
    expect(fakeEditors.insertedAt).toEqual({ pos: 5 });
    // The pane takes focus with the caret after the image.
    expect(root.querySelector(".editor-pane-wysiwyg")!.contains(document.activeElement)).toBe(true);
    host.releaseDrop(paste);
    expect(store.get().tabs[0]!.filesPending).toBe(false);
    expect(fakeEditors.heldTargets.size).toBe(0);
    root.remove();
    await host.dispose();
  });

  it("puts an image pasted before a switch to the Markdown view where it was pasted, through the Markdown pane, so typing there afterwards counts", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const paste = host.aimPaste("tab-1")!;
    await host.setLayout("markdown");

    expect(await host.insertDropped(paste, "![](attachments/img.png)")).toBe(true);
    host.releaseDrop(paste);
    fakeEditors.rawChange!(`${fakeEditors.rawText} Typed.`);

    // At the caret's place in the hidden document pane, and the matching
    // place in the Markdown source, rather than at the Markdown view's caret.
    expect(fakeEditors.insertedInto).toBe(root.querySelector(".editor-pane-wysiwyg"));
    expect(fakeEditors.insertedAt).toEqual({ pos: 5 });
    expect(fakeEditors.rawEdit).toEqual({ from: 17, to: 17, insert: "\n\n![](attachments/img.png)", assoc: -1 });
    expect(store.get().doc.markdown).toBe("original markdown\n\n![](attachments/img.png) Typed.");
    await host.dispose();
  });

  it("puts each image of a paste before a switch to the Markdown view where it was pasted, until the user edits there", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const paste = host.aimPaste("tab-1")!;
    await host.setLayout("markdown");

    expect(await host.insertDropped(paste, "![](a.png)")).toBe(true);
    expect(await host.insertDropped(paste, "![](b.png)")).toBe(true);

    // The second image goes in at its place too. Without the mirror after
    // the first image's source change, the Markdown pane's report of that
    // change would leave the hidden document pane behind the text, and the
    // second image would go in at the Markdown pane's caret.
    expect(fakeEditors.rawInsertedAt).toBeNull();
    expect(fakeEditors.rawEdit).toEqual({ from: 29, to: 29, insert: "\n\n![](b.png)", assoc: -1 });
    expect(store.get().doc.markdown).toBe("original markdown\n\n![](a.png)\n\n![](b.png)");
    // An edit in the Markdown view leaves the document pane behind.
    fakeEditors.rawChange!(`${fakeEditors.rawText} Typed.`);
    expect(await host.insertDropped(paste, "![](c.png)")).toBe(true);
    expect(fakeEditors.rawInsertedAt).toEqual({ pos: 0, newBlock: true });
    host.releaseDrop(paste);
    await host.dispose();
  });

  it("has the hidden document pane report an image pasted before a switch to the Markdown view at once when the source has no place for it", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const paste = host.aimPaste("tab-1")!;
    await host.setLayout("markdown");
    fakeEditors.findsSource = false;

    expect(await host.insertDropped(paste, "![](attachments/img.png)")).toBe(true);
    host.releaseDrop(paste);
    // Typing right after the image went in.
    fakeEditors.rawChange!(`${fakeEditors.rawText} Typed.`);

    // A report after typing paused would come once the typing left the
    // document pane behind, and be dropped with the image.
    expect(store.get().doc.markdown).toBe("document pane's form\n\n![](attachments/img.png) Typed.");
    await host.dispose();
  });

  it("aims no paste at a tab whose document pane is not shown", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    host.initLayout("markdown");
    await host.reloadActiveDoc();

    expect(host.aimPaste("tab-1")).toBeNull();
    expect(host.aimPaste("tab-2")).toBeNull();
    expect(store.get().tabs[0]!.filesPending).toBeFalsy();
    await host.dispose();
  });
});

describe("EditorHost file drops", () => {
  it("aims a drop on the page around the document, and puts one elsewhere in the window at the caret", async () => {
    const page = document.createElement("div");
    const root = document.createElement("div");
    const toolbar = document.createElement("div");
    page.append(root);
    document.body.append(toolbar, page);
    const host = new EditorHost(root, makeStore());
    await host.reloadActiveDoc();

    const onToolbar = host.aimDrop({ clientX: 300, clientY: 20, target: toolbar })!;
    expect(fakeEditors.droppedAt).toBeNull();
    await host.insertDropped(onToolbar, "[a.csv](attachments/a.csv)");
    expect(fakeEditors.insertedAt).toBeNull();
    host.releaseDrop(onToolbar);

    const onPage = host.aimDrop({ clientX: 300, clientY: 600, target: page })!;
    expect(fakeEditors.droppedAt).toEqual([300, 600]);
    await host.insertDropped(onPage, "[b.csv](attachments/b.csv)");
    expect(fakeEditors.insertedAt).toEqual({ pos: 7 });
    // The editor stops keeping the target once the drop ends.
    host.releaseDrop(onPage);
    expect(fakeEditors.heldTargets.size).toBe(0);
    page.remove();
    toolbar.remove();
    await host.dispose();
  });

  it.each([
    ["document", "document"],
    ["Markdown view", "markdown"],
  ] as const)("puts each later file of a drop away from the text in the %s after the one before, for a user who has moved on", async (_view, layout) => {
    const root = document.createElement("div");
    const toolbar = document.createElement("div");
    document.body.append(toolbar, root);
    const host = new EditorHost(root, makeStore());
    host.initLayout(layout);
    await host.reloadActiveDoc();
    const inserted = () => (layout === "document" ? fakeEditors.insertedAt : fakeEditors.rawInsertedAt);

    const drop = host.aimDrop({ clientX: 300, clientY: 20, target: toolbar })!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A key while the first file is read, so the caret stays before the files.
    toolbar.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift" }));
    await host.insertDropped(drop, "[a.csv](attachments/a.csv)");
    expect(inserted()).toBeNull();
    expect(fakeEditors.movedCaret).toBe(false);
    const afterFirst = layout === "document" ? [...fakeEditors.heldTargets][0] : { pos: fakeEditors.rawText!.length };
    await host.insertDropped(drop, "[b.csv](attachments/b.csv)");

    // At the caret, the second file would go in before the first.
    expect(inserted()).toEqual(afterFirst);
    host.releaseDrop(drop);
    expect(fakeEditors.heldTargets.size).toBe(0);
    root.remove();
    toolbar.remove();
    await host.dispose();
  });

  it("focuses the document text for a drop on it, not the find card's match in the frontmatter table", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const host = new EditorHost(root, makeStore());
    await host.reloadActiveDoc();
    const line = root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("p"));

    const drop = host.aimDrop({ clientX: 40, clientY: 120, target: line })!;
    expect(document.activeElement).not.toBeInstanceOf(HTMLTextAreaElement);
    await host.insertDropped(drop, "[a.csv](attachments/a.csv)");

    expect(document.activeElement).toBeInstanceOf(HTMLTextAreaElement);
    root.remove();
    await host.dispose();
  });

  /** Show the first tab again, as a click on it does. */
  async function showFirstTab(store: Store, host: EditorHost): Promise<void> {
    store.activateTab("tab-1");
    await host.showActiveDoc();
  }

  /** Open a second document in its own tab, which comes to the front. */
  async function openSecondTab(store: Store, host: EditorHost): Promise<void> {
    store.addTab({ ...store.get().doc, markdown: "other markdown", savedMarkdown: "other markdown" });
    await host.reloadActiveDoc();
  }

  /** Whether a promise has settled, after pending callbacks ran. */
  async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    void promise.then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return done;
  }

  it("leaves focus and the caret where the user went while the file was read", async () => {
    const root = document.createElement("div");
    const find = document.createElement("input");
    document.body.append(root, find);
    const host = new EditorHost(root, makeStore());
    await host.reloadActiveDoc();
    const line = root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("p"));

    const drop = host.aimDrop({ clientX: 40, clientY: 120, target: line })!;
    // Such as the find card, where the next keys would go into the document.
    find.focus();
    await host.insertDropped(drop, "[a.csv](attachments/a.csv)");

    expect(document.activeElement).toBe(find);
    expect(fakeEditors.insertedAt).toEqual({ pos: 7 });
    expect(fakeEditors.movedCaret).toBe(false);
    root.remove();
    find.remove();
    await host.dispose();
  });

  it("puts the caret after the last of the files dropped on the document while focus was in the find card", async () => {
    const root = document.createElement("div");
    const find = document.createElement("input");
    document.body.append(root, find);
    const host = new EditorHost(root, makeStore());
    await host.reloadActiveDoc();
    const line = root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("p"));
    find.focus();

    const drop = host.aimDrop({ clientX: 40, clientY: 120, target: line })!;
    await host.insertDropped(drop, "![](a.png)");
    // The document took focus with the first file, not the user.
    expect(document.activeElement).toBeInstanceOf(HTMLTextAreaElement);
    await host.insertDropped(drop, "[b.csv](attachments/b.csv)");

    expect(fakeEditors.movedCaret).toBe(true);
    expect(document.activeElement).toBeInstanceOf(HTMLTextAreaElement);
    root.remove();
    find.remove();
    await host.dispose();
  });

  it("leaves focus and the caret alone when the user pressed a key or clicked since the drop", async () => {
    const root = document.createElement("div");
    const find = document.createElement("input");
    document.body.append(root, find);
    const host = new EditorHost(root, makeStore());
    await host.reloadActiveDoc();
    const line = root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("p"));
    find.focus();

    for (const input of [new KeyboardEvent("keydown", { key: "S" }), new Event("pointerdown")]) {
      const drop = host.aimDrop({ clientX: 40, clientY: 120, target: line })!;
      await new Promise((resolve) => setTimeout(resolve, 5));
      find.dispatchEvent(input);
      await host.insertDropped(drop, "[a.csv](attachments/a.csv)");
      host.releaseDrop(drop);

      expect(document.activeElement).toBe(find);
      expect(fakeEditors.movedCaret).toBe(false);
    }
    root.remove();
    find.remove();
    await host.dispose();
  });

  it("puts the caret after a file dropped on the document right after typing there, but leaves a Markdown pane's caret", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const typeIn = (element: HTMLElement) => {
      element.focus();
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "x" }));
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "x" }));
    };

    // The document pane puts the file at a block edge, away from the typing.
    const text = root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("textarea"));
    typeIn(text);
    const onDocument = host.aimDrop({ clientX: 40, clientY: 120, target: text })!;
    await host.insertDropped(onDocument, "[a.csv](attachments/a.csv)");
    expect(fakeEditors.movedCaret).toBe(true);
    host.releaseDrop(onDocument);

    // A Markdown pane puts it into a line, where typing would go on after it.
    await host.setLayout("markdown");
    const line = root.querySelector(".editor-pane-raw")!.appendChild(document.createElement("textarea"));
    typeIn(line);
    await host.insertDropped(host.aimDrop({ clientX: 40, clientY: 20, target: line })!, "[b.csv](attachments/b.csv)");
    expect(fakeEditors.movedCaret).toBe(false);
    expect(document.activeElement).toBe(line);
    root.remove();
    await host.dispose();
  });

  it("puts the caret after a file dropped on a Markdown pane right after a key there that typed nothing", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const host = new EditorHost(root, makeStore());
    host.initLayout("markdown");
    await host.reloadActiveDoc();
    const line = root.querySelector(".editor-pane-raw")!.appendChild(document.createElement("textarea"));
    line.focus();
    // Such as Shift+End, which selects to the end of the line.
    line.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End", shiftKey: true }));

    await host.insertDropped(host.aimDrop({ clientX: 40, clientY: 20, target: line })!, "[a.csv](attachments/a.csv)");

    expect(fakeEditors.movedCaret).toBe(true);
    root.remove();
    await host.dispose();
  });

  it("puts a file dropped on a document now behind another tab where it was dropped once that document is shown", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const first = root.querySelector<HTMLElement>(".editor-pane-wysiwyg")!;
    const line = first.appendChild(document.createElement("p"));
    const drop = host.aimDrop({ clientX: 40, clientY: 120, target: line })!;
    await openSecondTab(store, host);

    const inserted = host.insertDropped(drop, "[a.csv](attachments/a.csv)");
    expect(await settled(inserted)).toBe(false);
    expect(fakeEditors.insertedInto).toBeNull();
    await showFirstTab(store, host);

    expect(await inserted).toBe(true);
    expect(fakeEditors.insertedInto).toBe(first);
    expect(fakeEditors.insertedAt).toEqual({ pos: 7 });
    await host.dispose();
  });

  it.each([
    ["pasted", (host: EditorHost) => host.aimPaste("tab-1")!],
    ["dropped", (host: EditorHost, root: HTMLElement) => host.aimDrop({ clientX: 40, clientY: 120, target: root.querySelector(".editor-pane-wysiwyg") })!],
  ])("puts the image of a later drop or paste into a document in after those %s there before it, even when it is stored first", async (_kind, aim) => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const first = aim(host, root);
    const second = aim(host, root);
    const inserted: string[] = [];
    const insert = (drop: ReturnType<typeof aim>, markdown: string) =>
      host.insertDropped(drop, markdown).then((ok) => {
        inserted.push(markdown);
        host.releaseDrop(drop);
        return ok;
      });

    // The second image is stored first.
    const later = insert(second, "![](b.png)");
    expect(await settled(later)).toBe(false);
    expect(fakeEditors.insertedInto).toBeNull();
    expect(await insert(first, "![](a.png)")).toBe(true);

    expect(await later).toBe(true);
    expect(inserted).toEqual(["![](a.png)", "![](b.png)"]);
    expect(store.get().tabs[0]!.filesPending).toBe(false);
    await host.dispose();
  });

  it("puts the file of a later drop away from the text after the file an earlier one put in at the caret, while they are under way together", async () => {
    const root = document.createElement("div");
    const host = new EditorHost(root, makeStore());
    await host.reloadActiveDoc();
    const first = host.aimDrop()!;
    const second = host.aimDrop()!;

    expect(await host.insertDropped(first, "![](a.png)")).toBe(true);
    expect(fakeEditors.insertedAt).toBeNull();
    const afterFirst = [...fakeEditors.heldTargets].at(-1)!;
    host.releaseDrop(first);
    // The caret is still before the first file.
    expect(await host.insertDropped(second, "![](b.png)")).toBe(true);
    expect(fakeEditors.insertedAt).toBe(afterFirst);
    host.releaseDrop(second);
    expect(fakeEditors.heldTargets.has(afterFirst)).toBe(false);

    // A drop made once those have ended goes in at the caret.
    const third = host.aimDrop()!;
    expect(await host.insertDropped(third, "![](c.png)")).toBe(true);
    expect(fakeEditors.insertedAt).toBeNull();
    host.releaseDrop(third);
    await host.dispose();
  });

  it("puts the images of a later paste after those an earlier paste put in at the Markdown view's caret once their place was gone", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const first = host.aimPaste("tab-1")!;
    const second = host.aimPaste("tab-1")!;
    await host.setLayout("markdown");
    // An edit in the Markdown view leaves the document pane behind.
    fakeEditors.rawChange!(`${fakeEditors.rawText} Typed.`);

    expect(await host.insertDropped(first, "![](a.png)")).toBe(true);
    const atCaret = fakeEditors.rawInsertedAt;
    expect(atCaret).toEqual({ pos: 0, newBlock: true });
    host.releaseDrop(first);
    expect(await host.insertDropped(second, "![](b.png)")).toBe(true);
    expect(fakeEditors.rawInsertedAt).toBe(atCaret);
    host.releaseDrop(second);
    await host.dispose();
  });

  it("lets a later drop's file go nowhere once the host is disposed while an earlier drop of its document is under way", async () => {
    const root = document.createElement("div");
    const host = new EditorHost(root, makeStore());
    await host.reloadActiveDoc();
    host.aimDrop();
    const later = host.insertDropped(host.aimDrop()!, "[b.csv](attachments/b.csv)");
    expect(await settled(later)).toBe(false);

    await host.dispose();
    expect(await later).toBe(false);
  });

  it("records that files are on their way into a document from its first drop until its last drop ends", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const pending = () => store.get().tabs.find((tab) => tab.id === "tab-1")?.filesPending ?? false;
    expect(pending()).toBe(false);

    const first = host.aimDrop()!;
    const second = host.aimDrop()!;
    // Opening a file must not put another document in this tab meanwhile.
    expect(pending()).toBe(true);
    host.releaseDrop(first);
    expect(pending()).toBe(true);
    host.releaseDrop(second);
    expect(pending()).toBe(false);
    await host.dispose();
  });

  it("counts a background document a file waits for as unsaved, even after a save of it completes", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const line = root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("p"));
    const drop = host.aimDrop({ clientX: 40, clientY: 120, target: line })!;
    await openSecondTab(store, host);
    const tab = (id: string) => store.get().tabs.find((t) => t.id === id)!;

    const inserted = host.insertDropped(drop, "[a.csv](attachments/a.csv)");
    expect(await settled(inserted)).toBe(false);
    // A save that started before the drop marks the text saved.
    store.patchDocById("tab-1", { isDirty: false });

    // Closing the document or the window right now asks before the file is lost.
    expect(hasUnsavedChanges(tab("tab-1"))).toBe(true);
    expect(hasUnsavedChanges(tab(store.get().activeTabId!))).toBe(false);
    await showFirstTab(store, host);
    expect(await inserted).toBe(true);
    host.releaseDrop(drop);
    expect(tab("tab-1").filesPending).toBe(false);
    await host.dispose();
  });

  it("keeps a background document's newer edit when a file dropped on its stale Markdown pane is read", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("markdown");
    await host.reloadActiveDoc();
    const line = root.querySelector(".editor-pane-raw")!.appendChild(document.createElement("div"));
    const drop = host.aimDrop({ clientX: 40, clientY: 20, target: line })!;
    // While the file is read, the document view edits the same document,
    // which leaves the hidden Markdown pane behind, and another tab opens.
    await host.setLayout("document");
    fakeEditors.wysiwygChange!("typed in the document");
    await openSecondTab(store, host);

    const inserted = host.insertDropped(drop, "[a.csv](attachments/a.csv)");
    expect(await settled(inserted)).toBe(false);
    expect(store.get().tabs[0]!.doc.markdown).toBe("typed in the document");
    await showFirstTab(store, host);

    expect(await inserted).toBe(true);
    // At the caret of the document view, the pane being edited.
    expect(fakeEditors.rawInsertedAt).toBeNull();
    expect(fakeEditors.insertedInto).toBe(root.querySelector(".editor-pane-wysiwyg:not([hidden])"));
    expect(fakeEditors.insertedAt).toBeNull();
    await host.dispose();
  });

  it("puts a file dropped on a background document's stale document pane into the pane shown later", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const line = root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("p"));
    const drop = host.aimDrop({ clientX: 40, clientY: 120, target: line })!;
    // The Markdown view edits the document, which leaves the hidden document
    // pane behind, and another tab opens.
    await host.setLayout("markdown");
    fakeEditors.rawChange!("typed in Markdown");
    await openSecondTab(store, host);

    const inserted = host.insertDropped(drop, "[a.csv](attachments/a.csv)");
    expect(await settled(inserted)).toBe(false);
    // The stale pane's report would be dropped, and the file lost with it.
    expect(fakeEditors.insertedInto).toBeNull();
    await showFirstTab(store, host);

    expect(await inserted).toBe(true);
    // At the caret of the Markdown view, the pane being edited, as a
    // paragraph of its own, so it never joins a line or a heading there.
    expect(fakeEditors.insertedInto).toBeNull();
    expect(fakeEditors.rawInsertedAt).toEqual({ pos: 0, newBlock: true });
    await host.dispose();
  });

  it("puts a file dropped on a document whose editor was dropped from memory at its caret once it is shown", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    store.set({ settings: { ...DEFAULT_SETTINGS, maxRetainedTabEditors: 1 } });
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const line = root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("p"));
    const drop = host.aimDrop({ clientX: 40, clientY: 120, target: line })!;
    await openSecondTab(store, host);

    const inserted = host.insertDropped(drop, "[a.csv](attachments/a.csv)");
    expect(await settled(inserted)).toBe(false);
    await showFirstTab(store, host);

    expect(await inserted).toBe(true);
    expect(fakeEditors.insertedInto).toBe(root.querySelector(".editor-pane-wysiwyg:not([hidden])"));
    expect(fakeEditors.insertedAt).toBeNull();
    await host.dispose();
  });

  it("holds a file that its untitled document must be saved for until that document is in front, as unsaved", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const drop = host.aimDrop()!;
    await openSecondTab(store, host);

    const inFront = host.untilInFront(drop);
    expect(await settled(inFront)).toBe(false);
    expect(hasUnsavedChanges(store.get().tabs[0]!)).toBe(true);
    await showFirstTab(store, host);
    expect(await inFront).toBe(true);
    // A save the user cancels then ends the drop, which leaves the untouched
    // document clean.
    host.releaseDrop(drop);
    expect(hasUnsavedChanges(store.get().tabs[0]!)).toBe(false);

    // Once the document is closed, it is never in front.
    const later = host.aimDrop()!;
    await openSecondTab(store, host);
    const closed = host.untilInFront(later);
    expect(await settled(closed)).toBe(false);
    store.closeTab("tab-1");
    await host.discardTab("tab-1");
    expect(await closed).toBe(false);
    await host.dispose();
  });

  it("puts nothing anywhere when the document a file waits for is closed", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const drop = host.aimDrop()!;
    await openSecondTab(store, host);
    const inserted = host.insertDropped(drop, "[a.csv](attachments/a.csv)");
    expect(await settled(inserted)).toBe(false);

    store.closeTab("tab-1");
    await host.discardTab("tab-1");

    expect(await inserted).toBe(false);
    expect(fakeEditors.insertedInto).toBeNull();
    await host.dispose();
  });

  it("puts a file dropped on a document pane that a layout switch hid in at its drop point, through the Markdown pane shown now", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("split");
    await host.reloadActiveDoc();
    const line = root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("p"));
    const drop = host.aimDrop({ clientX: 40, clientY: 120, target: line })!;
    await host.setLayout("markdown");

    expect(await host.insertDropped(drop, "[a.csv](attachments/a.csv)")).toBe(true);
    fakeEditors.rawChange!(`${fakeEditors.rawText} Typed.`);

    expect(fakeEditors.insertedAt).toEqual({ pos: 7 });
    expect(store.get().doc.markdown).toBe("original markdown\n\n[a.csv](attachments/a.csv) Typed.");
    await host.dispose();
  });

  it("puts a file dropped on a Markdown pane that a layout switch hid in at its drop point, and the document pane shown takes it", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("split");
    await host.reloadActiveDoc();
    const line = root.querySelector(".editor-pane-raw")!.appendChild(document.createElement("div"));
    const drop = host.aimDrop({ clientX: 40, clientY: 20, target: line })!;
    await host.setLayout("document");

    expect(await host.insertDropped(drop, "[a.csv](attachments/a.csv)")).toBe(true);
    fakeEditors.wysiwygChange!("typed in the document");

    expect(fakeEditors.rawInsertedAt).toEqual({ pos: 3 });
    expect(fakeEditors.mirrored).toBe("original markdown[a.csv](attachments/a.csv)");
    // The document pane holds the file, so its next edit counts.
    expect(store.get().doc.markdown).toBe("typed in the document");
    await host.dispose();
  });

  it("puts nothing in another document once the one a file was dropped on is closed", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const drop = host.aimDrop()!;
    store.addTab({ ...store.get().doc, markdown: "other markdown", savedMarkdown: "other markdown" });
    await host.reloadActiveDoc();
    store.closeTab("tab-1");
    await host.discardTab("tab-1");

    expect(await host.insertDropped(drop, "[a.csv](attachments/a.csv)")).toBe(false);

    expect(fakeEditors.insertedInto).toBeNull();
    await host.dispose();
  });

  it("puts a file at the caret of the document it was dropped on once that document is reloaded", async () => {
    const root = document.createElement("div");
    const host = new EditorHost(root, makeStore());
    await host.reloadActiveDoc();
    const line = root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("p"));
    const drop = host.aimDrop({ clientX: 40, clientY: 120, target: line })!;
    // Reload from disk builds a new editor, which has no place for the old target.
    await host.reloadActiveDoc();

    expect(await host.insertDropped(drop, "[a.csv](attachments/a.csv)")).toBe(true);

    expect(fakeEditors.insertedInto).toBe(root.querySelector(".editor-pane-wysiwyg"));
    expect(fakeEditors.insertedAt).toBeNull();
    await host.dispose();
  });
});

describe("EditorHost flush", () => {
  it("reports typing the visible document pane has not announced yet", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    await host.reloadActiveDoc();
    fakeEditors.markdown = "original markdown, typed just now";
    fakeEditors.pending = true;

    host.flush();

    expect(store.get().doc).toMatchObject({ markdown: "original markdown, typed just now", isDirty: true });
    await host.dispose();
  });

  it("mirrors a document edit into the split's Markdown pane at once", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    host.initLayout("split");
    await host.reloadActiveDoc();
    fakeEditors.markdown = "original markdown, typed just now";
    fakeEditors.pending = true;

    host.flush();

    expect(fakeEditors.rawText).toBe("original markdown, typed just now");
    await host.dispose();
  });

  it("mirrors a Markdown edit into the split's document pane at once, so its next edit counts", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    host.initLayout("split");
    await host.reloadActiveDoc();
    fakeEditors.rawChange!("newer Markdown text");

    host.flush();

    // The document pane is behind, so it must not report; the mirror updates it.
    expect(fakeEditors.reportCalls).toBe(0);
    expect(fakeEditors.mirrored).toBe("newer Markdown text");
    fakeEditors.wysiwygChange!("newer Markdown text, then the document");
    expect(store.get().doc.markdown).toBe("newer Markdown text, then the document");
    await host.dispose();
  });

  it("never writes a pane's own form of the text back", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    await host.reloadActiveDoc();

    // The document pane serializes differently, with no edit to report.
    host.flush();

    expect(store.get().doc).toMatchObject({ markdown: "original markdown", isDirty: false });
    await host.dispose();
  });

  it("gives the Markdown view a change the hidden document pane reports, so typing there afterwards counts", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    await host.reloadActiveDoc();
    await host.setLayout("markdown");

    // An image the upload input or Replace image stored lands in the hidden pane.
    fakeEditors.wysiwygChange!("original markdown\n\n![](attachments/img.png)\n");
    fakeEditors.rawChange!(`${fakeEditors.rawText}Typed.`);

    expect(store.get().doc.markdown).toBe("original markdown\n\n![](attachments/img.png)\nTyped.");
    await host.dispose();
  });

  it("leaves a hidden document pane alone", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    await host.reloadActiveDoc();
    await host.setLayout("markdown");
    fakeEditors.markdown = "older document text";
    fakeEditors.pending = true;

    host.flush();

    expect(fakeEditors.pending).toBe(true);
    expect(store.get().doc.markdown).toBe("original markdown");
    await host.dispose();
  });

  it("drops a delayed document report made stale by a newer Markdown edit", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    host.initLayout("split");
    await host.reloadActiveDoc();
    fakeEditors.rawChange!("newer Markdown text");

    // The document pane's report for typing from before that edit lands late.
    fakeEditors.wysiwygChange!("older document text");

    expect(store.get().doc.markdown).toBe("newer Markdown text");
    await host.dispose();
  });
});

describe("EditorHost split catch-up", () => {
  /** Open the store's document in the split, keeping the root to find its panes. */
  async function openSplit(): Promise<{ root: HTMLElement; store: Store; host: EditorHost }> {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("split");
    await host.reloadActiveDoc();
    return { root, store, host };
  }

  it("gives a clicked Markdown pane the document pane's held-back typing first", async () => {
    const { root, store, host } = await openSplit();
    fakeEditors.markdown = "settled markdown, typed in the document";
    fakeEditors.pending = true;

    root.querySelector(".editor-pane-raw")!.dispatchEvent(new Event("pointerdown"));

    expect(fakeEditors.rawText).toBe("settled markdown, typed in the document");
    fakeEditors.rawChange!("settled markdown, typed in the document, then Markdown");
    expect(store.get().doc.markdown).toBe("settled markdown, typed in the document, then Markdown");
    await host.dispose();
  });

  it("gives the document pane a Markdown edit when focus moves into it", async () => {
    const { root, store, host } = await openSplit();
    fakeEditors.rawChange!("newer Markdown text");

    root.querySelector(".editor-pane-wysiwyg")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(fakeEditors.mirrored).toBe("newer Markdown text");
    fakeEditors.wysiwygChange!("newer Markdown text, then the document");
    expect(store.get().doc.markdown).toBe("newer Markdown text, then the document");
    await host.dispose();
  });

  it("catches up before a control in the pane stops the click", async () => {
    const { root, host } = await openSplit();
    fakeEditors.rawChange!("newer Markdown text");
    // Like a task checkbox or table button that acts on pointerdown.
    const control = document.createElement("button");
    control.addEventListener("pointerdown", (event) => event.stopPropagation());
    root.querySelector(".editor-pane-wysiwyg")!.appendChild(control);

    control.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    expect(fakeEditors.mirrored).toBe("newer Markdown text");
    await host.dispose();
  });

  it("puts a file dropped on the Markdown pane while it has focus at the drop point, as written", async () => {
    const { root, store, host } = await openSplit();
    document.body.append(root);
    const caret = document.createElement("textarea");
    root.querySelector(".editor-pane-raw")!.append(caret);
    caret.focus();
    fakeEditors.rawText = "Markdown text, typed";
    fakeEditors.rawChange!(fakeEditors.rawText);

    const drop = host.aimDrop({ clientX: 600, clientY: 40, target: caret })!;
    await host.insertDropped(drop, "[notes.csv](attachments/notes.csv)");

    // The document pane would report its own form of the whole text.
    expect(store.get().doc.markdown).toBe("Markdown text, typed[notes.csv](attachments/notes.csv)");
    expect(fakeEditors.mirrored).toBe("Markdown text, typed[notes.csv](attachments/notes.csv)");
    expect(fakeEditors.droppedAt).toBeNull();
    expect(fakeEditors.rawDroppedAt).toEqual([600, 40]);
    expect(fakeEditors.rawInsertedAt).toEqual({ pos: 3 });
    expect(document.activeElement).toBe(caret);
    root.remove();
    await host.dispose();
  });

  it("puts a file dropped on the document pane into the Markdown pane as written, at once, while that has focus", async () => {
    const { root, store, host } = await openSplit();
    document.body.append(root);
    const caret = root.querySelector(".editor-pane-raw")!.appendChild(document.createElement("textarea"));
    caret.focus();
    const line = root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("p"));
    caret.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    fakeEditors.rawText = "* Typed as written ";
    fakeEditors.rawChange!(fakeEditors.rawText);

    const drop = host.aimDrop({ clientX: 40, clientY: 120, target: line })!;
    await host.insertDropped(drop, "[notes.csv](attachments/notes.csv)");

    expect(fakeEditors.droppedAt).toEqual([40, 120]);
    expect(fakeEditors.insertedAt).toEqual({ pos: 7 });
    // The document pane's form of the whole text would rewrite what the user typed.
    expect(fakeEditors.rawEdit).toEqual({ from: 19, to: 19, insert: "\n\n[notes.csv](attachments/notes.csv)", assoc: -1 });
    expect(store.get().doc.markdown).toBe("* Typed as written \n\n[notes.csv](attachments/notes.csv)");
    expect(fakeEditors.mirrored).toBe("* Typed as written \n\n[notes.csv](attachments/notes.csv)");
    expect(document.activeElement).toBe(caret);
    root.remove();
    await host.dispose();
  });

  it("keeps focus in the Markdown pane when a file dropped on the document pane goes in there", async () => {
    const { root, host } = await openSplit();
    document.body.append(root);
    const caret = root.querySelector(".editor-pane-raw")!.appendChild(document.createElement("textarea"));
    caret.focus();
    const line = root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("p"));

    // Without typing first, and when the source edit cannot be found.
    fakeEditors.findsSource = false;
    const drop = host.aimDrop({ clientX: 40, clientY: 120, target: line })!;
    await host.insertDropped(drop, "[notes.csv](attachments/notes.csv)");

    expect(fakeEditors.insertedAt).toEqual({ pos: 7 });
    // The document pane's own report then brings the Markdown pane up to date.
    expect(fakeEditors.rawText).toBe("document pane's form\n\n[notes.csv](attachments/notes.csv)");
    expect(document.activeElement).toBe(caret);
    root.remove();
    await host.dispose();
  });

  it("puts a file dropped on the Markdown pane there while the document pane has focus", async () => {
    const { root, store, host } = await openSplit();
    document.body.append(root);
    root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("textarea")).focus();
    const line = root.querySelector(".editor-pane-raw")!.appendChild(document.createElement("div"));

    const drop = host.aimDrop({ clientX: 600, clientY: 40, target: line })!;
    await host.insertDropped(drop, "[notes.csv](attachments/notes.csv)");

    expect(fakeEditors.insertedInto).toBeNull();
    expect(fakeEditors.rawInsertedAt).toEqual({ pos: 3 });
    expect(store.get().doc.markdown).toBe("original markdown[notes.csv](attachments/notes.csv)");
    // The Markdown pane takes focus, as after a drop on the document pane.
    expect(root.querySelector(".editor-pane-raw")!.contains(document.activeElement)).toBe(true);
    root.remove();
    await host.dispose();
  });

  it.each([
    ["", false],
    [", right after typing there", true],
  ])("puts the caret after the last of the files dropped on the Markdown pane while the document pane has focus%s", async (_when, typed) => {
    const { root, host } = await openSplit();
    document.body.append(root);
    const text = root.querySelector(".editor-pane-wysiwyg")!.appendChild(document.createElement("textarea"));
    text.focus();
    if (typed) {
      text.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "x" }));
      text.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "x" }));
    }
    const line = root.querySelector(".editor-pane-raw")!.appendChild(document.createElement("div"));

    const drop = host.aimDrop({ clientX: 600, clientY: 40, target: line })!;
    await host.insertDropped(drop, "![](a.png)");
    await host.insertDropped(drop, "[b.csv](attachments/b.csv)");

    // The Markdown pane took focus with the first file, not the user.
    expect(fakeEditors.movedCaret).toBe(true);
    expect(root.querySelector(".editor-pane-raw")!.contains(document.activeElement)).toBe(true);
    root.remove();
    await host.dispose();
  });

  it("drops a file into a document pane that holds the latest Markdown edit", async () => {
    const { store, host } = await openSplit();
    fakeEditors.rawChange!("newer Markdown text");

    await host.insertDropped(host.aimDrop()!, "![](image.png)");

    expect(store.get().doc.markdown).toBe("newer Markdown text\n\n![](image.png)");
    expect(fakeEditors.rawText).toBe("newer Markdown text\n\n![](image.png)");
    await host.dispose();
  });

  it("has the document pane decide a typed closing mark unless it takes the click itself or autosave asks", async () => {
    const { root, host } = await openSplit();

    root.querySelector(".editor-pane-raw")!.dispatchEvent(new Event("pointerdown"));
    root.querySelector(".editor-pane-wysiwyg")!.dispatchEvent(new Event("pointerdown"));
    host.flush();
    host.flush({ keepTypedMark: true });

    // A click there may land inside the text the mark closes.
    expect(fakeEditors.keptTypedMarks).toEqual([false, true, false, true]);
    await host.dispose();
  });

  it("leaves a saved document saved when the panes take a click or focus", async () => {
    const { root, store, host } = await openSplit();
    const before = { markdown: store.get().doc.markdown, raw: fakeEditors.rawText };
    // The document pane serializes differently now, with no edit to report.
    fakeEditors.markdown = `${before.markdown}, written another way`;

    for (const pane of root.querySelectorAll(".editor-pane")) {
      pane.dispatchEvent(new Event("pointerdown"));
      pane.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    }

    expect(store.get().doc).toMatchObject({ markdown: before.markdown, isDirty: false });
    expect(fakeEditors.rawText).toBe(before.raw);
    await host.dispose();
  });
});
