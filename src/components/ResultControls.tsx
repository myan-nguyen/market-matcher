import { Bookmark } from "lucide-react";
import type { ResultFilters } from "@/types/search";
import { SHOWN_STAGES, STAGE_LABELS } from "@/types/search";

type Props = {
  filters: ResultFilters;
  institutions: string[];
  shown: number;
  total: number;
  onChange: (next: Partial<ResultFilters>) => void;
  bookmarkCount: number;
  showBookmarks: boolean;
  onToggleBookmarks: () => void;
};

export default function ResultControls({
  filters,
  institutions,
  shown,
  total,
  onChange,
  bookmarkCount,
  showBookmarks,
  onToggleBookmarks,
}: Props) {
  return (
    <div className="result-controls">
      <button
        type="button"
        className={showBookmarks ? "bookmark-toggle bookmark-toggle-on" : "bookmark-toggle"}
        onClick={onToggleBookmarks}
        aria-pressed={showBookmarks}
      >
        <Bookmark size={16} fill={showBookmarks ? "currentColor" : "none"} />
        {showBookmarks ? "Back to search results" : "Bookmarked"} ({bookmarkCount})
      </button>

      <p className="controls-kicker">
        other filters
      </p>

      <div className="controls-row">
        <label className="control">
          Career stage
          <select
            value={filters.stage}
            onChange={(e) => onChange({ stage: e.target.value as ResultFilters["stage"] })}
          >
            <option value="all">All</option>
            {SHOWN_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label className="control">
          Institution / lab
          <select
            value={filters.institution}
            onChange={(e) => onChange({ institution: e.target.value })}
          >
            <option value="all">All</option>
            {institutions.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>
        <label className="control">
          Sort
          <select
            value={filters.sort}
            onChange={(e) => onChange({ sort: e.target.value as ResultFilters["sort"] })}
          >
            <option value="strongest">Strongest evidence</option>
            <option value="newest">Newest evidence</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>
      <p className="controls-count">
        Showing {shown} of {total}
      </p>
    </div>
  );
}
