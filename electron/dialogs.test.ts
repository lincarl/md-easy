import { contextBridge, ipcRenderer, webUtils, type IpcMainInvokeEvent, type MessageBoxOptions } from "electron";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronBridge } from "../src/ipc/bridge";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const native = vi.hoisted(() => {
  const window = {
    webContents: {
      mainFrame: { url: "" },
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        availableSpellCheckerLanguages: ["en-US"],
        getSpellCheckerLanguages: vi.fn(() => ["en-US"]),
        setSpellCheckerLanguages: vi.fn(),
        setSpellCheckerEnabled: vi.fn(),
        listWordsInSpellCheckerDictionary: vi.fn(async () => []),
        addWordToSpellCheckerDictionary: vi.fn(() => true),
        removeWordFromSpellCheckerDictionary: vi.fn(() => true),
      },
    },
    on: vi.fn(),
    once: vi.fn(),
    loadFile: vi.fn(async () => {}),
  };
  return {
    window,
    handlers: new Map<string, Handler>(),
    showMessageBox: vi.fn<(window: unknown, options: MessageBoxOptions) => Promise<{ response: unknown }>>(),
    showErrorBox: vi.fn(),
    exposeInMainWorld: vi.fn<(name: string, bridge: ElectronBridge) => void>(),
    invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  };
});

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    setName: vi.fn(),
    getPath: () => "dev-temp/document-preferences/dialog-ipc",
    getVersion: () => "0.0.0",
    getPreferredSystemLanguages: () => ["en-US"],
    on: vi.fn(),
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    exit: vi.fn(),
  },
  BrowserWindow: class { constructor() { return native.window; } },
  dialog: { showMessageBox: native.showMessageBox, showErrorBox: native.showErrorBox },
  ipcMain: { handle: (channel: string, handler: Handler) => native.handlers.set(channel, handler), on: vi.fn() },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  nativeTheme: {},
  net: {},
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  screen: {},
  shell: {},
  systemPreferences: {},
  contextBridge: { exposeInMainWorld: native.exposeInMainWorld },
  ipcRenderer: { invoke: native.invoke },
  webUtils: {},
}));

// Start the real IPC registration without accessing a profile, watching files,
// checking for updates, or creating an operating-system window.
vi.mock("./storage", () => ({
  adoptLegacyData: () => false,
  ConfigStore: class {
    directory = "dev-temp/document-preferences/dialog-ipc";
    settingsPath = "dev-temp/document-preferences/dialog-ipc/settings.toml";
    async initialize() {}
    async settings() { return { ...DEFAULT_SETTINGS, autoUpdate: false }; }
  },
  RecentSearch: class {},
}));
vi.mock("./updateInstall", () => ({ installedPackageKind: async () => null }));
vi.mock("./updater", () => ({
  Updater: class {
    async start() { return { pending: null, failure: null }; }
    async checkIfDue() {}
  },
}));
vi.mock("./printing", () => ({ PrintService: class {} }));
vi.mock("./watchers", () => ({ watchPath: () => () => {} }));

/** Supply the same sender and main frame that the app's trust check requires. */
function trustedEvent(): IpcMainInvokeEvent {
  return { sender: native.window.webContents, senderFrame: native.window.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
}

/** Invoke the real registered handler through the mocked Electron transport. */
async function invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
  const handler = native.handlers.get(channel);
  if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
  return handler(event, ...args);
}

let bridge: ElectronBridge;

beforeAll(async () => {
  vi.stubEnv("DOWNPAD_USER_DATA_DIR", "");
  native.window.webContents.mainFrame.url = new URL("../dist/index.html", import.meta.url).href;
  await import("./main");
  await vi.waitFor(() => expect(native.window.loadFile).toHaveBeenCalledOnce());
  expect(native.showErrorBox).not.toHaveBeenCalled();
  // Bundle the CommonJS preload just as the desktop build does. Vite does not
  // transform .cts imports, and this also exercises the sandbox entry point.
  const preload = await build({
    entryPoints: [fileURLToPath(new URL("./preload.cts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", external: ["electron"],
  });
  runInNewContext(preload.outputFiles[0]!.text, {
    require: (name: string) => {
      if (name !== "electron") throw new Error(`Unexpected preload dependency ${name}`);
      return { contextBridge, ipcRenderer, webUtils };
    },
    process: { platform: process.platform },
  });
  expect(native.exposeInMainWorld).toHaveBeenCalledExactlyOnceWith("downpadDesktop", expect.any(Object));
  bridge = native.exposeInMainWorld.mock.calls[0]![1];
});

beforeEach(() => {
  native.showMessageBox.mockReset().mockResolvedValue({ response: 1 });
  native.invoke.mockReset().mockImplementation((channel, ...args) => invoke(channel, trustedEvent(), ...args));
});

afterAll(() => { vi.unstubAllEnvs(); });

describe("native unsaved-change dialog IPC", () => {
  it.each([
    [0, "save"],
    [1, "cancel"],
    [2, "discard"],
  ] as const)("maps native button %s to %s through preload", async (response, choice) => {
    native.showMessageBox.mockResolvedValueOnce({ response });

    await expect(bridge.confirmSaveChanges("Save changes to notes.md?")).resolves.toBe(choice);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("downpad:dialog-confirm-save-changes", "Save changes to notes.md?");
    expect(native.showMessageBox).toHaveBeenCalledExactlyOnceWith(native.window, {
      type: "warning", title: "Downpad", message: "Save changes to notes.md?",
      buttons: ["Save", "Cancel", "Discard"], defaultId: 0, cancelId: 1, noLink: true,
    });
  });

  it.each([undefined, null, false, 42, {}, []])("rejects malformed messages %j before opening a dialog", async (message) => {
    await expect(invoke("downpad:dialog-confirm-save-changes", trustedEvent(), message))
      .rejects.toThrow("A dialog message is required.");
    expect(native.showMessageBox).not.toHaveBeenCalled();
  });

  it.each(["sender", "senderFrame", "url"] as const)("rejects an untrusted %s before opening a dialog", async (part) => {
    const event = { ...trustedEvent() };
    if (part === "sender") event.sender = {} as IpcMainInvokeEvent["sender"];
    if (part === "senderFrame") event.senderFrame = null;
    const frame = native.window.webContents.mainFrame;
    const originalUrl = frame.url;
    if (part === "url") frame.url = "https://example.com/";
    try {
      await expect(invoke("downpad:dialog-confirm-save-changes", event, "Save changes?"))
        .rejects.toThrow("untrusted page");
      expect(native.showMessageBox).not.toHaveBeenCalled();
    } finally {
      frame.url = originalUrl;
    }
  });

  it.each([-1, 3, "0", "2", undefined, null])("treats an unexpected native response %j as cancel", async (response) => {
    native.showMessageBox.mockResolvedValueOnce({ response });
    await expect(bridge.confirmSaveChanges("Save changes?")).resolves.toBe("cancel");
  });

  it.each([undefined, null, false, 0, 2, "unknown", {}])("preload treats malformed IPC results %j as cancel", async (choice) => {
    native.invoke.mockResolvedValueOnce(choice);
    await expect(bridge.confirmSaveChanges("Save changes?")).resolves.toBe("cancel");
  });

  it("propagates native dialog failures", async () => {
    native.showMessageBox.mockRejectedValueOnce(new Error("Dialog unavailable"));
    await expect(bridge.confirmSaveChanges("Save changes?")).rejects.toThrow("Dialog unavailable");
  });

  it.each([
    [0, false],
    [1, true],
  ] as const)("preserves discard-only ask button %s as %s", async (response, confirmed) => {
    native.showMessageBox.mockResolvedValueOnce({ response });
    await expect(bridge.ask("Discard changes and reload?", { kind: "warning", okLabel: "Discard" })).resolves.toBe(confirmed);
    expect(native.showMessageBox).toHaveBeenCalledExactlyOnceWith(native.window, {
      type: "warning", title: "Downpad", message: "Discard changes and reload?",
      buttons: ["Cancel", "Discard"], defaultId: 0, cancelId: 0, noLink: true,
    });
  });
});
