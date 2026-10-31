import type { Ctx } from "@milkdown/kit/ctx";
import { inlineCodeAttr } from "@milkdown/kit/preset/commonmark";
import type { Node } from "@milkdown/kit/prose/model";
import { Plugin } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** Set the inherited spelling preference for document prose and frontmatter.
 *  Code owns its exclusions through editor attributes. The Markdown pane
 *  applies the preference through RawEditor.setSpellcheck because CodeMirror
 *  supplies its own content attribute. */
export function applySpellcheck(root: HTMLElement, enabled: boolean): void {
  root.setAttribute("spellcheck", String(enabled));
}

/** Exclude inline code when Milkdown renders it, including newly typed spans. */
export function excludeInlineCodeSpellcheck(ctx: Ctx): void {
  ctx.update(inlineCodeAttr.key, (previous) => (mark) => ({ ...previous(mark), spellcheck: "false" }));
}

/** Exclude entire code blocks, including their offscreen placeholders. */
function codeBlocks(doc: Node): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code) decorations.push(Decoration.node(pos, pos + node.nodeSize, { spellcheck: "false" }));
    return !node.isTextblock;
  });
  return DecorationSet.create(doc, decorations);
}

/** Let ProseMirror maintain exclusions on Crepe's code block node views. */
export const excludeCodeBlockSpellcheck = $prose(() => {
  const plugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
    state: {
      init: (_, state) => codeBlocks(state.doc),
      apply: (transaction, previous) => transaction.docChanged ? codeBlocks(transaction.doc) : previous,
    },
    props: { decorations: (state) => plugin.getState(state) },
  });
  return plugin;
});
