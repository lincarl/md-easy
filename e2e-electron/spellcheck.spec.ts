import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {} from "../src/ipc/bridge";

const root = path.resolve(import.meta.dirname, "..");
let directory: string;
let app: ElectronApplication | undefined;
let page: Page;

test.beforeEach(async () => {
  await mkdir(path.join(root, "dev-temp", "electron-spelling"), { recursive: true });
  directory = await mkdtemp(path.join(root, "dev-temp", "electron-spelling", "run-"));
  await mkdir(path.join(directory, "profile"));
  await writeFile(path.join(directory, "profile", "settings.toml"),
    'hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nspellCheckLanguages = ["en-US"]\n');
});

test.afterEach(async () => { await close(); });

/** Launch the real app with a disposable profile and wait for its ready state. */
async function launch(markdown?: string): Promise<void> {
  const file = path.join(directory, "spelling.md");
  if (markdown !== undefined) await writeFile(file, markdown);
  const environment = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !["ELECTRON_RUN_AS_NODE", "DOWNPAD_DEV_URL"].includes(entry[0]),
  ));
  const executablePath = process.env.DOWNPAD_EXECUTABLE;
  app = await electron.launch({
    chromiumSandbox: true, executablePath, cwd: root,
    args: [...(executablePath ? [] : [path.join(root, "electron-dist", "main.js")]), file],
    env: { ...environment, DOWNPAD_USER_DATA_DIR: path.join(directory, "profile") },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-started", "true");
}

/** Close only this test's app, discarding any edits to its synthetic document. */
async function close(): Promise<void> {
  if (!app) return;
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); });
  await app.close();
  app = undefined;
}

/** Open the spelling page through the user interface. */
async function spellingSettings(): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("tab", { name: "Spelling", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Manage dictionary…" })).toBeVisible();
  return dialog;
}

/** Locate a word even when syntax highlighting splits the line. */
async function wordPoint(container: Locator, word: string): Promise<{ x: number; y: number }> {
  await container.scrollIntoViewIfNeeded();
  return container.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const from = node.textContent?.indexOf(text) ?? -1;
      if (from < 0) continue;
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, from + text.length);
      const box = range.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    throw new Error(`Word not found: ${text}`);
  }, word);
}

/** Right-click the middle of a word. */
async function wordMenu(container: Locator, word: string): Promise<Locator> {
  await page.keyboard.press("Escape");
  const point = await wordPoint(container, word);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "Edit", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

/** Wait for the downloaded dictionary to flag actual document text. */
async function misspellingMenu(container: Locator, word: string): Promise<Locator> {
  await expect.poll(async () => {
    // Startup's scripted autofocus does not start the native scan. Repeat a
    // real focus transition while a first-use dictionary may still download.
    await page.getByRole("button", { name: "Settings", exact: true }).focus();
    const point = await wordPoint(container, word);
    await page.mouse.click(point.x, point.y);
    const menu = await wordMenu(container, word);
    return menu.getByRole("menuitem", { name: "Add to dictionary", exact: true }).count();
  }, { timeout: 30_000, message: "The native spelling dictionary must load and flag the misspelling." }).toBe(1);
  return page.getByRole("menu", { name: "Edit", exact: true });
}

test("spelling languages save together, survive restart, and respond to external settings changes", async () => {
  test.skip(process.platform === "darwin", "macOS owns spelling language selection.");
  await launch("# Language notes\n\nA spelling example.\n");
  let dialog = await spellingSettings();
  await dialog.getByRole("searchbox", { name: "Find a language" }).fill("Swedish");
  await dialog.getByRole("checkbox", { name: "Swedish", exact: true }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.downpadDesktop!.invoke("get_spellcheck_info")))
    .toMatchObject({ activeLanguages: ["en-US", "sv"] });
  expect(await readFile(path.join(directory, "profile", "settings.toml"), "utf8")).toContain('spellCheckLanguages = ["en-US","sv"]');
  await close();
  await launch();
  expect(await page.evaluate(() => window.downpadDesktop!.invoke("get_spellcheck_info")))
    .toMatchObject({ activeLanguages: ["en-US", "sv"] });
  dialog = await spellingSettings();
  await dialog.getByRole("checkbox", { name: "Use system languages", exact: true }).check();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => window.downpadDesktop!.invoke("get_spellcheck_info")))
    .toMatchObject({ activeLanguages: ["en-US", "sv"] });

  await writeFile(path.join(directory, "profile", "settings.toml"),
    'hasSeenWelcome = true\nhasCheckedDefaultHandler = true\nspellCheckEnabled = false\nspellCheckLanguages = ["en-GB"]\n');
  await expect.poll(() => page.evaluate(() => window.downpadDesktop!.invoke("get_spellcheck_info")))
    .toMatchObject({ activeLanguages: ["en-GB"] });
  expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.session.spellCheckerEnabled)).toBe(false);
  dialog = await spellingSettings();
  await expect(dialog.getByRole("checkbox", { name: "Spell check", exact: true })).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: "Spell check", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "Use system languages", exact: true }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const info = await page.evaluate(() => window.downpadDesktop!.invoke("get_spellcheck_info"));
  expect(info.activeLanguages).toEqual(info.systemLanguages);
});

test("normal spelling corrections preserve formatting, source, undo and zoomed menu targeting", async () => {
  await launch("# Spelling notes\n\nA **speling** example.\n");
  await page.getByRole("radio", { name: "Split", exact: true }).click();
  const strong = page.locator(".milkdown .ProseMirror strong");
  const source = page.locator(".editor-pane-raw .cm-content");
  await misspellingMenu(strong, "speling");
  await page.keyboard.press("Escape");
  // The clicked document must be corrected even when the source pane had focus.
  await source.click();
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.5));
  const menu = await wordMenu(strong, "speling");
  await menu.getByRole("menuitem", { name: "spelling", exact: true }).click();
  await expect(strong).toHaveText("spelling");
  await expect(source).toContainText("**spelling**");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(path.join(directory, "spelling.md"), "utf8")).toContain("**spelling**");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(strong).toHaveText("speling");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(strong).toHaveText("spelling");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("custom spelling words persist and can be removed through Settings", async () => {
  // Electron also changes the OS dictionary on Windows/macOS. Profiles cannot isolate it.
  test.skip(process.platform !== "linux", "Custom dictionary mutation requires an isolated OS account outside Linux.");
  await launch("# Dictionary notes\n\nA zorblaxquendrel example.\n");
  let paragraph = page.locator(".milkdown .ProseMirror p").first();
  const menu = await misspellingMenu(paragraph, "zorblaxquendrel");
  await menu.getByRole("menuitem", { name: "Add to dictionary", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.downpadDesktop!.invoke("list_dictionary_words"))).toContain("zorblaxquendrel");
  await expect((await wordMenu(paragraph, "zorblaxquendrel")).getByRole("menuitem", { name: "Add to dictionary" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await close();
  await launch();
  const settings = await spellingSettings();
  await settings.getByRole("button", { name: "Manage dictionary…" }).click();
  const dictionary = page.getByRole("dialog", { name: "Custom dictionary", exact: true });
  await dictionary.getByRole("button", { name: "Remove zorblaxquendrel", exact: true }).click();
  await expect(dictionary.getByText("No custom words yet.", { exact: true })).toBeVisible();
  await dictionary.getByRole("textbox", { name: "New word", exact: true }).fill("snorblaxquendrel");
  await dictionary.getByRole("button", { name: "Add word", exact: true }).click();
  await expect(dictionary.getByRole("button", { name: "Remove snorblaxquendrel" })).toBeVisible();
  await dictionary.getByRole("button", { name: "Done", exact: true }).click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => window.downpadDesktop!.invoke("list_dictionary_words"))).toEqual(["snorblaxquendrel"]);
  paragraph = page.locator(".milkdown .ProseMirror p").first();
  await misspellingMenu(paragraph, "zorblaxquendrel");
});

test("spelling checks prose while excluding inline and fenced code in both editors", async () => {
  await launch("# Spelling notes\n\nA speling example with `inlinezorblax`.\n\n```text\nfencedzorblax\n```\n");
  const document = page.locator(".milkdown .ProseMirror");
  await misspellingMenu(document.locator("p").first(), "speling");
  await expect((await wordMenu(document.locator("p code"), "inlinezorblax")).getByRole("menuitem", { name: "Add to dictionary" })).toHaveCount(0);
  await expect((await wordMenu(document.locator(".cm-content"), "fencedzorblax")).getByRole("menuitem", { name: "Add to dictionary" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: "Markdown", exact: true }).click();
  const source = page.locator(".editor-pane-raw .cm-content");
  await expect(source).toHaveAttribute("spellcheck", "true");
  // CodeMirror places its caret through script. A real edit starts Chromium's
  // spelling scan even when the editor already held programmatic focus.
  await source.locator(".cm-line", { hasText: "A speling example" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Space");
  await misspellingMenu(source, "speling");
  await expect((await wordMenu(source, "inlinezorblax")).getByRole("menuitem", { name: "Add to dictionary" })).toHaveCount(0);
  await expect((await wordMenu(source, "fencedzorblax")).getByRole("menuitem", { name: "Add to dictionary" })).toHaveCount(0);
  const correction = await misspellingMenu(source, "speling");
  await correction.getByRole("menuitem", { name: "spelling", exact: true }).click();
  await expect(source).toContainText("A spelling example");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(source).toContainText("A speling example");

  // New syntax receives exclusions without a view rebuild or settings change.
  await source.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\nA `newinlinezorblax` example.\n\n```text\nnewfencedzorblax\n```\n");
  await expect((await wordMenu(source, "newinlinezorblax")).getByRole("menuitem", { name: "Add to dictionary" })).toHaveCount(0);
  await expect((await wordMenu(source, "newfencedzorblax")).getByRole("menuitem", { name: "Add to dictionary" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const settings = await spellingSettings();
  await settings.getByRole("checkbox", { name: "Spell check", exact: true }).uncheck();
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(source).toHaveAttribute("spellcheck", "false");
  await expect((await wordMenu(source, "speling")).getByRole("menuitem", { name: "Add to dictionary" })).toHaveCount(0);
});

test("changing documents dismisses spelling choices and rejects their stale native context", async () => {
  await launch("A speling example.\n");
  await page.evaluate(() => {
    window.downpadDesktop!.listen("spelling-context-menu", (context) => Reflect.set(window, "lastSpellingContext", context.id));
  });
  const paragraph = page.locator(".milkdown .ProseMirror p").first();
  await misspellingMenu(paragraph, "speling");
  const contextId = await page.evaluate(() => Reflect.get(window, "lastSpellingContext") as number);
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("menu", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Untitled" })).toBeVisible();
  const error = await page.evaluate(async (id) => {
    try {
      await window.downpadDesktop!.invoke("spelling_menu_action", { contextId: id, action: "replace", suggestion: "spelling" });
      return "unexpected success";
    } catch (error) {
      return String(error);
    }
  }, contextId);
  expect(error).toContain("This spelling menu has closed.");
  expect(await readFile(path.join(directory, "spelling.md"), "utf8")).toBe("A speling example.\n");
});

test("native editing menus work inside Settings and its nested dictionary dialog", async () => {
  await launch("A spelling example.\n");
  const settings = await spellingSettings();
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
  const font = settings.getByRole("textbox", { name: "Body font:" });
  await font.fill("Georgia");

  /** Exercise pointer targeting and Escape within the field's own modal. */
  const checkMenu = async (field: Locator, dialog: Locator, text: string): Promise<void> => {
    await field.click({ button: "right" });
    const menu = dialog.getByRole("menu", { name: "Edit", exact: true });
    await expect(menu).toBeVisible();
    const fieldBox = (await field.boundingBox())!;
    const menuBox = (await menu.boundingBox())!;
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
    expect(menuBox.x).toBeLessThanOrEqual(fieldBox.x + fieldBox.width / 2 + 1);
    expect(menuBox.y).toBeLessThanOrEqual(fieldBox.y + fieldBox.height / 2 + 1);
    expect(menuBox.x + menuBox.width).toBeGreaterThan(fieldBox.x + fieldBox.width / 2);
    expect(menuBox.y + menuBox.height).toBeGreaterThan(fieldBox.y + fieldBox.height / 2);
    await menu.getByRole("menuitem", { name: "Select all", exact: true }).click();
    await expect(field).toBeFocused();
    expect(await field.evaluate((element) => [
      (element as HTMLInputElement).selectionStart,
      (element as HTMLInputElement).selectionEnd,
    ])).toEqual([0, text.length]);
    await field.click({ button: "right" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(field).toBeFocused();
  };

  await checkMenu(font, settings, "Georgia");
  await settings.getByRole("checkbox", { name: "Use the system accent color" }).uncheck();
  await settings.getByRole("button", { name: "Choose custom accent color" }).click();
  const accent = page.getByRole("textbox", { name: "Accent color hex" });
  await accent.fill("#aabbcc");
  await checkMenu(accent, page.locator(".accent-popover"), "#aabbcc");
  await page.keyboard.press("Escape");
  await settings.getByRole("tab", { name: "Spelling", exact: true }).click();
  await settings.getByRole("button", { name: "Manage dictionary…" }).click();
  const dictionary = page.getByRole("dialog", { name: "Custom dictionary", exact: true });
  const word = dictionary.getByRole("textbox", { name: "New word", exact: true });
  await word.fill("zorblaxquendrel");
  await checkMenu(word, dictionary, "zorblaxquendrel");
  await dictionary.getByRole("button", { name: "Done", exact: true }).click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => window.downpadDesktop!.invoke("list_dictionary_words"))).toEqual([]);
});
