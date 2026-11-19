import type { SearchResponse } from "@/types/search";

export default function ResultsSummary({ response }: { response: SearchResponse }) {
  const time = new Date(response.retrievedAt).toLocaleString();
  return (
    <div className="summary">
      <p className="summary-line">
        text me if you want more results shown, only showing 50 for now. also, a colored star means that piece of evidence has been verified. retrieved {time}
        {response.limitReached}
      </p>
      <details className="summary-plan">
        <summary>query path</summary>
        <p className="summary-head">Applied constraints</p>
        <ul>
          {response.queryPlan.appliedConstraints.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <p className="summary-head">Queries ({response.queryPlan.queries.length})</p>
        <ul>
          {response.queryPlan.queries.map((q) => (
            <li key={q.id}>
              <strong>{q.kind}</strong> &ldquo;{q.text}&rdquo; · {q.reason}
              {q.stateFilter && ` · state ${q.stateFilter}`}
            </li>
          ))}
        </ul>
        {response.sources.length > 0 && (
          <>
            <p className="summary-head">Discovery paths</p>
            <ul>
              {response.sources.map((src) => (
                <li key={src.source}>
                  <strong>{src.source}</strong>: {src.leads} leads · {src.inspected} pages inspected ·{" "}
                  {src.people} people
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="summary-head">Steps</p>
        <ol>
          {response.queryPlan.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </details>
      {response.sourceErrors.length > 0 && (
        <ul className="summary-errors">
          {response.sourceErrors.map((e) => (
            <li key={e.source}>
              {e.source}: {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
