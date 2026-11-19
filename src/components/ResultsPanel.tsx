"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { Candidate, ResultFilters, SearchRequest } from "@/types/search";
import { DEFAULT_FILTERS } from "@/types/search";
import { classify, hasConstraints, newestEvidence, opportunityStatus } from "@/lib/matching";
import CandidateCard from "./CandidateCard";
import Pagination from "./Pagination";
import ResultControls from "./ResultControls";

const PAGE_SIZE = 10;

type Props = {
  candidates: Candidate[];
  request: SearchRequest;
};

export default function ResultsPanel({ candidates, request }: Props) {
  const constrained = hasConstraints(request);
  const [filters, setFilters] = useState<ResultFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Verified contradictions drop out. Everything else is grouped.
  const grouped = useMemo(() => {
    const verified: Candidate[] = [];
    const checking: Candidate[] = [];
    for (const c of candidates) {
      const g = classify(c, request);
      if (g === "verified") verified.push(c);
      else if (g === "needs-checking") checking.push(c);
    }
    return { verified, checking };
  }, [candidates, request]);

  // Without constraints there is nothing to verify, so show everyone together.
  const pool = constrained
    ? filters.group === "verified"
      ? grouped.verified
      : grouped.checking
    : candidates;

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
        (filters.stageStatus === "all" ||
          c.stage.status === filters.stageStatus ||
          c.location.status === filters.stageStatus) &&
        (filters.stage === "all" || (c.stage.value ?? "unknown") === filters.stage) &&
        (filters.institution === "all" ||
          c.organizations.some((o) => o.name === filters.institution)) &&
        (filters.evidenceType === "all" ||
          c.evidence.some((e) => e.type === filters.evidenceType)) &&
        (filters.opportunity === "all" || opportunityStatus(c) === filters.opportunity),
    );
    return list.sort((a, b) => {
      if (filters.sort === "name") return a.name.localeCompare(b.name);
      if (filters.sort === "newest")
        return newestEvidence(b) - newestEvidence(a) || b.score - a.score;
      return b.score - a.score;
    });
  }, [pool, filters]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const pageItems = visible.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [current]);

  function updateFilters(next: Partial<ResultFilters>) {
    setFilters((f) => ({ ...f, ...next }));
    setPage(1);
  }

  function toggleSave(id: string) {
    setSaved((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="results">
      <ResultControls
        filters={filters}
        institutions={institutions}
        shown={visible.length}
        total={pool.length}
        constrained={constrained}
        verifiedCount={grouped.verified.length}
        checkingCount={grouped.checking.length}
        onChange={updateFilters}
      />
      <div className="results-scroll" ref={scrollRef}>
        {pageItems.length === 0 ? (
          <p className="results-empty">No candidates match these result controls.</p>
        ) : (
          <div className="results-list">
            {pageItems.map((c, i) => (
              <motion.div
                key={c.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: i * 0.03 }}
              >
                <CandidateCard
                  candidate={c}
                  saved={saved.has(c.id)}
                  onToggleSave={toggleSave}
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
