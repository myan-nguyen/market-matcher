import type {
  Candidate,
  MatchGroup,
  OpportunityStatus,
  SearchRequest,
} from "@/types/search";

export function hasConstraints(req: SearchRequest): boolean {
  return Boolean(req.state) || req.stages.length > 0;
}

/**
 * Only explicit constraints count. A verified value that contradicts a
 * constraint is excluded; anything inferred or unknown needs checking and
 * is never treated as a verified match.
 */
export function classify(c: Candidate, req: SearchRequest): MatchGroup | "excluded" {
  let verified = true;

  if (req.state) {
    const loc = c.location;
    if (loc.status === "verified" && loc.value && loc.value !== req.state) return "excluded";
    if (!(loc.status === "verified" && loc.value === req.state)) verified = false;
  }

  if (req.stages.length) {
    const s = c.stage;
    if (s.status === "verified" && s.value && !req.stages.includes(s.value)) return "excluded";
    if (!(s.status === "verified" && s.value && req.stages.includes(s.value))) verified = false;
  }

  return verified ? "verified" : "needs-checking";
}

export function opportunityStatus(c: Candidate): OpportunityStatus {
  const checks = c.opportunityChecks;
  if (checks.length === 0 || checks.every((x) => x.status === "not checked")) {
    return "not checked";
  }
  if (checks.every((x) => x.status === "checked")) return "checked";
  return "unresolved";
}

export function newestEvidence(c: Candidate): number {
  return Math.max(0, ...c.evidence.map((e) => Date.parse(e.date) || 0));
}
