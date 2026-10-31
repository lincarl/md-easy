// Raw view: CodeMirror 6 with VS Code's Markdown colours. A *view* over the
// canonical markdown string; raw edits are written back verbatim (spec §5.16).

import { EditorView, basicSetup } from "codemirror";
import { isolateHistory } from "@codemirror/commands";
import { ChangeSet, Compartment, EditorSelection, EditorState, type Text } from "@codemirror/state";
import {
  SearchQuery,
  findNext as findNextMatch,
  findPrevious as findPreviousMatch,
  getSearchQuery,
  replaceAll as replaceAllMatches,
  replaceNext as replaceNextMatch,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { base64Collapse, dropOutsidePayload, inBase64Payload, paragraphPlace } from "./base64Collapse";
import { differingRuns, type Run } from "../differingRuns";
import { codeMirrorPresses } from "../codeMirrorPresses";
import { specialDashHighlight } from "./specialDash";
import { markdownSource, markdownSourceStyle } from "./markdownSource";
import { sourceCodeSpellcheck } from "./spellcheck";
import type { FindCounts, FindOptions } from "../wysiwyg/findEngine";
import { codeMirrorSpan, revealSpan } from "../wysiwyg/findReveal";
import type { DropTarget, SourceEdit } from "../wysiwyg/fileDrop";

/** How long edits and caret moves must pause before the find card recounts.
 *  Counting after an edit walks the whole document, which takes about 200ms
 *  for 2 MB, too slow for every keystroke. */
const FIND_RECOUNT_DELAY_MS = 200;

/** A match of the find card's query, as document offsets. */
type Match = { from: number; to: number };

export interface RawCallbacks {
  onChange: (text: string) => void;
  /** Called once edits or selection moves pause while a find query is set, so
   *  the find card can show the new count and current match (§5.13). */
  onFindChange?: () => void;
}

export interface RawOptions {
  /** Collapse base64 data URIs in the view (§5.3). */
  collapseBase64?: boolean;
}

/** Search test that skips the base64 data of data: URIs, so Replace all cannot corrupt an image. */
function outsideImageData(_match: string, state: EditorState, from: number, to: number): boolean {
  return !inBase64Payload(state.doc, from, to);
}

/** Whether a UTF-16 code unit is the first half of a surrogate pair, the two
 *  units that encode one character such as an emoji. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
/** Whether a UTF-16 code unit is the second half of a surrogate pair. */
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** The one change that turns `before` into `after`, leaving out the text they
 *  share at the start and at the end. Both ends fall between characters, never
 *  between the halves of a surrogate pair, so a caret mapped to an end cannot
 *  split one. */
function changedRange(before: string, after: string): { from: number; to: number; insert: string } {
  const shorter = Math.min(before.length, after.length);
  let from = 0;
  while (from < shorter && before.charCodeAt(from) === after.charCodeAt(from)) from += 1;
  if (from > 0 && isHighSurrogate(before.charCodeAt(from - 1))) from -= 1;
  let to = before.length;
  let end = after.length;
  while (to > from && end > from && before.charCodeAt(to - 1) === after.charCodeAt(end - 1)) {
    to -= 1;
    end -= 1;
  }
  if (to < before.length && isLowSurrogate(before.charCodeAt(to))) {
    to += 1;
    end += 1;
  }
  return { from, to, insert: after.slice(from, end) };
}

/** The line breaks that put text going in at `at` in a paragraph of its own,
 *  with a blank line on each side, apart from the start and the end of the
 *  text. At the start of a line with text, it goes in before that line, and
 *  otherwise after the line `at` ends. */
function blankLinesAt(doc: Text, at: number): [string, string] {
  const line = doc.lineAt(at);
  const blank = (number: number): boolean => number < 1 || number > doc.lines || !doc.line(number).text.trim();
  if (at === line.from && !blank(line.number)) return [blank(line.number - 1) ? "" : "\n", "\n\n"];
  return ["\n\n", blank(line.number + 1) ? "" : "\n"];
}

/** The lines of a text, each with the line break that ends it. */
const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** The offset in a text where each of its lines starts, and its length last. */
function lineStarts(lines: string[]): number[] {
  const starts = [0];
  for (const line of lines) starts.push(starts[starts.length - 1] + line.length);
  return starts;
}

/** The changes that turn `before` into `after`, one for each run of lines
 *  that differ, and within those lines only the part that changed. Text
 *  between two changed places keeps its offsets. */
function changedLines(before: string, after: string): Array<{ from: number; to: number; insert: string }> {
  const a = linesOf(before);
  const b = linesOf(after);
  const startsA = lineStarts(a);
  const startsB = lineStarts(b);
  return differingRuns(a.length, b.length, (i, j) => a[i] === b[j], 4_000_000).map((run) => {
    const from = startsA[run.fromA];
    const part = changedRange(before.slice(from, startsA[run.toA]), after.slice(startsB[run.fromB], startsB[run.toB]));
    return { from: from + part.from, to: from + part.to, insert: part.insert };
  });
}

/** The part of a Markdown line before its text: its indentation, then quote
 *  markers and a list marker with its task box. An empty item's marker can
 *  end the line. */
const LINE_PREFIX = /^([ \t]*)(?:>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+(?:\[[ xX]\][ \t]+)?|$))?/;

/** A Markdown line split up by `LINE_PREFIX`: the part before its text, how
 *  much of that is indentation, and the text. */
interface SourceLine {
  prefix: string;
  indent: number;
  text: string;
}

/** Split a Markdown line up by `LINE_PREFIX`. */
function splitLine(line: string): SourceLine {
  const match = LINE_PREFIX.exec(line);
  const prefix = match?.[0] ?? "";
  return { prefix, indent: match?.[1].length ?? 0, text: line.slice(prefix.length) };
}

/** The document view's form of an empty paragraph, as Milkdown reads it. */
const EMPTY_PARAGRAPH = /^<br\s*\/?\s*>$/i;

/** What a line is matched by: its text as it reads, without the backslash
 *  escapes, trailing spaces and hard break that the document view adds or
 *  drops, so a line it only writes another way still matches. An empty list
 *  item gets a key no text has, and so does a line of quote markers alone,
 *  so neither matches an empty line or the other. An item that holds only
 *  `<br />`, the document view's form of an empty item, counts as empty. */
function lineKey({ prefix, text }: SourceLine): string {
  // A line can hold a whole image's data, so each replacement runs only
  // where it can change something.
  let key = text.includes("\\") ? text.replace(/\\([!-\/:-@\[-`{-~])/g, "$1") : text;
  if (/[ \t\\]$/.test(key.slice(-1))) key = key.replace(/\\?[ \t]*$/, "");
  if (!prefix.trim() || (key !== "" && !EMPTY_PARAGRAPH.test(key))) return key;
  // An empty item and a line of quote markers alone each get a key of their
  // own, so the blank line a drop puts into a quote never takes the caret of
  // an empty item in it.
  return /(?:[-*+]|\d{1,9}[.)]|\[[ xX]\])[ \t]*$/.test(prefix) ? "\n" : "\r";
}

/** A change to a text, as offsets into it. */
interface Change {
  from: number;
  to: number;
  insert: string;
}

/** The changes that turn the text `a` into `b`, one for each run of
 *  characters that differ (`differingRuns`). Like `changedRange`, they keep
 *  both halves of a surrogate pair together. A diff that would take more
 *  than about `budget` comparisons gives one change from the first
 *  difference to the last. */
function textChanges(a: string, b: string, budget?: number): Change[] {
  if (a === b) return [];
  const runs: Run[] = [];
  for (const run of differingRuns(a.length, b.length, (i, j) => a.charCodeAt(i) === b.charCodeAt(j), budget)) {
    // The characters next to a run are the same in both texts.
    const whole = { ...run };
    if (whole.fromA > 0 && isHighSurrogate(a.charCodeAt(whole.fromA - 1))) {
      whole.fromA -= 1;
      whole.fromB -= 1;
    }
    if (whole.toA < a.length && isLowSurrogate(a.charCodeAt(whole.toA))) {
      whole.toA += 1;
      whole.toB += 1;
    }
    const last = runs[runs.length - 1];
    if (last && last.toA >= whole.fromA) Object.assign(last, { toA: whole.toA, toB: whole.toB });
    else runs.push(whole);
  }
  return runs.map((run) => ({ from: run.fromA, to: run.toA, insert: b.slice(run.fromB, run.toB) }));
}

/** How alike two line keys are, for pairing a line the document view wrote
 *  another way with the line it came from. Positive when they share more
 *  than half their characters, in order (a Dice coefficient above 0.5), and
 *  higher the more they share and the less they differ. */
function likeness(a: string, b: string): number {
  const total = a.length + b.length;
  // They share at most the shorter one.
  if (4 * Math.min(a.length, b.length) <= total) return 0;
  // The document view changes a few characters of a line. Lines that differ
  // more are measured only by the start and end they share, which is quick.
  const differing = textChanges(a, b, Math.min(16 * total, 20_000)).reduce((sum, change) => sum + change.to - change.from + change.insert.length, 0);
  return total - 2 * differing;
}

/** The largest run of differing lines that `pairLines` pairs up, as lines
 *  before times lines after. */
const PAIRING_LIMIT = 400;

/**
 * Pair up the lines of a run of differing lines, in order, by their keys
 * before (`a`) and after (`b`), so that the pairs are as alike as can be
 * (`likeness`). That pairs each line the document view wrote another way,
 * such as with an entity decoded, with the line it came from, apart from the
 * lines put in or taken out. Returns the line of `b` that each line of `a`
 * pairs with, or -1. A run larger than `PAIRING_LIMIT` is left unpaired.
 */
function pairLines(a: string[], b: string[]): number[] {
  const pairs = a.map(() => -1);
  if (a.length * b.length > PAIRING_LIMIT) return pairs;
  const score = a.map((line) => b.map((other) => likeness(line, other)));
  // The most likeness the pairs among the lines from a[i] and b[j] on can have.
  const most = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const paired = score[i][j] > 0 ? score[i][j] + most[i + 1][j + 1] : 0;
      most[i][j] = Math.max(paired, most[i + 1][j], most[i][j + 1]);
    }
  }
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (score[i][j] > 0 && most[i][j] === score[i][j] + most[i + 1][j + 1]) {
      pairs[i] = j;
      i += 1;
      j += 1;
    } else if (most[i][j] === most[i + 1][j]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** Where a caret at `column` of the line `from` goes in the line `to`, the
 *  line it became. In the text it stays before the same character, before
 *  text put in there, such as an escape, and goes to the start of text taken
 *  out around it, as at the `<br />` of an empty item. In the part before
 *  the text, it stays at the line's start, before the quote or list marker,
 *  or as far from the text as it was, within the marker. */
function columnIn(from: SourceLine, to: SourceLine, column: number): number {
  if (column >= from.prefix.length) {
    const text = ChangeSet.of(textChanges(from.text, to.text), from.text.length);
    return to.prefix.length + text.mapPos(column - from.prefix.length, -1);
  }
  if (column < from.indent) return Math.min(column, to.indent);
  if (column === from.indent) return to.indent;
  return Math.max(to.indent, to.prefix.length - (from.prefix.length - column));
}

/**
 * The changes that make `edit` to `doc`, a drop's rewrite of a list or other
 * block, and where a position in `doc` goes through them. The lines the edit
 * touches are matched up by their text after the indentation and markers
 * (`LINE_PREFIX`, `lineKey`), with Myers' diff (`differingRuns`), and within
 * each run of lines that still differ by how alike they are (`pairLines`).
 * The part before the text of each matched line and its text change where
 * they differ, one run of characters at a time, as for a list item that only
 * gets a new number or an escape. Each run of lines put in or taken out
 * between matched lines is a change of its own. A position in a matched line
 * goes to the same place in the line it became (`columnIn`). Any other
 * position maps with the edit's `assoc`.
 */
export function dropEditChanges(doc: Text, { from, to, insert, assoc }: SourceEdit): { changes: ChangeSet; mapPos: (pos: number) => number } {
  const first = doc.lineAt(from);
  const end = doc.lineAt(to).to;
  const before = doc.sliceString(first.from, end).split("\n").map(splitLine);
  const after = (doc.sliceString(first.from, from) + insert + doc.sliceString(to, end)).split("\n").map(splitLine);
  // Where each line starts, in `doc` and in the changed text, and one more
  // past the end. Nothing before the first line changes.
  const starts = (lines: SourceLine[]): number[] => {
    const result = [first.from];
    for (const line of lines) result.push(result[result.length - 1] + line.prefix.length + line.text.length + 1);
    return result;
  };
  const startsA = starts(before);
  const startsB = starts(after);
  const linesB = (fromB: number, toB: number): string =>
    after
      .slice(fromB, toB)
      .map((line) => line.prefix + line.text)
      .join("\n");
  // The line of `after` each line of `before` became, or -1 for one taken
  // out or replaced.
  const matched = before.map(() => -1);
  const keysA = before.map(lineKey);
  const keysB = after.map(lineKey);
  let a = 0;
  let b = 0;
  for (const run of differingRuns(before.length, after.length, (i, j) => keysA[i] === keysB[j])) {
    for (; a < run.fromA; a += 1, b += 1) matched[a] = b;
    pairLines(keysA.slice(run.fromA, run.toA), keysB.slice(run.fromB, run.toB)).forEach((line, index) => {
      if (line >= 0) matched[run.fromA + index] = run.fromB + line;
    });
    a = run.toA;
    b = run.toB;
  }
  for (; a < before.length; a += 1, b += 1) matched[a] = b;

  const specs: Change[] = [];
  // Replace the lines of `before` from `fromA` up to `toA` with those of
  // `after` from `fromB` up to `toB`, with the line break before them, or at
  // the start with the one after them, so lines put in or taken out take a
  // line break along.
  const replace = (fromA: number, toA: number, fromB: number, toB: number): void => {
    if (fromA === toA && fromB === toB) return;
    const lines = linesB(fromB, toB);
    const [changeFrom, changeTo, text] =
      fromA > 0
        ? [startsA[fromA] - 1, startsA[toA] - 1, toB > fromB ? `\n${lines}` : ""]
        : toA < before.length
          ? [first.from, startsA[toA], toB > fromB ? `${lines}\n` : ""]
          : [first.from, end, lines];
    const part = changedRange(doc.sliceString(changeFrom, changeTo), text);
    specs.push({ from: changeFrom + part.from, to: changeFrom + part.to, insert: part.insert });
  };
  a = 0;
  b = 0;
  matched.forEach((line, index) => {
    if (line < 0) return;
    replace(a, index, b, line);
    const { prefix, text } = before[index];
    if (prefix !== after[line].prefix) specs.push({ from: startsA[index], to: startsA[index] + prefix.length, insert: after[line].prefix });
    const textFrom = startsA[index] + prefix.length;
    for (const change of textChanges(text, after[line].text)) specs.push({ from: textFrom + change.from, to: textFrom + change.to, insert: change.insert });
    a = index + 1;
    b = line + 1;
  });
  replace(a, before.length, b, after.length);
  const changes = ChangeSet.of(specs, doc.length);
  const mapPos = (pos: number): number => {
    const index = pos < first.from || pos > end ? -1 : doc.lineAt(pos).number - first.number;
    const line = index < 0 ? -1 : matched[index];
    if (line < 0) return changes.mapPos(pos, assoc);
    return startsB[line] + columnIn(before[index], after[line], pos - startsA[index]);
  };
  return { changes, mapPos };
}

export class RawEditor {
  private view: EditorView | null = null;
  /** The source content's explicit preference, separate from code exclusions. */
  private readonly spellcheck = new Compartment();
  /** Set while `setText` replaces the doc programmatically (split-view mirror
   *  sync, §6.1) so the resulting transaction doesn't echo back through onChange
   *  and clobber the pane that authored the change. */
  private applying = false;
  /** Pending `onFindChange` call, set while edits or selection moves have not
   *  paused yet. */
  private findChangeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The matches last counted, reused while the document and query stay the
   *  same, so a caret move or F3 does not walk the whole document again. */
  private counted: { doc: Text; query: SearchQuery; matches: Match[] } | null = null;
  /** The targets of drops on this pane whose files are not all in yet. Every
   *  change maps their positions, so each stays where its files were dropped,
   *  after the files of its drop already inserted. */
  private readonly dropTargets = new Set<DropTarget>();

  mount(root: HTMLElement, initial: string, cb: RawCallbacks, opts: RawOptions = {}): void {
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) for (const target of this.dropTargets) target.pos = u.changes.mapPos(target.pos, 1);
      if (u.docChanged && !this.applying) cb.onChange(u.state.doc.toString());
      // The current match is the selected one, so a caret move changes it too.
      if ((u.docChanged || u.selectionSet) && cb.onFindChange && getSearchQuery(u.state).search) {
        this.scheduleFindChange(cb.onFindChange);
      }
    });
    this.view = new EditorView({
      parent: root,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          markdownSource(),
          markdownSourceStyle(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "Markdown source editor" }),
          this.spellcheck.of(EditorView.contentAttributes.of({ spellcheck: "false" })),
          sourceCodeSpellcheck(),
          // Install CodeMirror's search state without exposing its own panel.
          // The app-level capture handler owns Ctrl+F/Ctrl+H and drives this
          // state through the find card; markdownSourceStyle paints the matches.
          search({ top: true }),
          ...(opts.collapseBase64 ? [base64Collapse()] : []),
          // Make non-hyphen dashes (em/en dash, …) unmistakable in the source: a
          // monospace font renders them almost identically to a hyphen (§5.3).
          specialDashHighlight(),
          // Put the cursor at a Shift+click from the document pane, at the
          // start of the line on a press on a line number, and at the end of
          // the text on a press on a gutter below the last line (§5.6).
          codeMirrorPresses({ endBelowText: true }),
          updateListener,
        ],
      }),
    });
  }

  getText(): string {
    return this.view ? this.view.state.doc.toString() : "";
  }

  /** Change prose spelling without rebuilding the editor or enabling code. */
  setSpellcheck(enabled: boolean): void {
    if (!this.view || this.view.contentDOM.getAttribute("spellcheck") === String(enabled)) return;
    this.view.dispatch({ effects: this.spellcheck.reconfigure(EditorView.contentAttributes.of({ spellcheck: String(enabled) })) });
  }

  /** Set the text to mirror an edit made in the other split pane (§6.1). Only
   *  the lines that differ are replaced, each run of them on its own, so the
   *  caret, the selection, the lines in view and the targets of drops keep
   *  their place outside them. The document pane's report can change several
   *  places at once, such as after Replace all, or when it writes the whole
   *  body in its own form. This pane can have focus meanwhile, for example
   *  when focus moves into it and the split catches it up first. The change is
   *  dispatched with `applying` set so it doesn't re-emit onChange. No-op when
   *  the text already matches. */
  setText(text: string): void {
    if (!this.view) return;
    const current = this.view.state.doc.toString();
    if (current === text) return;
    this.applying = true;
    try {
      this.view.dispatch({ changes: changedLines(current, text) });
    } finally {
      this.applying = false;
    }
  }

  /** Aim a file drop at the text position nearest a viewport point (§5.4),
   *  but never inside an image's base64 data (`dropOutsidePayload`). Returns
   *  the target for `insertText`, which the pane keeps in step with edits
   *  until `releaseDropTarget`, or null without an editor. */
  dropTargetAt(x: number, y: number): DropTarget | null {
    if (!this.view) return null;
    const { pos, newBlock } = dropOutsidePayload(this.view.state, this.view.posAtCoords({ x, y }, false));
    const target: DropTarget = newBlock ? { pos, newBlock } : { pos };
    this.dropTargets.add(target);
    return target;
  }

  /** Aim a file at the caret as a paragraph of its own after the block that
   *  holds the caret (`paragraphPlace`), for a file meant for the document
   *  view whose place there is gone. Unlike text put in at the caret, it never
   *  joins the line, a heading or the frontmatter there. Returns the target
   *  for `insertText`, which the pane keeps in step with edits until
   *  `releaseDropTarget`, or null without an editor. */
  blockTargetAtCaret(): DropTarget | null {
    if (!this.view) return null;
    const { state } = this.view;
    const target: DropTarget = { pos: paragraphPlace(state, state.selection.main.to), newBlock: true };
    this.dropTargets.add(target);
    return target;
  }

  /** Stop keeping a drop target in step, once the files of its drop are in. */
  releaseDropTarget(target: DropTarget): void {
    this.dropTargets.delete(target);
  }

  /** Insert text for a dropped file (§5.4) at the target of a drop on this
   *  pane, after any file of the same drop, or else at the caret. At the caret
   *  it goes in after any selection, such as the find card's current match,
   *  and never replaces it. A target that asks for a new block gets the text
   *  as a paragraph of its own before or after its line (`blankLinesAt`). The
   *  caret moves after the text, unless `moveCaret` is off, for a user who
   *  has moved on since the drop. Then the selection stays where it was,
   *  before text inserted at its end. Returns the target for the drop's next
   *  file, right after this one, which the pane keeps in step with edits
   *  until `releaseDropTarget`. For text that went in at the caret it is a
   *  new target, so the next file follows this one even while the caret
   *  stays before it. The text is an undo step of its own, never joined with
   *  typing right before or after it. Null without an editor. */
  insertText(text: string, target: DropTarget | null = null, moveCaret = true): DropTarget | null {
    if (!this.view || !text) return null;
    const aimed = target && this.dropTargets.has(target) ? target : null;
    const at = aimed ? aimed.pos : this.view.state.selection.main.to;
    const [before, after] = aimed?.newBlock ? blankLinesAt(this.view.state.doc, at) : ["", ""];
    const end = at + before.length + text.length;
    // Kept in step from the insert on, which moves it past the text.
    const next = aimed ?? { pos: at };
    this.dropTargets.add(next);
    this.view.dispatch({
      changes: { from: at, insert: before + text + after },
      ...(moveCaret ? { selection: { anchor: end } } : {}),
      annotations: isolateHistory.of("full"),
    });
    // The next file of the drop goes in after this one, in a block of its own.
    if (aimed?.newBlock) aimed.pos = end;
    return next;
  }

  /** Make the change that puts a file dropped on the document pane into
   *  this pane's text while the user types here in the split, or while the
   *  document pane is hidden behind the Markdown view (§5.4). It is reported
   *  and mirrored like typing, and undone as a step of its own, apart from
   *  the typing around it. The change is made line by line
   *  (`dropEditChanges`), so a caret in a line whose text stays keeps its
   *  place in that text, such as in a list item that only gets a new number,
   *  and follows it to its new line, such as at the start of the item the
   *  file goes in before. Any other caret right where text goes in stays on
   *  the side the change gives. */
  applyDropEdit(edit: SourceEdit): void {
    if (!this.view) return;
    const { state } = this.view;
    const { changes, mapPos } = dropEditChanges(state.doc, edit);
    const ranges = state.selection.ranges.map((range) => EditorSelection.range(mapPos(range.anchor), mapPos(range.head)));
    this.view.dispatch({
      changes,
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      annotations: isolateHistory.of("full"),
    });
  }

  /**
   * Drive CodeMirror's search state from the application's find card. When no
   * match is selected, select the first one, unless `selectFirst` is false.
   * With `selectFirst`, the selected match is then scrolled clear of the card.
   */
  searchText(query: string, opts: FindOptions, replacement = "", selectFirst = true): FindCounts {
    const view = this.view;
    if (!view) return { current: 0, total: 0 };
    const searchQuery = new SearchQuery({
      search: query,
      caseSensitive: opts.caseSensitive,
      wholeWord: opts.wholeWord,
      regexp: opts.regex,
      replace: replacement,
      test: outsideImageData,
    });
    view.dispatch({ effects: setSearchQuery.of(searchQuery) });
    if (!query || !searchQuery.valid) return { current: 0, total: 0 };

    const matches = this.matches(searchQuery);
    if (!matches.length) return { current: 0, total: 0 };
    const selection = view.state.selection.main;
    let current = matches.findIndex(
      ({ from, to }) => selection.from === from && selection.to === to,
    );
    if (current < 0) {
      if (!selectFirst) return { current: 0, total: matches.length };
      current = 0;
      const first = matches[0];
      view.dispatch({
        selection: { anchor: first.from, head: first.to },
        scrollIntoView: true,
      });
    }
    if (selectFirst) this.revealSelection();
    return { current: current + 1, total: matches.length };
  }

  findNext(): FindCounts {
    if (!this.view) return { current: 0, total: 0 };
    findNextMatch(this.view);
    return this.revealedCounts();
  }

  findPrev(): FindCounts {
    if (!this.view) return { current: 0, total: 0 };
    findPreviousMatch(this.view);
    return this.revealedCounts();
  }

  /**
   * Replace the selected match and select the next one. With no match
   * selected, only select the next match after the caret, so the user sees
   * what the next Replace changes.
   */
  replaceCurrent(replacement: string, query: string, opts: FindOptions): FindCounts {
    if (!this.view) return { current: 0, total: 0 };
    if (!this.searchText(query, opts, replacement, false).total) return { current: 0, total: 0 };
    // CodeMirror replaces a selected match and advances, or only selects the
    // next match when the selection does not cover one.
    replaceNextMatch(this.view);
    return this.revealedCounts();
  }

  replaceAll(replacement: string, query: string, opts: FindOptions): FindCounts {
    if (!this.view) return { current: 0, total: 0 };
    this.searchText(query, opts, replacement);
    replaceAllMatches(this.view);
    return this.searchText(query, opts, replacement);
  }

  clearSearch(): void {
    if (!this.view) return;
    this.counted = null;
    this.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
  }

  private matches(query: SearchQuery): Match[] {
    if (!this.view || !query.valid) return [];
    const { doc } = this.view.state;
    if (this.counted?.doc === doc && this.counted.query.eq(query)) return this.counted.matches;
    const matches: Match[] = [];
    const cursor = query.getCursor(this.view.state);
    for (let result = cursor.next(); !result.done; result = cursor.next()) {
      matches.push(result.value);
    }
    this.counted = { doc, query, matches };
    return matches;
  }

  /** The match the selection covers (0 when none) and the total. */
  currentCounts(): FindCounts {
    if (!this.view) return { current: 0, total: 0 };
    const query = getSearchQuery(this.view.state);
    const matches = this.matches(query);
    const selection = this.view.state.selection.main;
    const current = matches.findIndex(
      ({ from, to }) => selection.from === from && selection.to === to,
    );
    return { current: current < 0 ? 0 : current + 1, total: matches.length };
  }

  /** The current match and total, with the current match scrolled clear of
   *  the find card. */
  private revealedCounts(): FindCounts {
    const counts = this.currentCounts();
    if (counts.current) this.revealSelection();
    return counts;
  }

  /**
   * Scroll the selected match clear of the find card, which CodeMirror knows
   * nothing of (`revealSpan`). CodeMirror scrolls to the match in its next
   * frame. It asked for that frame first, so this runs after it, before the
   * page is painted.
   */
  private revealSelection(): void {
    requestAnimationFrame(() => {
      const view = this.view;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const span = codeMirrorSpan(view, from, to);
      if (span) revealSpan(view.scrollDOM, span);
    });
  }

  /** Call `notify` once changes pause, restarting the wait on every change. */
  private scheduleFindChange(notify: () => void): void {
    if (this.findChangeTimer != null) clearTimeout(this.findChangeTimer);
    this.findChangeTimer = setTimeout(() => {
      this.findChangeTimer = null;
      notify();
    }, FIND_RECOUNT_DELAY_MS);
  }

  focus(): void {
    this.view?.focus();
  }

  /** Re-show after being hidden (display:none) on a tab/view switch, or after a
   *  split resize. CodeMirror caches viewport measurements, so it must be told to
   *  re-measure or it renders with stale/zero height and a misplaced cursor. Pass
   *  `focus=false` for the split mirror pane so it doesn't steal focus from the
   *  document editor (§6.1). */
  onShow(focus = true): void {
    this.view?.requestMeasure();
    if (focus) this.view?.focus();
  }

  destroy(): void {
    if (this.findChangeTimer != null) clearTimeout(this.findChangeTimer);
    this.findChangeTimer = null;
    this.counted = null;
    this.dropTargets.clear();
    this.view?.destroy();
    this.view = null;
  }
}
