import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { getSpellcheckInfo } from "@/ipc/commands";
import type { SpellcheckInfo } from "@/ipc/contracts";
import { isElectron } from "@/ipc/env";
import { DictionaryDialog } from "./DictionaryDialog";
import { CheckRow, Hint, SettingsBox } from "./SettingsLayout";

interface SpellingSettingsProps {
  active: boolean;
  initialEnabled: boolean;
  languages: string[];
  onLanguagesChange: (languages: string[]) => void;
  onDictionaryOpenChange: (open: boolean) => void;
}

/** Resolve locale codes into readable names, keeping unfamiliar saved codes visible. */
function languageLabel(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: "language", languageDisplay: "standard" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Stage language preferences in Settings while managing dictionary words separately. */
export function SpellingSettings({ active, initialEnabled, languages, onLanguagesChange, onDictionaryOpenChange }: SpellingSettingsProps) {
  const [info, setInfo] = useState<SpellcheckInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState("");
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const dictionaryButton = useRef<HTMLButtonElement>(null);
  const customLanguages = useRef(languages);
  const native = isElectron();

  useEffect(() => {
    if (!active || !native || info) return;
    let live = true;
    setFailed(false);
    void getSpellcheckInfo().then((next) => {
      if (live) setInfo(next);
    }).catch(() => {
      if (live) setFailed(true);
    });
    return () => { live = false; };
  }, [active, native, info, retry]);

  const choices = useMemo(() => [...new Set([...(info?.availableLanguages ?? []), ...languages])]
    .map((code) => ({ code, label: languageLabel(code), available: info?.availableLanguages.includes(code) ?? false }))
    .sort((left, right) => left.label.localeCompare(right.label)), [info, languages]);
  const query = search.trim().toLocaleLowerCase();
  const visibleChoices = choices.filter(({ code, label }) => `${label} ${code}`.toLocaleLowerCase().includes(query));
  const followSystem = languages.length === 0;
  const unavailable = languages.filter((code) => !info?.availableLanguages.includes(code));

  /** Keep update restarts from interrupting dictionary edits or writes. */
  const showDictionary = (open: boolean): void => {
    onDictionaryOpenChange(open);
    setDictionaryOpen(open);
  };

  /** Switching modes remembers the staged custom choice without saving it. */
  const changeMode = (system: boolean): void => {
    if (!info) return;
    if (system) {
      customLanguages.current = languages;
      onLanguagesChange([]);
      return;
    }
    const supported = (codes: string[]) => codes.filter((code) => info.availableLanguages.includes(code));
    const saved = customLanguages.current;
    const activeLanguages = supported(info.activeLanguages);
    const systemLanguages = supported(info.systemLanguages);
    const next = saved.length ? saved : activeLanguages.length ? activeLanguages
      : systemLanguages.length ? systemLanguages : info.availableLanguages.slice(0, 1);
    if (next.length) onLanguagesChange(next);
  };

  return (
    <>
      <SettingsBox>
        <CheckRow label="Spell check" placement="box">
          <Checkbox name="spellCheckEnabled" defaultChecked={initialEnabled} />
        </CheckRow>
        <Hint placement="box">Check prose in Document and Markdown views. Code is excluded.</Hint>
      </SettingsBox>

      {!native ? (
        <Hint placement="box">Language selection and the custom dictionary are available in the installed app.</Hint>
      ) : !info ? (
        <SettingsBox title="Languages">
          {failed ? (
            <div className="col-span-full flex flex-col items-start gap-2">
              <p role="alert" className="m-0">Could not load spelling languages.</p>
              <Button type="button" variant="outline" onClick={() => setRetry((value) => value + 1)}>Try again</Button>
            </div>
          ) : (
            <p role="status" className="col-span-full m-0 text-ink-soft">Loading spelling languages…</p>
          )}
        </SettingsBox>
      ) : (
        <>
          <SettingsBox title="Languages">
            {!info.languageSelectionSupported ? (
              <Hint placement="box">macOS manages spelling languages. Change them in System Settings.</Hint>
            ) : (
              <>
                <CheckRow label="Use system languages" placement="box">
                  <Checkbox
                    checked={followSystem}
                    disabled={info.availableLanguages.length === 0 && followSystem}
                    onChange={(event) => changeMode(event.currentTarget.checked)}
                  />
                </CheckRow>
                {followSystem ? (
                  <Hint placement="box">
                    {info.systemLanguages.length
                      ? info.systemLanguages.map(languageLabel).join(", ")
                      : "The spell checker uses this device's default languages."}
                  </Hint>
                ) : (
                  <div className="col-span-full flex min-w-0 flex-col gap-2 pt-1">
                    <label className="flex flex-col gap-1.5">
                      <span>Find a language</span>
                      <Input
                        type="search"
                        value={search}
                        spellCheck={false}
                        onChange={(event) => setSearch(event.currentTarget.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
                        className="w-full min-w-0"
                      />
                    </label>
                    <div role="group" aria-label="Spelling languages" className="max-h-52 overflow-y-auto rounded-control border border-line bg-well p-1">
                      {visibleChoices.map(({ code, label, available }) => (
                        <label key={code} className="flex min-h-7 cursor-pointer items-center gap-2 rounded-[3px] px-2 py-1 hover:bg-row-hover">
                          <Checkbox
                            checked={languages.includes(code)}
                            disabled={languages.length === 1 && languages.includes(code)}
                            onChange={(event) => onLanguagesChange(event.currentTarget.checked
                              ? [...languages, code]
                              : languages.filter((value) => value !== code))}
                          />
                          <span>{label}{!available && " (unavailable)"}</span>
                        </label>
                      ))}
                      {!visibleChoices.length && <p className="m-0 px-2 py-2 text-ink-soft">No matching languages.</p>}
                    </div>
                    <p className="m-0 text-ink-soft">Select at least one language. Changes apply when you save Settings.</p>
                    {unavailable.length > 0 && (
                      <p className="m-0 text-ink-soft">
                        Unavailable languages are saved but are not used on this device.
                        {unavailable.length === languages.length && " The spell checker uses system languages until an available language is selected."}
                      </p>
                    )}
                  </div>
                )}
                {info.availableLanguages.length === 0 && <Hint placement="box">No language dictionaries are available on this device.</Hint>}
                <Hint placement="box">New language dictionaries need an internet connection to download. Spelling is checked on your device.</Hint>
              </>
            )}
          </SettingsBox>
          <SettingsBox title="Custom dictionary">
            <Hint placement="box">Manage words you want the spell checker to accept.</Hint>
            {info.dictionarySharedWithSystem && <Hint placement="box">Adding or removing words also updates your system dictionary.</Hint>}
            <Button
              ref={dictionaryButton}
              type="button"
              variant="outline"
              className="col-span-full mt-1 justify-self-start"
              onClick={() => showDictionary(true)}
            >
              Manage dictionary…
            </Button>
          </SettingsBox>
          {dictionaryOpen && (
            <DictionaryDialog
              sharedWithSystem={info.dictionarySharedWithSystem}
              onClose={() => showDictionary(false)}
              onRestoreFocus={() => dictionaryButton.current?.focus()}
            />
          )}
        </>
      )}
    </>
  );
}
