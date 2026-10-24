// Dictations as library items: every entry History keeps, newest first.
import { useCallback, useEffect, useState } from "react";
import { commands, events, type HistoryEntry, type PaginatedHistory, type Result } from "@/bindings";

export type Dictation = HistoryEntry;

/** What gets pasted: the proofread version when there is one. */
export const dictationText = (d: Dictation) => (d.post_processed_text || d.transcription_text || "").trim();

export const countWords = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

/** Milliseconds, like the captures (History keeps seconds). */
export const dictationTime = (d: Dictation) => d.timestamp * 1000;

export function useDictations() {
  const [entries, setEntries] = useState<Dictation[]>([]);
  const refresh = useCallback(async () => {
    const all: Dictation[] = [];
    let cursor: number | null = null;
    for (let page = 0; page < 20; page++) {
      const res: Result<PaginatedHistory, string> | null = await commands.getHistoryEntries(cursor, 200).catch(() => null);
      if (!res || res.status !== "ok") break;
      all.push(...res.data.entries);
      if (!res.data.has_more || !res.data.entries.length) break;
      cursor = res.data.entries[res.data.entries.length - 1].id;
    }
    setEntries(all.filter((d) => dictationText(d)));
  }, []);
  useEffect(() => {
    void refresh();
    const off = events.historyUpdatePayload.listen(() => void refresh());
    return () => {
      off.then((f) => f());
    };
  }, [refresh]);
  return { entries, refresh };
}

export function matchesDictation(d: Dictation, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${d.transcription_text} ${d.post_processed_text ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
