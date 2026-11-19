import type { ResultFilters } from "@/types/search";
import { STAGE_CODES, STAGE_LABELS } from "@/types/search";

type Props = {
  filters: ResultFilters;
  institutions: string[];
  shown: number;
  total: number;
  constrained: boolean;
  verifiedCount: number;
  checkingCount: number;
  onChange: (next: Partial<ResultFilters>) => void;
};

export default function ResultControls({
  filters,
  institutions,
  shown,
  total,
  constrained,
  verifiedCount,
  checkingCount,
  onChange,
}: Props) {
  return (
    <div className="result-controls">
      <p className="controls-kicker">
        other filters
      </p>

      {constrained && (
        <div className="group-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={filters.group === "verified"}
            className={filters.group === "verified" ? "tab tab-on" : "tab"}
            onClick={() => onChange({ group: "verified" })}
          >
            Verified matches ({verifiedCount})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filters.group === "needs-checking"}
            className={filters.group === "needs-checking" ? "tab tab-on" : "tab"}
            onClick={() => onChange({ group: "needs-checking" })}
          >
            Needs checking ({checkingCount})
          </button>
        </div>
      )}

      <div className="controls-row">
        <label className="control">
          Stage / location status
          <select
            value={filters.stageStatus}
            onChange={(e) =>
              onChange({ stageStatus: e.target.value as ResultFilters["stageStatus"] })
            }
          >
            <option value="all">All</option>
            <option value="verified">Verified</option>
            <option value="inferred">Inferred</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label className="control">
          Career stage
          <select
            value={filters.stage}
            onChange={(e) => onChange({ stage: e.target.value as ResultFilters["stage"] })}
          >
            <option value="all">All</option>
            {STAGE_CODES.map((s) => (
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
          Evidence type
          <select
            value={filters.evidenceType}
            onChange={(e) =>
              onChange({ evidenceType: e.target.value as ResultFilters["evidenceType"] })
            }
          >
            <option value="all">All</option>
            <option value="profile">Profile</option>
            <option value="publication">Publication</option>
            <option value="project">Project</option>
          </select>
        </label>
        <label className="control">
          Opportunity
          <select
            value={filters.opportunity}
            onChange={(e) =>
              onChange({ opportunity: e.target.value as ResultFilters["opportunity"] })
            }
          >
            <option value="all">All</option>
            <option value="checked">Checked</option>
            <option value="unresolved">Unresolved</option>
            <option value="not checked">Not checked</option>
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
