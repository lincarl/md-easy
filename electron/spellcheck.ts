import type { Session } from "electron";
import type { SpellcheckInfo } from "../src/ipc/contracts";
import type { Settings } from "../src/state/types";

type SpellingSession = Pick<Session, "availableSpellCheckerLanguages" | "getSpellCheckerLanguages" |
  "setSpellCheckerLanguages" | "setSpellCheckerEnabled" | "listWordsInSpellCheckerDictionary" |
  "addWordToSpellCheckerDictionary" | "removeWordFromSpellCheckerDictionary">;

/** Match OS language preferences to Chromium's supported dictionary identifiers. */
export function systemSpellcheckLanguages(preferred: readonly string[], available: readonly string[]): string[] {
  const matched = preferred.flatMap((language) => {
    const tag = language.replaceAll("_", "-").toLowerCase();
    const exact = available.find((candidate) => candidate.toLowerCase() === tag);
    const base = tag.split("-")[0];
    const closest = exact ?? available.find((candidate) => candidate.toLowerCase() === base) ??
      available.find((candidate) => candidate.toLowerCase().split("-")[0] === base);
    return closest ? [closest] : [];
  });
  return [...new Set(matched.length ? matched : available.includes("en-US") ? ["en-US"] : available.slice(0, 1))];
}

/** Keep the native checker in sync with app preferences without duplicating its dictionary. */
export class Spellchecker {
  constructor(
    private readonly session: SpellingSession,
    private readonly platform: string,
    private readonly preferredLanguages: () => string[],
  ) {}

  /** Apply enabled state and supported languages, falling back to the system preferences. */
  apply(settings: Pick<Settings, "spellCheckEnabled" | "spellCheckLanguages">): void {
    if (this.platform !== "darwin") {
      const available = this.session.availableSpellCheckerLanguages;
      const selected = settings.spellCheckLanguages.filter((language) => available.includes(language));
      const languages = selected.length ? [...new Set(selected)] : systemSpellcheckLanguages(this.preferredLanguages(), available);
      if (JSON.stringify(languages) !== JSON.stringify(this.session.getSpellCheckerLanguages())) {
        this.session.setSpellCheckerLanguages(languages);
      }
    }
    this.session.setSpellCheckerEnabled(settings.spellCheckEnabled);
  }

  /** Report capabilities so settings never offer an unsupported native operation. */
  info(): SpellcheckInfo {
    const availableLanguages = this.session.availableSpellCheckerLanguages;
    return {
      availableLanguages,
      activeLanguages: this.session.getSpellCheckerLanguages(),
      systemLanguages: systemSpellcheckLanguages(this.preferredLanguages(), availableLanguages),
      languageSelectionSupported: this.platform !== "darwin",
      dictionarySharedWithSystem: this.platform === "darwin" || this.platform === "win32",
    };
  }

  /** Read the existing native dictionary, including words saved by older app versions. */
  async words(): Promise<string[]> {
    return (await this.session.listWordsInSpellCheckerDictionary()).sort((a, b) => a.localeCompare(b));
  }

  /** Add one custom word and report native failures instead of implying it was saved. */
  async add(word: string): Promise<void> {
    validateDictionaryWord(word);
    if ((await this.words()).includes(word)) return;
    if (!this.session.addWordToSpellCheckerDictionary(word)) throw new Error("The word could not be added to the dictionary.");
  }

  /** Remove one saved word, leaving dictionary persistence to the native checker. */
  async remove(word: string): Promise<void> {
    validateDictionaryWord(word);
    if (!(await this.words()).includes(word)) return;
    if (!this.session.removeWordFromSpellCheckerDictionary(word)) throw new Error("The word could not be removed from the dictionary.");
  }
}

/** Reject empty words, whitespace, and control characters before passing text to Chromium. */
function validateDictionaryWord(word: string): void {
  if (!word || word.length > 128 || /[\s\p{Cc}\p{Cs}]/u.test(word)) {
    throw new Error("Enter a single word of at most 128 characters, without spaces.");
  }
}
