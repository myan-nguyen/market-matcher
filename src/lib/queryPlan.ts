import type { QueryPlan, RetrievalQuery, SearchRequest } from "@/types/search";
import { STAGE_LABELS } from "@/types/search";
import { stateName } from "@/lib/states";
import { conciseQuery } from "@/lib/keyphrases";

export const MAX_QUERIES = 12;

const join = (...parts: string[]) => parts.filter(Boolean).join(" ").trim();

/**
 * Turns the form into several related retrieval queries instead of one
 * long phrase, so a person is not lost because one paper omitted a term.
 */
export function buildQueryPlan(req: SearchRequest): QueryPlan {
  const stateFilter = req.state;
  const queries: RetrievalQuery[] = [];
  const add = (q: Omit<RetrievalQuery, "id" | "stateFilter">) => {
    if (queries.length >= MAX_QUERIES) return;
    if (queries.some((x) => x.text.toLowerCase() === q.text.toLowerCase())) return;
    queries.push({ ...q, id: `q${queries.length + 1}`, stateFilter });
  };

  // Broad discovery: the key phrases first (what papers and profiles actually say),
  // then the main phrase, cohort, and both together.
  const concise = conciseQuery(req.query).replace(/"/g, "");
  if (concise && concise.toLowerCase() !== req.query.toLowerCase()) {
    add({ kind: "discovery", text: concise, reason: "Key phrases of the main phrase" });
  }
  add({ kind: "discovery", text: req.query, reason: "Main phrase alone" });
  add({ kind: "discovery", text: req.cohort, reason: "Cohort text alone" });
  add({
    kind: "discovery",
    text: join(req.query, req.cohort),
    reason: "Main phrase with cohort",
  });

  // Narrower variations: one per include term. They add recall, never replace it.
  for (const term of req.include) {
    add({
      kind: "include",
      text: join(req.query, term),
      reason: `Main phrase narrowed by include term "${term}"`,
    });
  }

  const constraints: string[] = [];
  if (req.state) constraints.push(`State: ${stateName(req.state)} (applied at source)`);
  if (req.stages.length)
    constraints.push(
      `Stages: ${req.stages.map((s) => STAGE_LABELS[s]).join(", ")} (checked during enrichment)`,
    );
  if (req.method) constraints.push(`Method: ${req.method} (classifies and ranks)`);
  if (req.include.length) constraints.push(`Include: ${req.include.join(", ")} (extra queries)`);
  if (req.prefer.length) constraints.push(`Prefer: ${req.prefer.join(", ")} (ranking only)`);
  if (req.exclude.length)
    constraints.push(`Exclude: ${req.exclude.join(", ")} (applied after retrieval)`);

  return {
    queries,
    ranking: { prefer: req.prefer, method: req.method },
    postFilters: { exclude: req.exclude },
    enrichment: { stages: req.stages },
    steps: [
      `Run ${queries.length} related queries independently`,
      "Merge results and resolve duplicate people",
      "Check promising candidates against current institutional profiles",
      "Drop people whose evidence matches an exclude term",
      "Rank by research fit, prefer terms, method and evidence",
    ],
    appliedConstraints: constraints.length
      ? constraints
      : ["None. Open researcher search across all fields."],
  };
}
