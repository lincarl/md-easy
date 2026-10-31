// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";
import { applySpellcheck } from "./spellcheck";

// Report code blocks as visible so Crepe creates their real CodeMirror views.
type Report = (entries: Pick<IntersectionObserverEntry, "target" | "isIntersecting">[]) => void;
vi.stubGlobal("IntersectionObserver", class {
  constructor(private report: Report) {}
  observe(target: Element): void {
    setTimeout(() => this.report([{ target, isIntersecting: true }]));
  }
  unobserve(): void {}
  disconnect(): void {}
});
Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });

const editors: WysiwygEditor[] = [];

afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  document.body.replaceChildren();
});

/** Mount a real document editor under a host with spelling enabled. */
async function open(markdown: string, root = document.createElement("div")) {
  if (!root.isConnected) document.body.append(root);
  applySpellcheck(root, true);
  const editor = new WysiwygEditor();
  editors.push(editor);
  await editor.mount(root, markdown, { onChange: vi.fn() }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const view: EditorView = (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
  return { editor, root, view };
}

/** Read the nearest spelling attribute for document prose. */
function prosePreference(root: HTMLElement): string | null {
  return root.querySelector(".milkdown > .ProseMirror p")?.closest("[spellcheck]")?.getAttribute("spellcheck") ?? null;
}

/** Check the exclusions on inline spans and fully initialized fenced editors. */
async function expectCodeExcluded(root: HTMLElement): Promise<void> {
  expect(root.querySelector(".ProseMirror p code")?.getAttribute("spellcheck")).toBe("false");
  expect(root.querySelector(".milkdown-code-block")?.getAttribute("spellcheck")).toBe("false");
  await vi.waitFor(() => expect(root.querySelector(".milkdown-code-block .cm-content")?.getAttribute("spellcheck")).toBe("false"));
}

describe("Document spelling eligibility", () => {
  it("keeps prose enabled and code excluded through setting changes", { timeout: 60_000 }, async () => {
    const { root } = await open("Prose `inlineword`.\n\n```\nfencedword\n```\n");
    expect(prosePreference(root)).toBe("true");
    await expectCodeExcluded(root);
    applySpellcheck(root, false);
    expect(prosePreference(root)).toBe("false");
    await expectCodeExcluded(root);
    applySpellcheck(root, true);
    expect(prosePreference(root)).toBe("true");
    await expectCodeExcluded(root);
  });

  it("excludes code inserted by transactions and replaced from the source pane", { timeout: 60_000 }, async () => {
    const { editor, root, view } = await open("Prose inlineword.\n");
    const { schema } = view.state;
    const fenced = schema.nodes.code_block.create({ language: "text" }, schema.text("fencedword"));
    view.dispatch(view.state.tr.addMark(7, 17, schema.marks.inlineCode.create()).insert(view.state.doc.content.size, fenced));
    await expectCodeExcluded(root);
    expect(prosePreference(root)).toBe("true");

    applySpellcheck(root, false);
    editor.setMarkdown("Changed prose `newinline`.\n\n~~~\nnewfenced\n~~~\n");
    await expectCodeExcluded(root);
    expect(prosePreference(root)).toBe("false");
    applySpellcheck(root, true);
    await expectCodeExcluded(root);
    expect(prosePreference(root)).toBe("true");
  });
});
