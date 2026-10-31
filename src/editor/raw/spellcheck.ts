import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";

const codeSpan = Decoration.mark({ attributes: { spellcheck: "false" } });
const codeLine = Decoration.line({ attributes: { spellcheck: "false" } });

/** Exclude visible code using the same Markdown parse that supplies colours.
 *  Block lines also cover empty lines where the next keystroke is still code.
 *  Limit work to the viewport, including when a fence spans a large file. */
function codeExclusions(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const { from: start, to: end } = view.viewport;
  const { doc } = view.state;
  syntaxTree(view.state).iterate({
    from: start,
    to: end,
    enter(node) {
      if (node.name === "InlineCode") {
        const from = Math.max(start, node.from);
        const to = Math.min(end, node.to);
        if (from < to) ranges.push(codeSpan.range(from, to));
        return false;
      }
      if (node.name !== "FencedCode" && node.name !== "CodeBlock") return;
      const first = doc.lineAt(Math.max(start, node.from)).number;
      const last = doc.lineAt(Math.min(end, node.to)).number;
      for (let line = first; line <= last; line++) ranges.push(codeLine.range(doc.line(line).from));
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

/** Keep source code excluded after edits, scrolling and background parsing. */
export function sourceCodeSpellcheck(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = codeExclusions(view);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
          this.decorations = codeExclusions(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
