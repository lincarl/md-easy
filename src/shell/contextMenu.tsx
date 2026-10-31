import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { cn } from "@/lib/utils";
import { disposeReactRoot } from "@/app/disposeReactRoot";
import { MenuRows, menuSurfaceClassName, moveMenuFocus, type MenuItem } from "@/components/ui/menu";

export type { MenuItem };

interface ActiveMenu {
  host: HTMLDivElement;
  root: Root;
  menu: HTMLElement;
  restoreFocus: HTMLElement | null;
  onDismiss?: () => void;
}

let active: ActiveMenu | null = null;
let listenerTimer: ReturnType<typeof setTimeout> | null = null;

export function closeContextMenu(): void {
  closeActiveMenu(true);
}

function closeActiveMenu(restoreFocus: boolean, activated = false): void {
  if (listenerTimer) clearTimeout(listenerTimer);
  listenerTimer = null;
  document.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("keydown", onKeyDown, true);
  document.removeEventListener("focusin", onFocusIn);
  window.removeEventListener("blur", closeContextMenu);
  const current = active;
  active = null;
  if (!current) return;
  disposeReactRoot(current.root, current.host);
  if (restoreFocus && current.restoreFocus?.isConnected) current.restoreFocus.focus();
  if (!activated) current.onDismiss?.();
}

export function isContextMenuOpen(): boolean {
  return active !== null;
}

function onPointerDown(event: Event): void {
  if (active && !active.menu.contains(event.target as Node)) closeContextMenu();
}

/** A shortcut can move to another editor without an outside pointer click. */
function onFocusIn(event: FocusEvent): void {
  if (active && !active.menu.contains(event.target as Node)) closeActiveMenu(false);
}

function onKeyDown(event: KeyboardEvent): void {
  if (!active) return;
  // Escape closes the menu. So does Tab: a context menu has no button in the
  // tab order, so focus returns to where the menu was opened.
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    closeContextMenu();
    return;
  }
  if (!moveMenuFocus(active.menu, event.key)) return;
  event.preventDefault();
  event.stopPropagation();
}

/** Open a menu of `items` at the pointer position, named `label` for screen
 *  readers, such as "Tab". It replaces any menu that is already open. */
export function showContextMenu(x: number, y: number, items: MenuItem[], label: string, onDismiss?: () => void): void {
  const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closeActiveMenu(false);
  const host = document.createElement("div");
  host.dataset.reactContextMenu = "";
  // Radix keeps focus within the active dialog. Its context menu belongs in
  // that same scope, including a nested dialog such as the custom dictionary.
  const container = restoreFocus?.closest('[role="dialog"]') ?? document.body;
  container.append(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(<ContextMenu items={items} label={label} />);
  });
  const menu = host.querySelector<HTMLElement>(".md-context-menu");
  if (!menu) {
    disposeReactRoot(root, host);
    return;
  }
  active = { host, root, menu, restoreFocus, onDismiss };
  // Measure at the local origin. A translated popover establishes its own
  // containing block for fixed children, but the pointer and limits use the viewport.
  const rect = menu.getBoundingClientRect();
  const left = Math.max(0, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(0, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = `${left - rect.left}px`;
  menu.style.top = `${top - rect.top}px`;
  // Handle Escape before a dialog's document-level handler can close it. Only
  // the outside-pointer listener is delayed so the opening right-click cannot
  // immediately close its own menu.
  window.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("focusin", onFocusIn);
  window.addEventListener("blur", closeContextMenu);
  menu.querySelector<HTMLButtonElement>(".md-context-menu-item:not(.disabled)")?.focus();
  listenerTimer = setTimeout(() => {
    listenerTimer = null;
    if (active?.menu !== menu) return;
    document.addEventListener("pointerdown", onPointerDown, true);
  }, 0);
}

/** The menu is measured at its local origin before placement. Choosing a row
 *  closes the menu before the row's command runs. */
function ContextMenu({ items, label }: { items: MenuItem[]; label: string }) {
  return (
    <div
      className={cn("md-context-menu fixed z-[1100] w-max", menuSurfaceClassName)}
      role="menu"
      aria-label={label}
      style={{ left: 0, top: 0 }}
    >
      <MenuRows
        items={items}
        onActivate={(item) => {
          closeActiveMenu(true, true);
          void item.run();
        }}
      />
    </div>
  );
}
