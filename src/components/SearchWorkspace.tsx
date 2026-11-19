"use client";

import { useEffect, useState } from "react";
import { animate } from "framer-motion";
import type { SearchRequest, SearchResponse } from "@/types/search";
import Search from "./Search";
import ResultsPanel from "./ResultsPanel";
import ResultsSummary from "./ResultsSummary";

type Result = { request: SearchRequest; response: SearchResponse };

export default function SearchWorkspace() {
  const [result, setResult] = useState<Result | null>(null);
  const [searchId, setSearchId] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch(request: SearchRequest) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Search failed.");
      }
      const response = (await res.json()) as SearchResponse;
      setResult({ request, response });
      setSearchId((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  // Soft auto scroll to the bottom whenever a new search returns.
  useEffect(() => {
    if (searchId === 0) return;
    const frame = requestAnimationFrame(() => {
      const target = document.documentElement.scrollHeight - window.innerHeight;
      animate(window.scrollY, target, {
        duration: 0.9,
        ease: "easeInOut",
        onUpdate: (y) => window.scrollTo(0, y),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchId]);

  return (
    <>
      <Search onSearch={handleSearch} loading={loading} />
      {error && <p className="search-error">{error}</p>}
      {result && (
        <>
          <ResultsSummary response={result.response} />
          {/* key resets filters and page for every new search */}
          <ResultsPanel
            key={searchId}
            candidates={result.response.candidates}
            request={result.request}
          />
        </>
      )}
    </>
  );
}
