import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { dialogBodyClassName, dialogContentClassName, dialogFooterClassName, dialogOverlayClassName, dialogTitleClassName } from "@/components/ui/dialog-layout";
import { Input } from "@/components/ui/input";
import { addDictionaryWord, listDictionaryWords, removeDictionaryWord } from "@/ipc/commands";
import { cn } from "@/lib/utils";

interface DictionaryDialogProps {
  sharedWithSystem: boolean;
  onClose: () => void;
  onRestoreFocus: () => void;
}

/** Manage native dictionary entries immediately, independently of Settings Save. */
export function DictionaryDialog({ sharedWithSystem, onClose, onRestoreFocus }: DictionaryDialogProps) {
  const [words, setWords] = useState<string[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [word, setWord] = useState("");
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setLoadFailed(false);
    void listDictionaryWords().then((next) => {
      if (live) setWords([...new Set(next)].sort((left, right) => left.localeCompare(right)));
    }).catch(() => {
      if (live) setLoadFailed(true);
    });
    return () => { live = false; };
  }, [retry]);

  const query = search.trim().toLocaleLowerCase();
  const visibleWords = words?.filter((entry) => entry.toLocaleLowerCase().includes(query)) ?? [];

  /** Update the list only after the native dictionary confirms the mutation. */
  const changeWord = async (entry: string, remove: boolean): Promise<void> => {
    if (busy || !words) return;
    setBusy(true);
    setError(null);
    try {
      if (remove) {
        await removeDictionaryWord(entry);
        setWords((current) => current?.filter((value) => value !== entry) ?? null);
      } else {
        await addDictionaryWord(entry);
        setWords((current) => [...new Set([...(current ?? []), entry])].sort((left, right) => left.localeCompare(right)));
        setWord("");
        setSearch("");
      }
    } catch {
      setError(remove ? "Could not remove the word. Try again." : "Could not add the word. Try again.");
    } finally {
      setBusy(false);
    }
  };

  /** Prevent a nested modal submission from reaching the Settings form. */
  const add = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const entry = word.trim();
    if (!entry || entry.length > 128 || /[\s\p{Cc}\p{Cs}]/u.test(entry)) {
      setError("Enter one word of at most 128 characters, without spaces or control characters.");
      return;
    }
    void changeWord(entry, false);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogPortal>
        <DialogOverlay className={cn("dialog-overlay", dialogOverlayClassName, "z-[1100]")} />
        <DialogContent
          className={cn("dictionary-dialog", dialogContentClassName, "z-[1101]")}
          onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
          onCloseAutoFocus={(event) => { event.preventDefault(); onRestoreFocus(); }}
          onEscapeKeyDown={(event) => { event.stopPropagation(); if (busy) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}
        >
          <DialogTitle className={dialogTitleClassName}>Custom dictionary</DialogTitle>
          <DialogDescription className="m-0 px-[22px] pb-3 text-ink-soft">
            Words are saved immediately. Cancel in Settings does not undo these changes.
          </DialogDescription>
          <form className="flex min-h-0 flex-col" onSubmit={add}>
            <div className={cn(dialogBodyClassName, "flex flex-col gap-3")}>
              {sharedWithSystem && <p className="m-0 text-ink-soft">Adding or removing a word also changes the dictionary used by other apps on your system.</p>}
              <div className="flex items-end gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span>New word</span>
                  <Input
                    ref={inputRef}
                    value={word}
                    spellCheck={false}
                    autoComplete="off"
                    maxLength={128}
                    disabled={busy}
                    onChange={(event) => setWord(event.currentTarget.value)}
                    className="w-full min-w-0"
                  />
                </label>
                <Button type="submit" disabled={busy || words === null || !word.trim()}>Add word</Button>
              </div>
              {error && <p role="alert" className="m-0">{error}</p>}
              {words === null ? loadFailed ? (
                <div className="flex flex-col items-start gap-2">
                  <p role="alert" className="m-0">Could not load your custom dictionary.</p>
                  <Button type="button" variant="outline" onClick={() => setRetry((value) => value + 1)}>Try again</Button>
                </div>
              ) : (
                <p role="status" className="m-0 text-ink-soft">Loading custom dictionary…</p>
              ) : words.length === 0 ? (
                <p role="status" className="m-0 text-ink-soft">No custom words yet.</p>
              ) : (
                <>
                  <label className="flex flex-col gap-1.5">
                    <span>Find a word</span>
                    <Input
                      type="search"
                      value={search}
                      spellCheck={false}
                      onChange={(event) => setSearch(event.currentTarget.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
                      className="w-full min-w-0"
                    />
                  </label>
                  <div className="max-h-64 overflow-y-auto rounded-control border border-line bg-well">
                    <ul aria-label="Custom words" className="m-0 list-none p-1">
                      {visibleWords.map((entry) => (
                        <li key={entry} className="flex min-h-8 items-center justify-between gap-3 rounded-[3px] px-2 py-1">
                          <span className="min-w-0 break-all">{entry}</span>
                          <Button type="button" variant="outline" size="sm" aria-label={`Remove ${entry}`} disabled={busy} onClick={() => void changeWord(entry, true)}>Remove</Button>
                        </li>
                      ))}
                    </ul>
                    {!visibleWords.length && <p className="m-0 px-3 py-2 text-ink-soft">No matching words.</p>}
                  </div>
                  <p className="m-0 text-ink-soft">{words.length} {words.length === 1 ? "word" : "words"}. Removing a word lets the spell checker flag it again.</p>
                </>
              )}
              {busy && <p role="status" className="m-0 text-ink-soft">Saving dictionary…</p>}
            </div>
            <div className={dialogFooterClassName}>
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Done</Button>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
