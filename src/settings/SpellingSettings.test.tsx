// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addDictionaryWord, getSpellcheckInfo, listDictionaryWords } from "@/ipc/commands";
import type { SpellcheckInfo } from "@/ipc/contracts";
import { isElectron } from "@/ipc/env";
import { onUpdateChanged } from "@/ipc/events";
import type { Settings } from "@/state/types";
import { DEFAULT_SETTINGS } from "./defaults";
import { SettingsDialogView } from "./SettingsDialogView";

vi.mock("@/ipc/env", () => ({ isElectron: vi.fn(() => true) }));
vi.mock("@/ipc/events", () => ({ onUpdateChanged: vi.fn(async () => () => {}) }));
vi.mock("@/ipc/commands", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/ipc/commands")>(),
  getSystemAccentColor: vi.fn(async () => null),
  checkForUpdates: vi.fn(async () => {}),
  updateInfo: vi.fn(async () => ({ version: "1.0.0", selfUpdate: false, lastCheckMs: null, state: { status: "idle" } })),
  getSpellcheckInfo: vi.fn(),
  listDictionaryWords: vi.fn(),
  addDictionaryWord: vi.fn(),
  removeDictionaryWord: vi.fn(),
}));

const nativeInfo: SpellcheckInfo = {
  availableLanguages: ["en-US", "de-DE", "fr-FR"],
  activeLanguages: ["en-US"],
  systemLanguages: ["en-US"],
  languageSelectionSupported: true,
  dictionarySharedWithSystem: false,
};

/** Open the real settings form so Save and nested modal behavior are exercised. */
async function openSpelling(initial: Settings = DEFAULT_SETTINGS, restartIfSaved?: () => Promise<boolean>) {
  const onSave = vi.fn<(next: Settings) => void>();
  const onRequestClose = vi.fn();
  const user = userEvent.setup();
  render(<SettingsDialogView initial={initial} onSave={onSave} onRequestClose={onRequestClose} restartIfSaved={restartIfSaved} />);
  await user.click(screen.getByRole("tab", { name: "Spelling" }));
  return { user, onSave, onRequestClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isElectron).mockReturnValue(true);
  vi.mocked(getSpellcheckInfo).mockResolvedValue(nativeInfo);
  vi.mocked(listDictionaryWords).mockResolvedValue([]);
  vi.mocked(addDictionaryWord).mockResolvedValue();
});
afterEach(() => cleanup());
vi.setConfig({ testTimeout: 20_000 });

describe("spelling preferences", () => {
  it("stages multiple searchable languages across pages and saves them together", async () => {
    const { user, onSave } = await openSpelling();
    const system = await screen.findByRole("checkbox", { name: "Use system languages" });
    expect((system as HTMLInputElement).checked).toBe(true);
    await user.click(system);
    const english = screen.getByRole("checkbox", { name: "English (United States)" }) as HTMLInputElement;
    expect(english.checked).toBe(true);
    expect(english.disabled).toBe(true);
    const search = screen.getByRole("searchbox", { name: "Find a language" });
    await user.type(search, "german");
    await user.click(screen.getByRole("checkbox", { name: "German (Germany)" }));
    expect(screen.queryByRole("checkbox", { name: "English (United States)" })).toBeNull();
    await user.clear(search);
    expect((screen.getByRole("checkbox", { name: "English (United States)" }) as HTMLInputElement).disabled).toBe(false);
    await user.click(screen.getByRole("tab", { name: "Editor" }));
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0][0].spellCheckLanguages).toEqual(["en-US", "de-DE"]);
  });

  it("restores the staged custom choice after following system, and discards it on Cancel", async () => {
    const { user, onSave, onRequestClose } = await openSpelling({ ...DEFAULT_SETTINGS, spellCheckLanguages: ["en-US", "fr-FR"] });
    const system = await screen.findByRole("checkbox", { name: "Use system languages" });
    await user.click(system);
    expect(screen.queryByRole("group", { name: "Spelling languages" })).toBeNull();
    await user.click(system);
    expect((screen.getByRole("checkbox", { name: "French (France)" }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "French (France)" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it("saves following system as an empty list and explains unavailable saved preferences", async () => {
    const { user, onSave } = await openSpelling({ ...DEFAULT_SETTINGS, spellCheckLanguages: ["nb"] });
    await screen.findByRole("checkbox", { name: "Norwegian Bokmål (unavailable)" });
    expect(screen.getByText(/Unavailable languages are saved but are not used/).textContent).toContain("uses system languages");
    await user.click(screen.getByRole("checkbox", { name: "Use system languages" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0][0].spellCheckLanguages).toEqual([]);
  });

  it("retries capability loading and shows system-controlled languages with the shared dictionary note", async () => {
    vi.mocked(getSpellcheckInfo).mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue({
      ...nativeInfo,
      languageSelectionSupported: false,
      dictionarySharedWithSystem: true,
    });
    const { user } = await openSpelling();
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("macOS manages spelling languages. Change them in System Settings.")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Use system languages" })).toBeNull();
    expect(screen.getByText("Adding or removing words also updates your system dictionary.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Manage dictionary…" }));
    expect(screen.getByText(/Adding or removing a word also changes/)).toBeTruthy();
  });

  it("keeps the browser checkbox and saved languages without invoking native commands", async () => {
    vi.mocked(isElectron).mockReturnValue(false);
    const { user, onSave } = await openSpelling({ ...DEFAULT_SETTINGS, spellCheckLanguages: ["de-DE"] });
    expect(screen.getByText(/Language selection and the custom dictionary are available in the installed app/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Manage dictionary…" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Spell check" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0][0]).toMatchObject({ spellCheckEnabled: false, spellCheckLanguages: ["de-DE"] });
    expect(getSpellcheckInfo).not.toHaveBeenCalled();
  });

  it("saves dictionary words immediately without submitting Settings, and Escape closes only the dictionary", async () => {
    const { user, onSave, onRequestClose } = await openSpelling();
    await user.click(await screen.findByRole("button", { name: "Manage dictionary…" }));
    await screen.findByText("No custom words yet.");
    await user.type(screen.getByRole("textbox", { name: "New word" }), "Downpad{Enter}");
    await waitFor(() => expect(addDictionaryWord).toHaveBeenCalledWith("Downpad"));
    await screen.findByRole("button", { name: "Remove Downpad" });
    expect(onSave).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Custom dictionary" })).toBeNull();
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Manage dictionary…" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it("does not restart for an update while the dictionary editor has an unfinished word", async () => {
    const restartIfSaved = vi.fn(async () => true);
    const { user } = await openSpelling(DEFAULT_SETTINGS, restartIfSaved);
    await user.click(screen.getByRole("tab", { name: "Updates" }));
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await user.click(screen.getByRole("tab", { name: "Spelling" }));
    await user.click(await screen.findByRole("button", { name: "Manage dictionary…" }));
    await user.type(screen.getByRole("textbox", { name: "New word" }), "unfinished");
    act(() => vi.mocked(onUpdateChanged).mock.calls[0][0]({
      version: "1.0.0", selfUpdate: true, lastCheckMs: null, state: { status: "ready", version: "1.1.0" },
    }));
    expect(restartIfSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Custom dictionary" })).toBeTruthy();
  });
});
