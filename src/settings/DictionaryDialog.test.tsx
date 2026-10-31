// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addDictionaryWord, listDictionaryWords, removeDictionaryWord } from "@/ipc/commands";
import { DictionaryDialog } from "./DictionaryDialog";

vi.mock("@/ipc/commands", () => ({
  addDictionaryWord: vi.fn(),
  listDictionaryWords: vi.fn(),
  removeDictionaryWord: vi.fn(),
}));

/** Open the native dictionary editor with isolated IPC outcomes. */
function openDictionary() {
  const onClose = vi.fn();
  render(<DictionaryDialog sharedWithSystem={false} onClose={onClose} onRestoreFocus={() => {}} />);
  return { user: userEvent.setup(), onClose };
}

/** Control an IPC completion to check loading and pending-write behavior. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listDictionaryWords).mockResolvedValue([]);
  vi.mocked(addDictionaryWord).mockResolvedValue();
  vi.mocked(removeDictionaryWord).mockResolvedValue();
});
afterEach(() => cleanup());

describe("custom dictionary", () => {
  it("distinguishes loading from an empty dictionary and retries failed reads", async () => {
    const pending = deferred<string[]>();
    vi.mocked(listDictionaryWords).mockReturnValueOnce(pending.promise);
    const { user } = openDictionary();
    expect(screen.getByRole("status").textContent).toBe("Loading custom dictionary…");
    expect(screen.queryByText("No custom words yet.")).toBeNull();
    await act(async () => { pending.reject(new Error("Unavailable")); });
    expect(screen.getByRole("alert").textContent).toBe("Could not load your custom dictionary.");
    expect((screen.getByRole("button", { name: "Add word" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No custom words yet.")).toBeTruthy();
  });

  it("validates a single word, retains failed additions, and shows a successful addition", async () => {
    vi.mocked(addDictionaryWord).mockRejectedValueOnce(new Error("Write failed"));
    const { user } = openDictionary();
    await screen.findByText("No custom words yet.");
    const input = screen.getByRole("textbox", { name: "New word" });
    await user.type(input, "two words");
    await user.click(screen.getByRole("button", { name: "Add word" }));
    expect(screen.getByRole("alert").textContent).toBe("Enter one word of at most 128 characters, without spaces or control characters.");
    expect((input as HTMLInputElement).maxLength).toBe(128);
    expect(addDictionaryWord).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, " Downpad ");
    await user.click(screen.getByRole("button", { name: "Add word" }));
    expect(await screen.findByText("Could not add the word. Try again.")).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe(" Downpad ");
    expect(screen.getByText("No custom words yet.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add word" }));
    expect(await screen.findByRole("button", { name: "Remove Downpad" })).toBeTruthy();
    expect(addDictionaryWord).toHaveBeenLastCalledWith("Downpad");
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("keeps a word after failed removal and removes it only when the native write succeeds", async () => {
    const pending = deferred<void>();
    vi.mocked(listDictionaryWords).mockResolvedValue(["Downpad"]);
    vi.mocked(removeDictionaryWord).mockRejectedValueOnce(new Error("Write failed")).mockReturnValueOnce(pending.promise);
    const { user, onClose } = openDictionary();
    const remove = await screen.findByRole("button", { name: "Remove Downpad" });
    await user.click(remove);
    expect(await screen.findByText("Could not remove the word. Try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Downpad" })).toBeTruthy();
    await user.click(remove);
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(); });
    expect(await screen.findByText("No custom words yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove Downpad" })).toBeNull();
    expect(removeDictionaryWord).toHaveBeenLastCalledWith("Downpad");
  });

  it("filters custom words without submitting a pending addition", async () => {
    vi.mocked(listDictionaryWords).mockResolvedValue(["Zebra", "Downpad"]);
    const { user } = openDictionary();
    const search = await screen.findByRole("searchbox", { name: "Find a word" });
    await user.type(screen.getByRole("textbox", { name: "New word" }), "staged");
    await user.type(search, "down{Enter}");
    expect(addDictionaryWord).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove Downpad" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove Zebra" })).toBeNull();
    await user.clear(search);
    await waitFor(() => expect(screen.getAllByRole("listitem").map((entry) => entry.textContent)).toEqual(["DownpadRemove", "ZebraRemove"]));
  });
});
