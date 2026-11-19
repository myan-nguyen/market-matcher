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
      <p className="main-search-text">hi dan! type in your search criteria below as described and market matcher (TM) will find you relevant researchers
        accordingly (i've included basic search criteria and results filters to get you started inferenced from your Notion). 
        linked within each researcher result are its sources, and contact information can be found through there. do note that unfortunately, market matcher is still quite slow in executing searches (results should load within 1 minute), so please be patient and make those queries count! 
        you can also bookmark candidates and access them through the bookmark toggle on the results sidebar, but beware -- your saved candidates clear when you close the tab (terribly inconvenient i'm aware, apologies)
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
