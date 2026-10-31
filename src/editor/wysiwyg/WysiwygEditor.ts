// WYSIWYG view: a lifecycle wrapper around Milkdown's Crepe editor, treated as
// a *view* over the canonical markdown string (docs/design.md §4).
//
// Three responsibilities beyond hosting Crepe:
//   - Serializer style (§5.16): configure remark-stringify options from settings.
//   - Frontmatter (§5.17): a leading `---` YAML block is split off and projected
//     through a React-owned editable table above the editor; Crepe only sees the
//     body, and the block and the blank lines after it are written back
//     unchanged on serialize. Each change to them is a step in Crepe's undo
//     history (frontmatterHistory.ts), so undo takes back table and body edits
//     in one order.
//   - Exact source: every top-level block the user has not changed is written
//     as the text Crepe parsed, not Milkdown's rewrite of it. When that text
//     cannot be shown to read back as the document, the whole body is written
//     in Milkdown's form, as before (sourceBaseline.ts).

import { Crepe } from "@milkdown/crepe";
import { EditorStatus, remarkStringifyOptionsCtx, editorViewCtx, editorViewOptionsCtx, parserCtx, remarkCtx, schemaCtx, serializerCtx } from "@milkdown/kit/core";
import { blockConfig } from "@milkdown/kit/plugin/block";
import { indentPlugin } from "@milkdown/kit/plugin/indent";
import { ParserState } from "@milkdown/kit/transformer";
import { $prose } from "@milkdown/kit/utils";
import { Plugin, Selection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { closeHistory } from "@milkdown/kit/prose/history";
import { dropIndicatorPlugin } from "@milkdown/kit/plugin/cursor";
import type { EditorView } from "@milkdown/kit/prose/view";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

import type { SerializerStyle } from "../../state/types";
import { stringifyOptions } from "./serializer";
import { smartPastePlugin } from "./pasteHandler";
import { pasteMarkdownSource } from "./markdownPaste";
import { copyWithoutTrailingLine } from "./copyTrailingLine";
import { linkViewPlugin } from "./linkView";
import { shiftClicks } from "./shiftClicks";
import { listLabelClicks } from "./listLabelClicks";
import { paddingPresses } from "./paddingPresses";
import { blockHandle, blockEditConfig } from "./blockHandle";
import { renderMermaidPreview } from "./mermaid";
import { imageBlockFeatureConfig, missingImages, type ViewRef } from "./imageView";
import { imageBlockAltSchema, imageBlockAltView } from "./imageBlockAlt";
import { endPastAtoms } from "./lineEnd";
import { tightListItemJoin, tightListItemSchema } from "./tightListItems";
import { imageContextMenuPlugin } from "./imageContextMenu";
import { codeBlockMetaSchema } from "./codeBlockMeta";
import { tableCellClicks } from "./tableCellClicks";
import { codeBlockDrops, dropAtEdge, dropLine } from "./dropEdge";
import { preloadImages } from "./preloadImages";
import {
  searchMilkdownPlugin,
  type FindCounts,
  type FindOptions,
} from "./findEngine";
import { codeBlockFindHighlights } from "./findReveal";
import { codeBlockClicks } from "./codeBlockClicks";
import { codeBlockFocus } from "./codeBlockFocus";
import { findChangeListener } from "./findChanges";
import { DocumentFind } from "./documentFind";
import type { WysiwygContext } from "./context";
import { SourceBaseline, outlinePlugin, type MarkdownTools, type OutlineNode } from "./sourceBaseline";
import { baselineOf, baselineState, setBaseline, type BaselineSlot } from "./baselineHistory";
import { FrontmatterPanel, type FrontmatterFocus } from "./FrontmatterPanel";
import { FrontmatterDisclosure } from "./FrontmatterDisclosure";
import { changedCell, focusCaret, showsBlock } from "./frontmatterFind";
import { frontmatterOf, frontmatterState, handleTableHistory, setFrontmatter } from "./frontmatterHistory";
import { installEditorAccessibility, labelTaskBoxes } from "./editorAccessibility";
import { tabExit } from "./tabExit";
import { slashMenuBlur } from "./slashMenuBlur";
import { toolbarBlur } from "./toolbarBlur";
import { selectionToolbar } from "./selectionToolbar";
import { decidedDoc, decideTypedMark, mathDelimiters } from "./mathDelimiters";
import { linkEdges } from "./linkEdges";
import { excludeCodeBlockSpellcheck, excludeInlineCodeSpellcheck } from "./spellcheck";
import {
  blockEdge,
  dropPosition,
  insertAtSelection,
  insertBlocksAt,
  mirrorMarkdown,
  sourceEditBetween,
  type DropTarget,
  type SourceEdit,
} from "./fileDrop";

const NO_MATCHES: FindCounts = { total: 0, current: 0 };
/** How long typing must pause before an edit is reported (`onChange`). */
const CHANGE_DEBOUNCE_MS = 200;
/** A longer pause in typing starts a new undo step. This is ProseMirror
 *  history's default newGroupDelay, which Crepe keeps. */
const UNDO_GROUP_MS = 500;
import { splitFrontmatter, joinFrontmatter } from "../../document/frontmatter";

export interface WysiwygCallbacks {
  onChange: (markdown: string) => void;
  /** Called after an edit while a find query is set, so the find card can
   *  show the new count (§5.13). */
  onFindChange?: () => void;
  /** Called right before find scrolls the document to a match, which can be
   *  after the find step that asked for it has returned. */
  onFindScroll?: () => void;
}

export class WysiwygEditor {
  private crepe: Crepe | null = null;
  /** The in-flight Crepe create, if mount has not settled yet. Destruction waits
   *  for it before calling Crepe.destroy: create/destroy concurrently is not a
   *  supported lifecycle and can leave plugin views/listeners behind. */
  private createPromise: Promise<void> | null = null;
  /** Terminal, idempotent teardown. A pane can be torn down both by an in-flight
   *  host build noticing disposal and by the host's own disposal sweep. */
  private destroyPromise: Promise<void> | null = null;
  private destroyed = false;
  /** `mount` enables listener callbacks on the next task. Keep the timer so a
   *  teardown in that gap cannot turn updates back on afterwards. */
  private enableUpdatesTimer: ReturnType<typeof setTimeout> | null = null;
  private ignoreUpdates = true;
  /** The frontmatter block with both delimiters and, unless it ends the file,
   *  the newline after it. Null without frontmatter. The editor state holds it
   *  too, so undo can take its changes back (`frontmatterState`). This copy
   *  is the block the table shows, and after each update it equals the
   *  state's. */
  private frontmatterBlock: string | null = null;
  /** The blank lines between the frontmatter block and the body. Crepe never
   *  sees them, so they are kept here and written back as they were. The
   *  editor state holds them too, so undo of a mirror sync puts them back. */
  private frontmatterSeparator = "";
  /** Stable host element for the React-owned frontmatter table. */
  private fmPanel: HTMLElement | null = null;
  /** React root that owns all content inside `fmPanel`. */
  private fmPanelRoot: Root | null = null;
  /** Presentation state survives table redraws and retained tab/view switches. */
  private fmExpanded = false;
  private onChange: ((markdown: string) => void) | null = null;
  /** Told when the find matches may have changed without a find action. */
  private onFindChange: (() => void) | null = null;
  /** The mount root and Crepe's body container, kept so `setMarkdown` can add or
   *  remove the frontmatter panel above the editor when the source changes. */
  private root: HTMLElement | null = null;
  private crepeRoot: HTMLElement | null = null;
  /** Whether a frontmatter table should be shown (the showFrontmatterPanel
   *  setting, captured at mount). */
  private showFmPanel = false;
  /** The body Crepe last parsed (at mount or `setMarkdown`), or the source a
   *  split drop changed it to (`insertMarkdownWithSource`). `getMarkdown`
   *  writes each top-level block the user has not changed since as its exact
   *  source, and Milkdown's form only for the blocks they changed. It takes
   *  the baseline of the body the document came from from the editor state,
   *  where undo across a split mirror sync brings back the one before it
   *  (baselineHistory.ts), and this one when the state has none. */
  private baseline: SourceBaseline | null = null;
  /** Where the baseline of the body the editor opened with goes. */
  private opened: BaselineSlot = { baseline: null };
  /** The outline of the last text Crepe's parser read, which `rememberSource`
   *  hands to the baseline so the source is not parsed again. */
  private parsed: { text: string; outline: readonly OutlineNode[] | null } | null = null;
  /** The body of a split mirror that arrived before Crepe created its view, for
   *  example while preloadImages waits for image lookups. `mount` applies it. */
  private pendingBody: string | null = null;
  /** Pending report of document edits, set while typing has not paused yet. */
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Attributes/semantics applied to DOM owned by Crepe and embedded CodeMirror. */
  private accessibilityCleanup: (() => void) | null = null;
  /** Bumped when undo, redo or Replace rewrites the frontmatter, so React draws
   *  a new table instead of patching cells the user has typed into. */
  private fmTableKey = 0;
  /** The cell the last keystroke in the table went to, its undo run, the
   *  editor state it left, its time and the input method composition it was
   *  part of. The next keystroke joins that run while all of them still hold,
   *  or while it is part of the same composition. */
  private typing: {
    cell: Element;
    run: string;
    state: EditorState;
    time: number;
    composition: number | null;
  } | null = null;
  /** Counts runs of typing in the table, to give each its own id. */
  private typingRuns = 0;
  /** Counts input method compositions in the table, to give each its own id. */
  private compositions = 0;
  /** The composition in progress in the table and the cell it is in, or null
   *  between compositions. Chromium reports the text a composition commits
   *  before it ends it, so the commit is part of the composition too. A redraw
   *  that replaces the cell ends the composition without a compositionend
   *  there, so only edits in that cell count as part of it. */
  private composition: { id: number; cell: EventTarget | null } | null = null;
  /** Find and replace over the frontmatter table and the document (§5.13). */
  private readonly find = new DocumentFind({
    block: () => (this.fmPanel ? this.frontmatterBlock : null),
    panel: () => this.fmPanel,
    reveal: () => this.setFrontmatterExpanded(true),
    changed: () => this.onFindChange?.(),
  });
  /** The targets of drops on this document whose files are not all in yet.
   *  Every transaction maps their positions, so each stays at its edge, after
   *  the files of its drop already inserted. */
  private readonly dropTargets = new Set<DropTarget>();
  /** Counts split drops, for the id of each one's undo step. */
  private dropRuns = 0;

  async mount(
    root: HTMLElement,
    initial: string,
    cb: WysiwygCallbacks,
    style: SerializerStyle,
    context: WysiwygContext,
  ): Promise<void> {
    if (this.destroyed || this.crepe || this.createPromise) {
      throw new Error("WysiwygEditor instances can only be mounted once");
    }
    this.ignoreUpdates = true;
    this.onChange = cb.onChange;
    this.onFindChange = cb.onFindChange ?? null;
    this.root = root;
    this.showFmPanel = context.getSettings().showFrontmatterPanel === true;

    // Frontmatter (§5.17): a leading `---` YAML block is ALWAYS split off and kept
    // verbatim (Crepe never sees it, so it can't mangle the YAML into headings).
    // It and the blank lines after it are written back unchanged on serialize.
    // When showFrontmatterPanel is on (the default), an inline disclosure above
    // the editor reveals an editable key/value table; scalar edits patch the YAML
    // line-for-line, so the file's formatting is preserved. With the setting
    // off, the YAML is hidden here but still preserved and editable in the
    // Markdown view.
    const split = splitFrontmatter(initial);
    this.frontmatterBlock = split.frontmatter;
    this.frontmatterSeparator = split.separator;
    this.syncFrontmatterPanel();
    const crepeRoot = document.createElement("div");
    crepeRoot.className = "crepe-root";
    root.appendChild(crepeRoot);
    this.crepeRoot = crepeRoot;

    // Shared holder so the missing-image handler (a Crepe feature config) can
    // reach the live EditorView captured by the image context-menu plugin.
    const viewRef: ViewRef = { current: null };
    const imageConfig = imageBlockFeatureConfig(viewRef, context);
    this.crepe = new Crepe({
      root: crepeRoot,
      // Crepe only ever sees the body (the frontmatter, if any, is split off above);
      // split.body === initial when there is no frontmatter.
      defaultValue: split.body,
      featureConfigs: {
        [Crepe.Feature.Toolbar]: selectionToolbar,
        [Crepe.Feature.BlockEdit]: blockEditConfig,
        // Render ```mermaid code blocks as diagrams below the source (§5.2),
        // show the find card's matches inside code blocks (§5.13), add a
        // cursor on Ctrl or Cmd+click only in a block that has focus, put the
        // cursor at a Shift+click in a block that does not, and at the start
        // of a line on a press on its line number.
        [Crepe.Feature.CodeMirror]: {
          renderPreview: renderMermaidPreview,
          extensions: [codeBlockFindHighlights, codeBlockClicks, CodeMirrorView.contentAttributes.of({ spellcheck: "false" })],
        },
        // Display linked images + missing-image placeholder/relocate (§5.5).
        [Crepe.Feature.ImageBlock]: imageConfig,
        // Crepe's default empty-line hint is "Please enter...".
        [Crepe.Feature.Placeholder]: { text: "Type / for blocks" },
      },
    });
    // Apply serialization style (bullets/emphasis/heading style, etc.) and
    // Downpad's text escaping.
    this.crepe.editor.config((ctx) => {
      ctx.update(remarkStringifyOptionsCtx, (prev) => stringifyOptions(prev, style));
    });
    // Crepe's block handle shows for the block under the pointer in the middle of
    // the page. An inline image there, such as a missing image's chip, counted
    // as that block, and the handle covered the words before it. Look past
    // inline nodes to the block their text would give. Over text, the lookup
    // goes on from a line that starts a list item to the item, so do that too.
    this.crepe.editor.config((ctx) => {
      ctx.update(blockConfig.key, ({ filterNodes }) => ({
        filterNodes: (pos, node) =>
          !node?.isInline && !(node?.isTextblock && pos.depth > 0 && pos.index() === 0) && filterNodes(pos, node),
      }));
    });
    // Tell screen readers whether each task is done.
    this.crepe.editor.config(labelTaskBoxes);
    this.crepe.editor.config(excludeInlineCodeSpellcheck);
    this.crepe.editor.use(excludeCodeBlockSpellcheck);
    // Keep standalone images' alt text, which Crepe overwrites with its resize
    // ratio. Must follow the ImageBlock feature so this node spec replaces Crepe's.
    this.crepe.editor.use(imageBlockAltSchema);
    // Show that alt text to screen readers instead of the caption.
    this.crepe.editor.use(imageBlockAltView);
    // Keep typed lists tight when an item gets a nested list.
    this.crepe.editor.use(tightListItemSchema);
    // Keep a blank line where a tight item's blocks would read back as something else.
    this.crepe.editor.config(tightListItemJoin);
    // Smart paste (§5.4): images, HTML→markdown, markdown-looking text.
    this.crepe.editor.use(smartPastePlugin(context, (markdown) => this.pasteMarkdown(markdown)));
    // Copy and drag without the empty line Crepe keeps after a final block.
    this.crepe.editor.use(copyWithoutTrailingLine);
    // Link rendering (§5.6): text-and-url suffix + Ctrl/Cmd-click to open.
    this.crepe.editor.use(linkViewPlugin(context));
    // Shift+click and Shift+drag on link text and images, and presses from
    // outside the document (§5.5, §5.6).
    this.crepe.editor.use(shiftClicks);
    // A press on a list item's bullet or number puts the caret at its text.
    this.crepe.editor.use(listLabelClicks);
    // A press in the side padding beside a block puts the caret on the line
    // at its height, or selects a block that takes no caret.
    this.crepe.editor.use(paddingPresses);
    // Focus leaves a code block once the document's selection has left it.
    this.crepe.editor.use(codeBlockFocus);
    // The document takes focus after a press on the block handle, and the
    // handle hides when the document changes width.
    this.crepe.editor.use(blockHandle);
    // Image context menu (§5.5) + publishes the EditorView into viewRef.
    this.crepe.editor.use(imageContextMenuPlugin(viewRef, context));
    // Show missing inline images as missing too, and keep missing images in
    // step with their paths and images (§5.5).
    this.crepe.editor.use(missingImages(imageConfig.onImageLoadError));
    // End before an image or a formula that starts a line goes to the end of
    // the line, and a selection from right after a line break keeps its
    // anchor there.
    this.crepe.editor.use(endPastAtoms);
    // Keep fence info after the language, such as title="server.js". Must follow
    // the LaTeX feature so this node spec replaces Crepe's.
    this.crepe.editor.use(codeBlockMetaSchema);
    // A click in a table cell places the caret instead of selecting the cell.
    // Must follow the Table feature so this view replaces Crepe's.
    this.crepe.editor.use(tableCellClicks);
    // A dropped block or text goes in at the edge under the pointer as the page
    // is at the drop, and on or beside a table or on a code block above or
    // below it, never between a table's rows or cells or into the code. As a
    // prop of the view itself, the drop handler runs before any plugin's. The
    // drop line marks that edge during the drag, in place of the line of
    // Crepe's drop indicator plugin, which `mount` removes, and code blocks
    // leave their drops to the editor.
    this.crepe.editor.config((ctx) => {
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        handleDrop: (view, event, slice, moved) => dropAtEdge(view, event, slice, moved) || (prev.handleDrop?.(view, event, slice, moved) ?? false),
      }));
    });
    this.crepe.editor.use(dropLine);
    this.crepe.editor.use(codeBlockDrops);
    // Look up local image URLs before the first render, so none starts raw.
    this.crepe.editor.use(preloadImages(imageConfig.preload));
    // WYSIWYG find/replace search state + decorations (§5.13).
    this.crepe.editor.use(searchMilkdownPlugin(() => cb.onFindScroll?.()));
    // Tab that the editor does not use, or Esc then Tab, moves focus out.
    this.crepe.editor.use(tabExit);
    // Focus that leaves the document closes the slash menu and hides the
    // selection toolbar.
    this.crepe.editor.use(slashMenuBlur);
    this.crepe.editor.use(toolbarBlur);
    // Read `$` and `~` as math and strikethrough only where Markdown tools do,
    // so prices stay text. Must follow the LaTeX feature.
    this.crepe.editor.use(mathDelimiters);
    // Keep where each top-level node of a parsed text starts and ends.
    this.crepe.editor.use(outlinePlugin((text, outline) => (this.parsed = { text, outline })));
    // Keep which body the document came from in the editor state, so undo of
    // a split mirror sync writes the body from before it with its own text.
    this.crepe.editor.use(baselineState(this.opened));
    // Text put in at either end of a link starts plain text (§5.6).
    this.crepe.editor.use(linkEdges);
    // Report document edits once typing pauses. Downpad keeps its own timer
    // rather than Milkdown's listener plugin, which compares against the
    // document it last reported itself. After `reportPendingChange`, an undo back
    // to that document would never be reported. The same plugin keeps the drop
    // targets' positions in step with each edit.
    this.crepe.editor.use(
      $prose(
        () =>
          new Plugin({
            state: {
              init: () => null,
              apply: (tr) => {
                // An insert at a target maps it past the inserted blocks.
                if (tr.docChanged) for (const target of this.dropTargets) target.pos = tr.mapping.map(target.pos);
                // Skip the changes undo history leaves out, by the rule it uses.
                // That is a change kept out of history (heading ids, list labels,
                // the empty last line) or a plugin's follow-up to one, which
                // carries it as "appendedTransaction". They do not change the
                // Markdown.
                const root = tr.getMeta("appendedTransaction") as Transaction | undefined;
                const recorded = tr.getMeta("addToHistory") !== false && root?.getMeta("addToHistory") !== false;
                if (tr.docChanged && recorded) this.scheduleChange();
                return null;
              },
            },
          }),
      ),
    );
    // Tell the find card when an edit changes the matches (§5.13).
    this.crepe.editor.use(findChangeListener(() => this.onFindChange?.()));
    // Keep the frontmatter block and the blank lines after it in the editor
    // state, so undo and redo take back table edits along with the body's
    // (§5.17).
    this.crepe.editor.use(
      frontmatterState(
        () => ({ block: this.frontmatterBlock, separator: this.frontmatterSeparator }),
        (view, prev) => this.frontmatterChanged(view, prev),
      ),
    );
    const crepe = this.crepe;
    let createPromise: Promise<void> | null = null;
    try {
      // Keep even a synchronous create/config failure inside this lifecycle's
      // cleanup path. First drop Crepe's indent plugin, which types four spaces
      // on Tab that Markdown saves as `&#x20;`. Lists, tables and code blocks
      // have their own Tab keys. Also drop Crepe's drop indicator plugin, whose
      // line Downpad draws itself (`dropLine`), and whose drops `dropAtEdge`
      // puts in. Its state and the element that draws its line stay.
      createPromise = crepe.editor.remove([indentPlugin, dropIndicatorPlugin]).then(() => crepe.create()).then(() => undefined);
      this.createPromise = createPromise;
      await createPromise;
    } catch (err) {
      // A host disposed while creation was pending deliberately suppresses the
      // abandoned mount. A genuine create failure still reaches the caller after
      // best-effort cleanup of the partially-created editor.
      if (this.destroyed) return;
      await this.destroy().catch(() => {});
      throw err;
    } finally {
      if (createPromise && this.createPromise === createPromise) this.createPromise = null;
    }

    // React Strict Mode (or a real app teardown) may dispose the host while the
    // asynchronous Crepe create is in flight. Never arm callbacks for that dead
    // instance; destroy() already owns/awaits its terminal cleanup.
    if (this.destroyed || this.crepe !== crepe) return;
    // Remember the source just opened. A split mirror that landed while Crepe
    // was creating then replaces the body and records its own source, so
    // undoing it writes the opened body with the opened source.
    this.rememberSource(split.body, this.opened);
    const mirrored = this.pendingBody;
    this.pendingBody = null;
    if (mirrored !== null) this.replaceBody(mirrored);
    this.accessibilityCleanup = installEditorAccessibility(crepeRoot);
    // Crepe adds an empty last line below a final list, code block, quote,
    // table, rule or image in the first transaction after create. Make that an
    // empty transaction kept out of undo history. Otherwise the list view's
    // first-frame selection or the first click gets the line recorded, and the
    // first Ctrl+Z only removes it (Crepe adds it straight back) and moves the
    // caret.
    this.withView((view) => view.dispatch(view.state.tr.setMeta("addToHistory", false)), undefined);
    this.enableUpdatesTimer = setTimeout(() => {
      this.enableUpdatesTimer = null;
      if (!this.destroyed && this.crepe === crepe) this.ignoreUpdates = false;
    }, 0);
  }

  /** The document as Markdown, or null when Milkdown cannot write it. Joins
   *  the frontmatter block, the blank lines after it and Crepe's body, and
   *  starts the body on a new line if the block ends without one. Milkdown
   *  leaves out the empty line Crepe keeps after a final list, code block,
   *  quote, table, rule or image. The body keeps the exact source of every
   *  block that still says what Crepe parsed, so opening, mirroring or undoing
   *  back never rewrites text the user has not changed, and an edit rewrites
   *  only the blocks it touched. When it cannot show that the file's text
   *  reads back as the document, such as when two lists would join, it
   *  rewrites the whole body. A typed closing `$` or `~` that still waits for
   *  the next character is written as the formula or strikethrough that
   *  deciding it now would make, as Save writes it (`decidedDoc`). */
  getMarkdown(): string | null {
    const body = this.bodyMarkdown();
    return body == null
      ? null
      : joinFrontmatter({ frontmatter: this.frontmatterBlock, separator: this.frontmatterSeparator, body });
  }

  /** Paste through the source, recording its body and frontmatter in one undo. */
  private pasteMarkdown(markdown: string): boolean {
    if (!this.crepe) return false;
    const editor = this.crepe.editor;
    return editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const baseline = baselineOf(view.state) ?? this.baseline;
      const serialize = ctx.get(serializerCtx);
      const splitBody = (body: string) => splitFrontmatter(joinFrontmatter({
        frontmatter: this.frontmatterBlock, separator: this.frontmatterSeparator, body,
      }));
      const pasted = pasteMarkdownSource(view.state, markdown, {
        write: (doc) => baseline ? baseline.write(doc) : serialize(doc),
        serialize,
        parse: ctx.get(parserCtx),
        bodyOf: (body) => splitBody(body).body,
      });
      if (pasted == null) return false;
      const { body, caret } = pasted;
      const split = splitBody(body);
      const slot: BaselineSlot = { baseline: null };
      editor.action(mirrorMarkdown(split.body, false, (state, tr) => {
        setFrontmatter(state, tr, { block: split.frontmatter, separator: split.separator });
        setBaseline(state, tr, slot);
        // Populate the slot before frontmatter's view callback reports the edit.
        this.rememberSource(split.body, slot, tr.doc);
        tr.setSelection(Selection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size)), -1));
        return closeHistory(tr).setMeta("paste", true).setMeta("uiEvent", "paste").scrollIntoView();
      }));
      // Typing after the paste starts a separate undo step.
      view.dispatch(closeHistory(view.state.tr));
      return true;
    });
  }

  /** Report an edit now instead of waiting for typing to pause. A caller that
   *  reads the document right away (Save) calls this first. A typed closing
   *  `$` or `~` that still waits for the next character is decided first, so
   *  the editor shows the formula or strikethrough that the file holds.
   *  `keepTypedMark` leaves it waiting, for a click or focus moving into this
   *  pane, which may put the cursor inside the text the mark closes, and for
   *  autosave. Either way the report holds what Save writes (`getMarkdown`).
   *  The edit takes the usual `onChange` path, and the pending report is
   *  cancelled. */
  reportPendingChange({ keepTypedMark = false }: { keepTypedMark?: boolean } = {}): void {
    if (!keepTypedMark) this.withView(decideTypedMark, undefined);
    if (this.changeTimer == null || this.ignoreUpdates) return;
    clearTimeout(this.changeTimer);
    this.changeTimer = null;
    this.emitChange();
  }

  /** Aim a file drop at a viewport point (§5.4). The files go in at the block
   *  edge the drop line marked at the point during the drag, or at the start
   *  or end for a point above or below the document.
   *  Returns the target for `insertMarkdown`, or null without an editor. The
   *  editor keeps the target in step with edits until `releaseDropTarget`. */
  dropTargetAt(x: number, y: number): DropTarget | null {
    const pos = this.withView((view) => dropPosition(view, x, y), null);
    if (pos === null) return null;
    const target: DropTarget = { pos };
    this.dropTargets.add(target);
    return target;
  }

  /** Aim images pasted into this editor at the block edge at the caret
   *  (§5.5), where a file dropped away from the text goes in at a caret
   *  (`insertAtSelection`). That is after any selected text or block, which
   *  an image never replaces, and before or after the line's block from the
   *  start of a line or anywhere else in it, so the line is never split. In
   *  a table, which cannot hold an image, it is the edge above or below the
   *  table where the image goes in (`blockEdge`). The edge is fixed when the
   *  image is pasted, so each image pasted there later goes in after the
   *  ones before it. Returns the target for `insertMarkdown`, or null without
   *  an editor. The editor keeps the target in step with edits until
   *  `releaseDropTarget`. */
  caretTarget(): DropTarget | null {
    const target = this.withView(({ state: { doc, selection } }): DropTarget => {
      const { $to } = selection;
      if (!$to.parent.inlineContent) return { pos: blockEdge(doc, $to.pos) };
      return { pos: blockEdge(doc, $to.parentOffset === 0 ? $to.before() : $to.after()) };
    }, null);
    if (target) this.dropTargets.add(target);
    return target;
  }

  /** Stop keeping a drop target in step, once the files of its drop are in. */
  releaseDropTarget(target: DropTarget): void {
    this.dropTargets.delete(target);
  }

  /** Insert markdown for a dropped file (§5.4). With the target of a drop on
   *  this editor, its blocks go in at that edge, after any file of the same
   *  drop. Otherwise they go in at the caret, after any selection, which they
   *  never replace. Either way the caret ends up after them, unless
   *  `moveCaret` is off, for a user who has moved on since the drop. Returns
   *  the target for the drop's next file, right after this one, which the
   *  editor keeps in step with edits until `releaseDropTarget`. For a file
   *  that went in at the caret it is a new target, so the next file follows
   *  this one even while the caret stays before it. Null if nothing went in
   *  and the drop has no target here. With `undoGroup`, later changes that
   *  carry it join the insert's undo step. */
  insertMarkdown(markdown: string, target: DropTarget | null = null, moveCaret = true, undoGroup?: string): DropTarget | null {
    if (!this.crepe || !markdown) return null;
    const aimed = target && this.dropTargets.has(target) ? target : null;
    const next = aimed ?? { pos: 0 };
    // Kept in step from the insert on, which moves it to the file's end.
    this.dropTargets.add(next);
    try {
      const atEdge = aimed && !aimed.inLine;
      const insert = atEdge ? insertBlocksAt(markdown, aimed, moveCaret, undoGroup) : insertAtSelection(markdown, next, moveCaret, undoGroup);
      if (this.crepe.editor.action(insert)) {
        return next;
      }
    } catch {
      // Editor not ready / torn down mid-drop; ignore.
    }
    if (!aimed) this.dropTargets.delete(next);
    return aimed;
  }

  /**
   * Insert a dropped file at the target of a drop on this pane, as
   * `insertMarkdown` does but leaving the caret, and return the change to
   * `source`, the Markdown this pane shows, that puts the file in the same
   * place (§5.4). The split's Markdown pane makes that change while the user
   * types there, and so does the Markdown view while this pane is hidden
   * behind it. This pane's own report would write the block the file joins
   * in its own form under their caret. Null when the pane cannot tell where
   * the file goes in the source, or nothing went in.
   *
   * The changed source becomes the source of this pane's body, in the
   * insert's undo step. So the split's mirror of the Markdown pane's change
   * changes nothing here (`replaceBody`), and one undo takes back the file
   * and writes the body with the source from before the drop.
   */
  insertMarkdownWithSource(markdown: string, target: DropTarget, source: string): SourceEdit | null {
    const before = this.withView((view) => view.state.doc, null);
    const undoGroup = `drop-${++this.dropRuns}`;
    this.insertMarkdown(markdown, target, false, undoGroup);
    const after = this.withView((view) => view.state.doc, null);
    if (!this.crepe || !before || !after || before === after) return null;
    const { body } = splitFrontmatter(source);
    const offset = source.length - body.length;
    try {
      const edit = this.crepe.editor.action((ctx) => sourceEditBetween(ctx, before, after, body));
      if (!edit) return null;
      const slot: BaselineSlot = { baseline: null };
      this.withView((view) => view.dispatch(setBaseline(view.state, view.state.tr, slot).setMeta("composition", undoGroup)), undefined);
      this.rememberSource(body.slice(0, edit.from) + edit.insert + body.slice(edit.to), slot);
      return { ...edit, from: edit.from + offset, to: edit.to + offset };
    } catch {
      return null;
    }
  }

  /**
   * Mirror an edit made in the other split pane into the document (§6.1). The
   * frontmatter block is re-split (and its table re-rendered, added, or
   * removed as the source gains/loses a `---` block) and the blocks of Crepe's
   * body that differ are replaced (`mirrorMarkdown`), unless the document is
   * still the one the body gave it (`replaceBody`). Both changes are one
   * transaction, so an undo here takes back the block and the body together.
   * Positions outside the changed blocks keep their place, such as the caret
   * and the targets of drops, through the sync and its undo and redo. The user
   * can be typing here while a file dropped on the Markdown pane goes in
   * there. Then a block the sync leaves alone keeps what only this pane
   * holds, such as a space typed at the end of a line. The table keeps its
   * cells unless one still shows text the block no longer has, and is not
   * drawn again while its block stays the same.
   *
   * The replacement is reported like an edit after a ~200ms pause
   * (`scheduleChange`). That report carries `markdown` itself, because every
   * block still matches the block of the source it was parsed from
   * (`getMarkdown`), so the host sees no change. The mirror never writes
   * Milkdown's rewrite back over the author's exact text.
   *
   * While Crepe is still creating the editor there is no view to replace, so the
   * body waits for `mount` to apply it.
   */
  setMarkdown(markdown: string): void {
    if (!this.crepe) return;
    const split = splitFrontmatter(markdown);
    // The table shows the block it has already. Drawing it again would put
    // the caret of a cell being typed in at the cell's start, since React
    // writes the cell's text again when it differs from what React drew.
    const blockChanged = split.frontmatter !== this.frontmatterBlock;
    this.frontmatterBlock = split.frontmatter;
    this.frontmatterSeparator = split.separator;
    if (blockChanged) {
      // Draw the table at once, so the check below sees it.
      flushSync(() => this.syncFrontmatterPanel());
      // A cell whose typed text the Markdown pane took back can still show
      // that text (`showsBlock`), and the next keystroke there would write it
      // back. Then draw a new table. Otherwise React patches the cells it has,
      // so a click that brought this pane up to date (EditorHost's catch-up
      // on pointerdown) still lands in its cell.
      if (this.fmPanel && this.frontmatterBlock != null && !showsBlock(this.fmPanel, this.frontmatterBlock)) {
        this.fmTableKey += 1;
        flushSync(() => this.renderFrontmatter());
      }
      // Find again in a table this added; redraws of a shown table refresh on their own.
      this.find.refresh();
    }
    if (this.createPromise) this.pendingBody = split.body;
    else this.replaceBody(split.body);
  }

  /** Replace the blocks of Crepe's body that differ from `body` and remember
   *  its source (see `setMarkdown`). The body this pane's document came from,
   *  while the document is still the one it gave, as after a split drop
   *  (`insertMarkdownWithSource`), leaves the editor's blocks as they are, so
   *  it adds no undo step that changes nothing. Its parse can differ from
   *  those blocks where the text does not show it, such as a list item that
   *  a dropped image went into, which the source reads as loose and the
   *  document holds as tight. Replacing that item would move the places of
   *  later files in it to its end. */
  private replaceBody(body: string): void {
    if (!this.crepe) return;
    const kept = this.withView(({ state }) => {
      const baseline = baselineOf(state) ?? this.baseline;
      return baseline?.source === body && baseline.holds(state.doc);
    }, false);
    if (kept) {
      this.withView((view) => {
        const tr = setFrontmatter(view.state, view.state.tr, { block: this.frontmatterBlock, separator: this.frontmatterSeparator });
        if (tr.steps.length) view.dispatch(tr);
      }, undefined);
      return;
    }
    try {
      // The frontmatter block and the blank lines after it, which setMarkdown
      // has just stored, and the new body's baseline go in the same
      // transaction. A file dropped on this pane while the other one was
      // edited still goes in where it was dropped, since the drop targets map
      // through it. While the user types here, what only the editor holds
      // stays.
      const typedIn = this.withView((view) => view.hasFocus(), false);
      const slot: BaselineSlot = { baseline: null };
      let newSource = true;
      this.crepe.editor.action(
        mirrorMarkdown(body, typedIn, (state, tr) => {
          setFrontmatter(state, tr, { block: this.frontmatterBlock, separator: this.frontmatterSeparator });
          // While the user types here, a block can hold what its source does
          // not, such as a space at the end of a line, so it takes this body
          // as its source either way.
          newSource = typedIn || tr.steps.length > 0 || (baselineOf(state) ?? this.baseline)?.source !== body;
          return newSource ? setBaseline(state, tr, slot) : tr;
        }),
      );
      // The doc updates synchronously with the dispatch.
      if (newSource) this.rememberSource(body, slot);
    } catch {
      // Editor torn down mid-sync; ignore.
    }
  }

  /** Bring the frontmatter table into line with the current `frontmatterBlock`
   *  at mount, after a `setMarkdown` (§6.1) and after undo, redo or Replace:
   *  create the panel when the source just gained a `---` block, remove it when
   *  the block is gone, otherwise re-render in place. A no-op when the
   *  showFrontmatterPanel setting is off (the block is still kept for
   *  serialization, just not shown here). */
  private syncFrontmatterPanel(): void {
    if (!this.showFmPanel) return;
    if (this.frontmatterBlock != null) {
      if (!this.fmPanel) {
        const panel = document.createElement("div");
        panel.className = "frontmatter-table-wrap";
        // Sits above Crepe's body.
        if (this.root && this.crepeRoot) this.root.insertBefore(panel, this.crepeRoot);
        else this.root?.appendChild(panel);
        // Ctrl+Z and Ctrl+Y anywhere in the table run the document's undo and redo.
        panel.addEventListener("keydown", this.tableHistory);
        panel.addEventListener("beforeinput", this.tableHistory);
        // An input method composition is one undo step, however long the
        // user waits before choosing the text (recordTableEdit).
        panel.addEventListener("compositionstart", (event) => {
          this.composition = { id: ++this.compositions, cell: event.target };
        });
        panel.addEventListener("compositionend", () => (this.composition = null));
        // A press on the table outside its keys, values and buttons, such as
        // in the blank space around them, leaves focus
        // where it was. Chromium moved focus to the page, and the next key
        // went nowhere. Each key and value carries data-part
        // (FrontmatterPanel), and a press on one, also a read-only one, stays
        // with the browser, so its text can be selected.
        panel.addEventListener("mousedown", (event) => {
          const { target } = event;
          if (event.button === 0 && target instanceof Element && !target.closest("button, [data-part]")) event.preventDefault();
        });
        this.fmPanel = panel;
        this.fmPanelRoot = createRoot(panel);
      }
      this.renderFrontmatter();
    } else if (this.fmPanel) {
      this.fmPanelRoot?.unmount();
      this.fmPanelRoot = null;
      this.fmPanel.remove();
      this.fmPanel = null;
      this.fmExpanded = false;
    }
  }

  /** Reveal or hide metadata without changing the document or undo history. */
  private setFrontmatterExpanded(expanded: boolean): void {
    if (!this.fmPanelRoot || this.fmExpanded === expanded) return;
    this.fmExpanded = expanded;
    // Find measures its current cell immediately after asking to reveal it.
    flushSync(() => this.renderFrontmatter());
  }

  // ── Find/replace controller (§5.13), driven by the FindBar via EditorHost ──

  private withView<T>(fn: (view: EditorView) => T, fallback: T): T {
    if (!this.crepe) return fallback;
    try {
      return this.crepe.editor.action((ctx) => fn(ctx.get(editorViewCtx)));
    } catch {
      return fallback;
    }
  }

  search(query: string, opts: FindOptions): FindCounts {
    return this.withView((v) => this.find.search(v, query, opts), NO_MATCHES);
  }

  findNext(): FindCounts {
    return this.withView((v) => this.find.move(v, 1), NO_MATCHES);
  }

  findPrev(): FindCounts {
    return this.withView((v) => this.find.move(v, -1), NO_MATCHES);
  }

  replaceCurrent(replacement: string, query: string, opts: FindOptions): FindCounts {
    return this.withView((v) => this.find.replaceCurrent(v, replacement, query, opts), NO_MATCHES);
  }

  replaceAll(replacement: string, query: string, opts: FindOptions): FindCounts {
    return this.withView((v) => this.find.replaceAll(v, replacement, query, opts), NO_MATCHES);
  }

  /** The current match and total, for a find card catching up with an edit. */
  currentCounts(): FindCounts {
    return this.withView((v) => this.find.counts(v), NO_MATCHES);
  }

  clearSearch(): void {
    this.withView((v) => this.find.clear(v), undefined);
  }

  /** Focus the document. While the find card's current match is in an editable
   *  frontmatter cell, focus that cell with the match selected instead. */
  focus(): void {
    if (this.find.focusCurrent()) return;
    this.focusText();
  }

  /** Focus the document text at its caret, even while the find card's current
   *  match is in a frontmatter cell, as after a file dropped on the text. */
  focusText(): void {
    this.withView((v) => v.focus(), undefined);
  }

  /**
   * Wrap the current selection in a link (spec §5.6), for the right-click menu's
   * "Insert link…". Returns false when there is no editor, no `link` mark in the
   * schema, or nothing selected — the link text is the selection, so an empty
   * one has nothing to attach to. Goes through a transaction, so undo works.
   */
  insertLink(href: string): boolean {
    return this.withView((view) => {
      const { selection, schema } = view.state;
      const linkType = schema.marks.link;
      if (!linkType || selection.empty) return false;
      view.dispatch(
        view.state.tr.addMark(selection.from, selection.to, linkType.create({ href })).scrollIntoView(),
      );
      view.focus();
      return true;
    }, false);
  }

  /** Re-show after being hidden on a tab/view switch. ProseMirror reflows from
   *  the browser when un-hidden, so focusing the view is enough. */
  onShow(): void {
    this.focus();
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;

    this.destroyed = true;
    this.ignoreUpdates = true;
    this.onChange = null;
    this.accessibilityCleanup?.();
    this.accessibilityCleanup = null;
    if (this.enableUpdatesTimer != null) {
      clearTimeout(this.enableUpdatesTimer);
      this.enableUpdatesTimer = null;
    }
    if (this.changeTimer != null) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    this.find.dispose();
    this.fmPanelRoot?.unmount();
    this.fmPanelRoot = null;
    this.fmPanel = null;
    this.frontmatterBlock = null;
    this.frontmatterSeparator = "";
    this.typing = null;
    this.root = null;
    this.crepeRoot = null;
    this.baseline = null;
    this.opened = { baseline: null };
    this.parsed = null;
    this.pendingBody = null;
    this.dropTargets.clear();
    const crepe = this.crepe;
    const creating = this.createPromise;
    // Null this synchronously: all public operations become no-ops immediately,
    // even though Crepe's asynchronous destruction may take longer.
    this.crepe = null;

    this.destroyPromise = (async () => {
      // If disposal races mount, let create settle first. Its rejection is the
      // abandoned mount's concern; cleanup still gets a chance to run.
      if (creating) await creating.catch(() => {});
      // A failed create leaves Milkdown in its creating state, where destroy()
      // tries again every 50 ms forever. Such an editor has nothing to destroy.
      if (crepe && crepe.editor.status !== EditorStatus.OnCreate) await crepe.destroy();
    })();
    return this.destroyPromise;
  }

  /** Record the body Crepe just parsed in `slot`, so `getMarkdown` can keep
   *  its exact text for the blocks the user does not change. */
  private rememberSource(source: string, slot: BaselineSlot, doc?: EditorState["doc"]): void {
    const parsed = this.parsed;
    this.parsed = null;
    this.baseline =
      this.crepe?.editor.action((ctx) => {
        const remark = ctx.get(remarkCtx);
        const schema = ctx.get(schemaCtx);
        const tools: MarkdownTools = {
          serialize: ctx.get(serializerCtx),
          parse: (markdown) => remark.parse(markdown),
          // What Milkdown's parser does after reading the text. The parser
          // state takes the transformed tree as a plain object.
          toDoc: (tree, markdown) => new ParserState(schema).next({ ...remark.runSync(tree, markdown) }).toDoc(),
        };
        return new SourceBaseline(source, doc ?? ctx.get(editorViewCtx).state.doc, tools, parsed?.text === source ? parsed.outline : undefined);
      }) ?? null;
    slot.baseline = this.baseline;
  }

  /** Crepe's document as Markdown, with the source text of unchanged blocks,
   *  and a typed closing mark that still waits written as Save writes it
   *  (`decidedDoc`). Null when Milkdown cannot write it. */
  private bodyMarkdown(): string | null {
    if (!this.crepe) return null;
    try {
      return this.crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const baseline = baselineOf(view.state) ?? this.baseline;
        const doc = decidedDoc(view);
        return baseline ? baseline.write(doc) : ctx.get(serializerCtx)(doc);
      });
    } catch {
      return null;
    }
  }

  /** Restart the wait for typing to pause before reporting the edit. */
  private scheduleChange(): void {
    if (this.changeTimer != null) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      if (!this.ignoreUpdates) this.emitChange();
    }, CHANGE_DEBOUNCE_MS);
  }

  /** Report the current Markdown (the exact source while the body is unchanged)
   *  through onChange. Reports nothing when Milkdown cannot write the document,
   *  so the tab keeps the last text it had. */
  private emitChange(): void {
    const markdown = this.getMarkdown();
    if (markdown != null) this.onChange?.(markdown);
  }

  /** Project the current YAML block through the React-owned frontmatter view. */
  private renderFrontmatter(focus: FrontmatterFocus = null): void {
    if (!this.fmPanelRoot || this.frontmatterBlock == null) return;
    this.fmPanelRoot.render(
      createElement(FrontmatterDisclosure, {
        block: this.frontmatterBlock,
        expanded: this.fmExpanded,
        onExpandedChange: (expanded: boolean) => this.setFrontmatterExpanded(expanded),
        children: createElement(FrontmatterPanel, {
          key: this.fmTableKey,
          block: this.frontmatterBlock,
          focus,
          onBlockChange: (block: string, nextFocus?: Exclude<FrontmatterFocus, null>) => {
            this.frontmatterBlock = block;
            this.withView((view) => this.recordTableEdit(view, block, !nextFocus), undefined);
            this.emitChange();
            // Structural changes alter line indices and must refresh the projection.
            // Plain scalar edits stay in the current contenteditable node so React
            // never disturbs its selection or caret.
            if (nextFocus) this.renderFrontmatter(nextFocus);
          },
        }),
      }),
    );
  }

  /** Put a table edit that set the block to `block` in the undo history. A
   *  keystroke (`typed`) joins the undo step of the ones before it in the same
   *  cell until typing pauses or anything else changes, as typing in the
   *  document does. The edits of one input method composition stay in one
   *  step even when the user pauses before choosing the text. */
  private recordTableEdit(view: EditorView, block: string, typed: boolean): void {
    const tr = setFrontmatter(view.state, view.state.tr, { block });
    const cell = typed ? document.activeElement : null;
    const composition = cell && this.composition?.cell === cell ? this.composition.id : null;
    const last = this.typing;
    const joins =
      cell &&
      last?.cell === cell &&
      last.state === view.state &&
      ((composition !== null && composition === last.composition) || tr.time - last.time < UNDO_GROUP_MS);
    const run = joins ? last.run : `frontmatter-${++this.typingRuns}`;
    // The history groups changes that carry the same composition id, which is
    // how ProseMirror keeps the keystrokes of an input method together. A
    // step in the table has no position next to the last change, so without
    // the id every keystroke would be its own undo step.
    view.dispatch(tr.setMeta("composition", run));
    this.typing = cell ? { cell, run, state: view.state, time: tr.time, composition } : null;
  }

  /** Show a frontmatter block that undo, redo or Replace has put in the editor
   *  state, and report it at once, as the table reports its own edits. The
   *  table draws it right away, as a new table, so no cell keeps text the user
   *  typed. When the focus was in this editor and the body did not change, the
   *  caret goes to the changed cell, as undo puts it at the change in the
   *  document. Undo and redo of a mirror sync also put back the blank lines
   *  after the block. Edits made in the table, and mirror syncs, show their
   *  frontmatter before it reaches the state, so they are left alone. */
  private frontmatterChanged(view: EditorView, prev: EditorState): void {
    const { block, separator } = frontmatterOf(view.state);
    const before = this.frontmatterBlock;
    if (block === before && separator === this.frontmatterSeparator) return;
    this.frontmatterSeparator = separator;
    if (block === before) {
      // Only the blank lines changed, which the table does not show.
      this.reportPendingChange({ keepTypedMark: true });
      return;
    }
    const inTable = !!this.fmPanel?.contains(document.activeElement);
    const inEditor = inTable || view.hasFocus();
    this.frontmatterBlock = block;
    this.fmTableKey += 1;
    // Undo can restore a cell after its table was collapsed. Reveal it before
    // React redraws and the caret moves, without disturbing a body undo.
    if (inEditor && view.state.doc === prev.doc) this.fmExpanded = true;
    flushSync(() => this.syncFrontmatterPanel());
    this.find.refresh();
    // The typed-mark guard decides whether a typed closing mark still waits
    // after this change, so the report leaves it be. It already writes such a
    // mark as Save would (getMarkdown).
    this.reportPendingChange({ keepTypedMark: true });

    const panel = this.fmPanel;
    if (!panel && inTable) view.focus();
    if (!panel || !inEditor || view.state.doc !== prev.doc) return;
    const cell = before != null && block != null ? changedCell(before, block) : null;
    if ((cell && focusCaret(panel, cell)) || !inTable) return;
    // The changed row is gone or read-only, and the redraw took the focus. Like
    // Delete, leave it on Add field.
    const add = panel.querySelector<HTMLElement>(".frontmatter-add");
    if (add) add.focus();
    else view.focus();
  }

  /** Run the document's undo or redo for Ctrl+Z, Ctrl+Y or the browser's Undo
   *  and Redo commands in the frontmatter table. */
  private readonly tableHistory = (event: Event): void => {
    if (this.withView((view) => handleTableHistory(view, event), false)) event.preventDefault();
  };
}
