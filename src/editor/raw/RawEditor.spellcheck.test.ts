// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { isolateHistory, undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { RawEditor } from "./RawEditor";

const editors: RawEditor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

/** Mount the actual Markdown editor and enable prose spelling. */
function open(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = new RawEditor();
  editor.mount(root, markdown, { onChange: vi.fn() });
  editors.push(editor);
  editor.setSpellcheck(true);
  const { view } = editor as unknown as { view: EditorView };
  return { editor, view };
}

/** Find the attribute that controls spelling for visible text in CodeMirror. */
function preference(view: EditorView, text: string): string | null {
  const walker = document.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(text)) return node.parentElement?.closest("[spellcheck]")?.getAttribute("spellcheck") ?? null;
  }
  throw new Error(`Text is not visible: ${text}`);
}

describe("Markdown spelling eligibility", () => {
  it("excludes parsed code while keeping surrounding prose and escaped backticks eligible", () => {
    const { view } = open([
      "Prose `inlinecode` and ``nested`code`` after.",
      "",
      "Escaped \\`plainword\\` and unmatched `unfinished.",
      "",
      "```text",
      "fencedword",
      "",
      "```",
      "",
      "~~~",
      "tildeword",
      "~~~",
      "",
      "    indentedword",
      "",
      "> ```",
      "> quotedword",
      "> ```",
      "",
      "Afterwards.",
    ].join("\n"));

    for (const word of ["Prose", "after", "plainword", "unfinished", "Afterwards"]) expect(preference(view, word)).toBe("true");
    for (const word of ["inlinecode", "nested", "fencedword", "tildeword", "indentedword", "quotedword"]) {
      expect(preference(view, word)).toBe("false");
    }
    expect([...view.contentDOM.querySelectorAll('.cm-line[spellcheck="false"]')].some((line) => !line.textContent)).toBe(true);
  });

  it("updates exclusions when inline delimiters are typed, deleted and undone", () => {
    const { view } = open("Prose inlineword after.");
    view.dispatch({ changes: [{ from: 6, insert: "`" }, { from: 16, insert: "`" }] });
    expect(preference(view, "inlineword")).toBe("false");
    expect(preference(view, "Prose")).toBe("true");

    view.dispatch({ changes: { from: 17, to: 18 }, annotations: isolateHistory.of("before") });
    expect(preference(view, "inlineword")).toBe("true");
    undo(view);
    expect(view.state.doc.toString()).toBe("Prose `inlineword` after.");
    expect(preference(view, "inlineword")).toBe("false");
  });

  it("keeps the setting and code exclusions across mirrored text and later edits", () => {
    const { editor, view } = open("Original prose.");
    editor.setSpellcheck(false);
    editor.setText("New prose `inlineword`.\n\n```\nfencedword\n```\n\nEnd prose.");
    expect(preference(view, "prose")).toBe("false");
    editor.setSpellcheck(true);
    expect(preference(view, "prose")).toBe("true");
    expect(preference(view, "inlineword")).toBe("false");
    expect(preference(view, "fencedword")).toBe("false");

    const at = view.state.doc.toString().indexOf("fencedword") + "fencedword".length;
    view.dispatch({ changes: { from: at, insert: "typed" } });
    expect(preference(view, "fencedwordtyped")).toBe("false");
    expect(view.contentDOM.getAttribute("spellcheck")).toBe("true");

    editor.setSpellcheck(false);
    view.dispatch({ changes: { from: view.state.doc.length, insert: " More." } });
    expect(preference(view, "More")).toBe("false");
    expect(preference(view, "fencedwordtyped")).toBe("false");
  });

  it("excludes a newly typed unclosed fence and restores prose when the fence is removed", () => {
    const { view } = open("First paragraph.\n\nlastword");
    const start = view.state.doc.toString().indexOf("lastword");
    view.dispatch({ changes: { from: start, insert: "```\n" } });
    expect(preference(view, "lastword")).toBe("false");
    expect(preference(view, "First")).toBe("true");
    view.dispatch({ changes: { from: start, to: start + 4 } });
    expect(preference(view, "lastword")).toBe("true");
  });
});
