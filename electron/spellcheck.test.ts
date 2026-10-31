import { describe, expect, it, vi } from "vitest";
import { parse } from "smol-toml";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { normalizeSettings, patchSettingsToml } from "./settings";
import { Spellchecker, systemSpellcheckLanguages } from "./spellcheck";

/** A native-session substitute that keeps language and custom-word state. */
function fixture(platform = "linux") {
  let languages = ["en-US"];
  const words = new Set(["Downpad", "Zorblax"]);
  const session = {
    availableSpellCheckerLanguages: ["en-US", "en-GB", "sv", "nb"],
    getSpellCheckerLanguages: () => languages,
    setSpellCheckerLanguages: vi.fn((selected: string[]) => { languages = selected; }),
    setSpellCheckerEnabled: vi.fn(),
    listWordsInSpellCheckerDictionary: vi.fn(async () => [...words]),
    addWordToSpellCheckerDictionary: vi.fn((word: string) => { words.add(word); return true; }),
    removeWordFromSpellCheckerDictionary: vi.fn((word: string) => words.delete(word)),
  };
  return { session, checker: new Spellchecker(session, platform, () => ["sv-SE", "en-GB"]) };
}

describe("native spelling preferences", () => {
  it("maps regional OS preferences to available dictionaries and deduplicates them", () => {
    expect(systemSpellcheckLanguages(["nb_NO", "en-GB", "nb"], ["en-US", "en-GB", "nb"]))
      .toEqual(["nb", "en-GB"]);
    expect(systemSpellcheckLanguages(["zz"], ["sv", "en-US"])).toEqual(["en-US"]);
    expect(systemSpellcheckLanguages([], [])).toEqual([]);
  });

  it("uses multiple saved languages, restores OS defaults, and applies the enabled toggle", () => {
    const { checker, session } = fixture();
    checker.apply({ spellCheckEnabled: true, spellCheckLanguages: ["en-GB", "nb", "nb", "zz"] });
    expect(checker.info().activeLanguages).toEqual(["en-GB", "nb"]);
    checker.apply({ spellCheckEnabled: false, spellCheckLanguages: [] });
    expect(checker.info().activeLanguages).toEqual(["sv", "en-GB"]);
    expect(session.setSpellCheckerEnabled).toHaveBeenLastCalledWith(false);
    checker.apply({ spellCheckEnabled: true, spellCheckLanguages: ["zz"] });
    expect(checker.info().activeLanguages).toEqual(["sv", "en-GB"]);
    expect(session.setSpellCheckerLanguages).toHaveBeenCalledTimes(2);
  });

  it("leaves macOS language selection to the OS and reports the shared dictionary", () => {
    const { checker, session } = fixture("darwin");
    checker.apply({ spellCheckEnabled: true, spellCheckLanguages: ["nb"] });
    expect(session.setSpellCheckerLanguages).not.toHaveBeenCalled();
    expect(checker.info()).toMatchObject({ languageSelectionSupported: false, dictionarySharedWithSystem: true });
    expect(fixture("win32").checker.info().dictionarySharedWithSystem).toBe(true);
    expect(fixture().checker.info().dictionarySharedWithSystem).toBe(false);
  });

  it("validates language arrays and round-trips them without losing TOML comments", () => {
    for (const value of [null, {}, "en-US", ["en-US", 3], ["en-US", ""], ["bad value"]]) {
      expect(normalizeSettings({ spellCheckLanguages: value }).spellCheckLanguages).toEqual([]);
    }
    const settings = normalizeSettings({ spellCheckLanguages: ["sv", "en-US", "sv", "zz"] });
    expect(settings.spellCheckLanguages).toEqual(["sv", "en-US", "zz"]);
    const toml = patchSettingsToml('spellCheckLanguages = ["en-US"] # languages\ncustom = 42\n', settings);
    expect(toml).toContain('# languages\ncustom = 42');
    expect(parse(toml)).toMatchObject({ spellCheckLanguages: ["sv", "en-US", "zz"], custom: 42 });
    expect(normalizeSettings({}).spellCheckLanguages).toEqual(DEFAULT_SETTINGS.spellCheckLanguages);
  });
});

describe("native custom dictionary", () => {
  it("retains old words while adding and removing individual entries", async () => {
    const { checker, session } = fixture();
    expect(await checker.words()).toEqual(["Downpad", "Zorblax"]);
    await checker.add("Ångströmnix");
    await checker.remove("Zorblax");
    expect(await checker.words()).toEqual(["Ångströmnix", "Downpad"]);
    await checker.add("Downpad");
    await checker.remove("missing");
    expect(session.addWordToSpellCheckerDictionary).toHaveBeenCalledTimes(1);
    expect(session.removeWordFromSpellCheckerDictionary).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid words and reports native read and write failures", async () => {
    const { checker, session } = fixture();
    for (const word of ["", "two words", "line\nbreak", "null\0byte", "x".repeat(129)]) {
      await expect(checker.add(word)).rejects.toThrow("Enter a single word");
    }
    expect(session.addWordToSpellCheckerDictionary).not.toHaveBeenCalled();
    session.addWordToSpellCheckerDictionary.mockReturnValue(false);
    await expect(checker.add("newword")).rejects.toThrow("could not be added");
    session.removeWordFromSpellCheckerDictionary.mockReturnValue(false);
    await expect(checker.remove("Downpad")).rejects.toThrow("could not be removed");
    session.listWordsInSpellCheckerDictionary.mockRejectedValue(new Error("Read failed"));
    await expect(checker.words()).rejects.toThrow("Read failed");
  });
});
