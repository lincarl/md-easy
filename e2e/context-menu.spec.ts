import { test, expect } from "@playwright/test";

// The custom right-click menu (spec §5.14 / §6.1, shell/documentContextMenu):
// Downpad's own menu replaces the native WebView one everywhere, carries a single
// Print entry, and steps aside for Shift+right-click so Electron's spell-check
// suggestions stay reachable.

const wysiwyg = ".milkdown .ProseMirror";
const menu = ".md-context-menu";

test("right-clicking the document opens the custom menu with the editing commands", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to Downpad");

  await page.locator(`${wysiwyg} h1`).click({ button: "right" });
  await expect(page.locator(menu)).toBeVisible();
  await expect(page.locator(`${menu} .md-context-menu-label`)).toHaveText([
    "Cut",
    "Copy",
    "Paste",
    "Paste as plain text",
    "Insert link…",
    "Select all",
    "Copy as Markdown",
    "Print…",
  ]);
  // One Print entry, with its shortcut hint — the Document/Markdown choice is
  // made in the print workspace, not here.
  const print = page.locator(`${menu} .md-context-menu-item`, { hasText: "Print…" });
  await expect(print.locator(".md-context-menu-key")).toHaveText("Ctrl+P");
});

test("Escape closes the menu", async ({ page }) => {
  await page.goto("/");
  await page.locator(`${wysiwyg}`).click({ button: "right" });
  await expect(page.locator(menu)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(menu)).toHaveCount(0);
});

test("a Settings field keeps its editing menu inside the dialog", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
  const font = settings.getByRole("textbox", { name: "Body font:" });
  await font.fill("Georgia");
  await font.click({ button: "right" });
  const editMenu = settings.getByRole("menu", { name: "Edit", exact: true });
  await expect(editMenu).toBeVisible();
  await editMenu.getByRole("menuitem", { name: "Select all", exact: true }).click();
  await expect(font).toBeFocused();
  expect(await font.evaluate((element) => [
    (element as HTMLInputElement).selectionStart,
    (element as HTMLInputElement).selectionEnd,
  ])).toEqual([0, "Georgia".length]);
  await font.click({ button: "right" });
  await expect(editMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editMenu).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(font).toBeFocused();
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 800, height: 600 }]) {
  test(`accent picker editing menus stay at the pointer and inside a ${viewport.width}×${viewport.height} window`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
    await settings.getByRole("button", { name: "Choose custom accent color" }).click();
    const hex = page.getByRole("textbox", { name: "Accent color hex" });
    await hex.fill("#aabbcc");
    const field = (await hex.boundingBox())!;
    const point = { x: field.x + field.width / 2, y: field.y + field.height / 2 };
    await page.mouse.click(point.x, point.y, { button: "right" });
    const editMenu = page.getByRole("menu", { name: "Edit", exact: true });
    await expect(editMenu).toBeVisible();
    const box = (await editMenu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    // At an edge the menu moves back into the window while still touching the pointer.
    expect(box.x).toBeLessThanOrEqual(point.x + 1);
    expect(box.y).toBeLessThanOrEqual(point.y + 1);
    expect(box.x + box.width).toBeGreaterThan(point.x);
    expect(box.y + box.height).toBeGreaterThan(point.y);
    await editMenu.getByRole("menuitem", { name: "Select all", exact: true }).click();
    await expect(hex).toBeFocused();
    expect(await hex.evaluate((element) => [
      (element as HTMLInputElement).selectionStart,
      (element as HTMLInputElement).selectionEnd,
    ])).toEqual([0, 7]);
    await hex.click({ button: "right" });
    await expect(editMenu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editMenu).toHaveCount(0);
    await expect(hex).toBeFocused();
    await expect(settings).toBeVisible();
  });
}

test("Shift+right-click leaves the native menu to Electron (spell check, §5.14)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to Downpad");

  const prevented = await page.evaluate(() => {
    const el = document.querySelector(".milkdown .ProseMirror")!;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, shiftKey: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(page.locator(menu)).toHaveCount(0);
});

test("Print in the menu opens the print workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(`${wysiwyg} h1`)).toContainText("Welcome to Downpad");

  await page.locator(`${wysiwyg} h1`).click({ button: "right" });
  await page.locator(`${menu} .md-context-menu-item`, { hasText: "Print…" }).click();
  await expect(page.locator(".print-workspace")).toBeVisible();
  await expect(page.locator(".print-page").first()).toBeVisible();
});
