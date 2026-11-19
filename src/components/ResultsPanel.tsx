"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { Candidate, ResultFilters, SearchRequest } from "@/types/search";
import { DEFAULT_FILTERS } from "@/types/search";
import { classify, newestEvidence } from "@/lib/matching";
import { useBookmarks } from "@/lib/bookmarks";
import CandidateCard from "./CandidateCard";
import Pagination from "./Pagination";
import ResultControls from "./ResultControls";

const PAGE_SIZE = 10;

type Props = {
  candidates: Candidate[];
  request: SearchRequest;
};

export default function ResultsPanel({ candidates, request }: Props) {
  const [filters, setFilters] = useState<ResultFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const bookmarks = useBookmarks();
  const [showBookmarks, setShowBookmarks] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Everyone is shown together. Verified contradictions were already removed on the server.
  const pool = useMemo(() => candidates.filter((c) => classify(c, request) !== "excluded"), [candidates, request]);

  const institutions = useMemo(
    () =>
      Array.from(
        new Set(candidates.flatMap((c) => c.organizations.map((o) => o.name))),
      ).sort(),
    [candidates],
  );

  const visible = useMemo(() => {
    const list = pool.filter(
      (c) =>
        (filters.stage === "all" || (c.stage.value ?? "unknown") === filters.stage) &&
        (filters.institution === "all" ||
          c.organizations.some((o) => o.name === filters.institution)),
    );
    return list.sort((a, b) => {
      if (filters.sort === "name") return a.name.localeCompare(b.name);
      if (filters.sort === "newest")
        return newestEvidence(b) - newestEvidence(a) || b.score - a.score;
      return 0; // "strongest": keep the server order, which is relevance diversified across organizations
    });
  }, [pool, filters]);

  // Bookmarked view: only saved people, newest first, including ones from earlier searches this session.
  const shownList = showBookmarks ? bookmarks.items.map((b) => b.candidate) : visible;
  const totalPages = Math.max(1, Math.ceil(shownList.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const pageItems = shownList.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [current, showBookmarks]);

  function updateFilters(next: Partial<ResultFilters>) {
    setFilters((f) => ({ ...f, ...next }));
    setPage(1);
  }

  function toggleBookmarkView() {
    setShowBookmarks((v) => !v);
    setPage(1);
  }

  return (
    <section className="results">
      <ResultControls
        filters={filters}
        institutions={institutions}
        shown={visible.length}
        total={pool.length}
        onChange={updateFilters}
        bookmarkCount={bookmarks.items.length}
        showBookmarks={showBookmarks}
        onToggleBookmarks={toggleBookmarkView}
      />
      <div className="results-scroll" ref={scrollRef}>
        {pageItems.length === 0 ? (
          <p className="results-empty">
            {showBookmarks ? "No bookmarked researchers yet. Click the bookmark icon on a card to save it." : "No candidates match these result controls."}
          </p>
        ) : (
          <div className="results-list">
            {pageItems.map((c, i) => (
              <motion.div
                key={`${showBookmarks ? "b" : "r"}-${c.id}`}
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: i * 0.03 }}
              >
                <CandidateCard
                  candidate={c}
                  saved={bookmarks.has(c)}
                  onToggleSave={bookmarks.toggle}
                />
              </motion.div>
            ))}
          </div>
        )}
        <Pagination page={current} totalPages={totalPages} onChange={setPage} />
      </div>
    </section>
  );
}
