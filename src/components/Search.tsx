"use client";

import { useState, type FormEvent } from "react";
import type { SearchRequest, StageCode } from "@/types/search";
import MainSearch from "./MainSearch";
import CohortField from "./CohortField";
import KeywordsField from "./KeywordsField";
import MethodsField from "./MethodsField";
import StateSelect from "./StateSelect";
import CareerStages from "./CareerStages";
import SearchButton from "./SearchButton";

type Props = {
  onSearch: (request: SearchRequest) => void;
  loading?: boolean;
};

const splitList = (v: string) =>
  v.split(",").map((x) => x.trim()).filter(Boolean);

export default function Search({ onSearch, loading = false }: Props) {
  // Nothing is preselected. Chips only suggest.
  const [state, setState] = useState("");
  const [stages, setStages] = useState<StageCode[]>([]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    onSearch({
      query: text("query"),
      cohort: text("cohort"),
      include: splitList(text("include")),
      prefer: splitList(text("prefer")),
      exclude: splitList(text("exclude")),
      method: text("method") || null,
      state: state || null,
      stages,
    });
  }

  return (
    <form className="search" onSubmit={handleSubmit}>
      <p className="main-search-text">hi dan! how this works is you type in a specific field in the main search engine
        and a few constraints (give me some ideas), and market matcher (TM) will search the web and find you researchers
        that suit your criteria. i've included some basic filters to get you started based off your Notion, but feel free to
        add custom ones as well.
      </p>
      <div className="form-grid">
        <MainSearch />
        <CohortField />
        <KeywordsField />
        <MethodsField />
        <StateSelect value={state} onChange={setState} />
        <CareerStages value={stages} onChange={setStages} />
      </div>
      <SearchButton loading={loading} />
    </form>
  );
}
