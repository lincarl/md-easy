import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { DesktopCommandArgs, DesktopCommandResults, DesktopEventPayloads, ElectronBridge } from "../src/ipc/bridge";

const commands = new Set<keyof DesktopCommandArgs>([
  "read_file", "write_file", "path_exists", "watch_file", "unwatch_file", "ensure_attachments_dir", "write_attachment",
  "read_image_bytes", "get_recent_files", "record_file_opened", "remove_recent", "set_favorite", "stat_files",
  "search_recent_contents", "cancel_search", "write_snapshot", "delete_snapshot", "list_recovery_snapshots",
  "load_session", "save_session", "get_launch_args", "get_default_md_handler", "open_default_apps_settings", "get_system_accent_color",
  "load_settings", "save_settings", "settings_path", "list_printers", "print_webview", "print_webview_to_pdf",
  "update_info", "check_for_updates", "restart_to_update",
  "get_spellcheck_info", "list_dictionary_words", "add_dictionary_word", "remove_dictionary_word",
  "spelling_menu_action",
]);
const events = new Set<keyof DesktopEventPayloads>([
  "settings-changed", "file-changed", "open-file-requested", "print-completed", "search-result", "close-requested",
  "history-requested", "update-changed",
  "spelling-context-menu",
]);
let closeListeners = 0;
let openListeners = 0;

const bridge: ElectronBridge = {
  platform: process.platform,
  invoke<K extends keyof DesktopCommandArgs>(command: K, args?: DesktopCommandArgs[K]): Promise<DesktopCommandResults[K]> {
    if (!commands.has(command)) return Promise.reject(new Error("Unknown desktop command."));
    return ipcRenderer.invoke("downpad:invoke", command, args) as Promise<DesktopCommandResults[K]>;
  },
  listen<K extends keyof DesktopEventPayloads>(event: K, handler: (payload: DesktopEventPayloads[K]) => void): () => void {
    if (!events.has(event)) throw new Error("Unknown desktop event.");
    const channel = `downpad:event:${event}`;
    const listener = (_event: IpcRendererEvent, payload: DesktopEventPayloads[K]): void => handler(payload);
    ipcRenderer.on(channel, listener);
    if (event === "close-requested" && ++closeListeners === 1) ipcRenderer.send("downpad:close-listener", true);
    if (event === "open-file-requested" && ++openListeners === 1) ipcRenderer.send("downpad:open-listener", true);
    let listening = true;
    return () => {
      if (!listening) return;
      listening = false;
      ipcRenderer.removeListener(channel, listener);
      if (event === "close-requested" && --closeListeners === 0) ipcRenderer.send("downpad:close-listener", false);
      if (event === "open-file-requested" && --openListeners === 0) ipcRenderer.send("downpad:open-listener", false);
    };
  },
  openDialog: (options) => ipcRenderer.invoke("downpad:dialog-open", options),
  saveDialog: (options) => ipcRenderer.invoke("downpad:dialog-save", options),
  ask: (message, options) => ipcRenderer.invoke("downpad:dialog-ask", message, options),
  async confirmSaveChanges(message) {
    const choice: unknown = await ipcRenderer.invoke("downpad:dialog-confirm-save-changes", message);
    return choice === "save" || choice === "discard" ? choice : "cancel";
  },
  openExternal: (url) => ipcRenderer.invoke("downpad:open-external", url),
  revealItemInFolder: (path) => ipcRenderer.invoke("downpad:reveal-item", path),
  setTheme: (theme) => ipcRenderer.invoke("downpad:set-theme", theme),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  convertFileSrc: (path) => ipcRenderer.invoke("downpad:image-url", path),
  closeWindow: () => ipcRenderer.invoke("downpad:close-window"),
  cancelWindowClose: () => ipcRenderer.invoke("downpad:cancel-window-close"),
};

contextBridge.exposeInMainWorld("downpadDesktop", Object.freeze(bridge));
