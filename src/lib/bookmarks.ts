"use client";

import { useCallback, useState } from "react";
import type { Candidate } from "@/types/search";

const KEY = "market-matcher:bookmarks";

/** What is kept for each bookmark. `candidate` lets the card render the same way after a refresh. */
export type Bookmark = {
  key: string; // stable person ID
  name: string;
  affiliation: string | null;
  evidence: { label: string; url: string }[];
  candidate: Candidate;
  savedAt: string;
};

/** OpenAlex ID, then ORCID, then a canonical profile URL. Stable across searches. */
export function bookmarkKey(c: Candidate): string {
  if (c.openalexId) return `openalex:${c.openalexId}`;
  if (c.orcid) return `orcid:${c.orcid}`;
  const read = c.profiles.filter((p) => !p.provisional);
  const profile = read.find((p) => p.institutional) ?? read[0] ?? c.profiles[0];
  if (profile) return `url:${profile.url.replace(/\/$/, "").toLowerCase()}`;
  return `id:${c.id}`;
}

function load(): Bookmark[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Bookmark[]) : [];
  } catch {
    return [];
  }
}

/** Session-only bookmarks: React state mirrored to sessionStorage for this tab. */
export function useBookmarks() {
  // Lazy initial read. The results panel only renders after a search, on the client.
  const [items, setItems] = useState<Bookmark[]>(() => (typeof window === "undefined" ? [] : load()));

  const persist = (next: Bookmark[]) => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Storage full or blocked: bookmarks still work for this page view.
    }
    return next;
  };

  const toggle = useCallback((c: Candidate) => {
    const key = bookmarkKey(c);
    setItems((prev) =>
      persist(
        prev.some((b) => b.key === key)
          ? prev.filter((b) => b.key !== key)
          : [
              {
                key,
                name: c.name,
                affiliation: c.organizations[0]?.name ?? null,
                evidence: c.evidence.map((e) => ({ label: e.label, url: e.url })),
                candidate: c,
                savedAt: new Date().toISOString(),
              },
              ...prev,
            ],
      ),
    );
  }, []);

  const has = useCallback((c: Candidate) => items.some((b) => b.key === bookmarkKey(c)), [items]);

  return { items, toggle, has };
}
