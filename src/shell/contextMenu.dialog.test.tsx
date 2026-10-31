// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogPortal, DialogTitle } from "../components/ui/dialog";
import { closeContextMenu, isContextMenuOpen, showContextMenu } from "./contextMenu";

afterEach(() => {
  closeContextMenu();
  cleanup();
});

it.each([false, true])("keeps menus inside the focused dialog, including nested dialogs (%s)", async (nested) => {
  const close = vi.fn();
  const run = vi.fn();
  const fields = <><input aria-label="Word" /><input aria-label="Another word" /></>;
  render(
    <Dialog open onOpenChange={close}>
      <DialogPortal>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Settings</DialogTitle>
          {nested ? (
            <Dialog open onOpenChange={close}>
              <DialogPortal>
                <DialogContent aria-describedby={undefined}>
                  <DialogTitle>Dictionary</DialogTitle>
                  {fields}
                </DialogContent>
              </DialogPortal>
            </Dialog>
          ) : fields}
        </DialogContent>
      </DialogPortal>
    </Dialog>,
  );
  const field = screen.getByRole("textbox", { name: "Word" });
  act(() => field.focus());
  const openMenu = (): void => {
    act(() => showContextMenu(10, 20, [{ label: "Choose", run }], "Edit"));
  };
  openMenu();
  const menu = screen.getByRole("menu", { name: "Edit" });
  expect(menu.closest('[role="dialog"]')).toBe(field.closest('[role="dialog"]'));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Choose" })));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(isContextMenuOpen()).toBe(false);
  expect(close).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(field);

  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Choose" }));
  expect(run).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(field);

  openMenu();
  const other = screen.getByRole("textbox", { name: "Another word" });
  act(() => other.focus());
  expect(isContextMenuOpen()).toBe(false);
  expect(document.activeElement).toBe(other);
});
