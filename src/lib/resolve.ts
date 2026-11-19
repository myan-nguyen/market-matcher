import { normalizeName, orgOverlap } from "@/lib/identity";
import type { Candidate, Claim, ClaimStatus, Organization } from "@/types/search";

/**
 * Identity resolution.
 *  1. Strong keys: same ORCID or same OpenAlex author ID always merge.
 *  2. Name + organization is weaker. It merges only when the full first and last
 *     names match (initials are not enough), an organization is shared, and the
 *     two records do not carry different ORCID iDs.
 *  3. Similar names that fail those tests stay separate and are flagged.
 */

function fullName(a: string, b: string): boolean {
  const x = normalizeName(a).split(" ");
  const y = normalizeName(b).split(" ");
  if (x.length < 2 || y.length < 2) return false;
  return x[0].length > 1 && x[0] === y[0] && x[x.length - 1] === y[y.length - 1];
}

function sameSurnameInitial(a: string, b: string): boolean {
  const x = normalizeName(a).split(" ");
  const y = normalizeName(b).split(" ");
  if (x.length < 2 || y.length < 2) return false;
  return x[x.length - 1] === y[y.length - 1] && x[0][0] === y[0][0];
}

const orgNames = (c: Candidate) => c.organizations.map((o) => o.name);

function strongMatch(a: Candidate, b: Candidate): boolean {
  return (
    (!!a.orcid && a.orcid === b.orcid) ||
    (!!a.openalexId && a.openalexId === b.openalexId)
  );
}

function cautiousMatch(a: Candidate, b: Candidate): boolean {
  if (a.orcid && b.orcid && a.orcid !== b.orcid) return false;
  if (a.openalexId && b.openalexId && a.openalexId !== b.openalexId) {
    // Two different OpenAlex IDs are only combined if an ORCID ties them (handled above).
    return false;
  }
  return fullName(a.name, b.name) && orgOverlap(orgNames(a), orgNames(b));
}

const RANK: Record<ClaimStatus, number> = { verified: 3, conflicting: 2, inferred: 1, unknown: 0 };

function mergeClaim<T>(a: Claim<T>, b: Claim<T>): Claim<T> {
  if (a.status === "verified" && b.status === "verified" && a.value !== b.value) {
    return {
      value: null,
      status: "conflicting",
      source: null,
      retrievedAt: null,
      note: `Merged records disagree: ${String(a.value)} vs ${String(b.value)}.`,
    };
  }
  return RANK[b.status] > RANK[a.status] ? b : a;
}

function mergeOrgs(a: Organization[], b: Organization[]): Organization[] {
  const out = new Map<string, Organization>();
  for (const o of [...a, ...b]) {
    const key = normalizeName(o.name);
    const prev = out.get(key);
    if (!prev || RANK[o.status] > RANK[prev.status]) out.set(key, o);
  }
  return [...out.values()];
}

const uniq = <T,>(xs: T[], key: (x: T) => string) => {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
};

function merge(primary: Candidate, other: Candidate): Candidate {
  return {
    ...primary,
    orcid: primary.orcid ?? other.orcid,
    openalexId: primary.openalexId ?? other.openalexId,
    organizations: mergeOrgs(primary.organizations, other.organizations),
    stage: mergeClaim(primary.stage, other.stage),
    location: mergeClaim(primary.location, other.location),
    focus: mergeClaim(primary.focus, other.focus),
    methods: [...new Set([...primary.methods, ...other.methods])],
    evidence: uniq([...primary.evidence, ...other.evidence], (e) => e.url + e.label).slice(0, 5),
    opportunityChecks: primary.opportunityChecks.length ? primary.opportunityChecks : other.opportunityChecks,
    unresolvedQuestions: [...new Set([...primary.unresolvedQuestions, ...other.unresolvedQuestions])],
    matchedQueries: [...new Set([...primary.matchedQueries, ...other.matchedQueries])],
    profiles: uniq([...primary.profiles, ...other.profiles], (p) => p.url),
    foundBy: [...new Set([...primary.foundBy, ...other.foundBy])],
    excerpts: uniq([...(primary.excerpts ?? []), ...(other.excerpts ?? [])], (x) => x.url + x.text),
    score: Math.max(primary.score, other.score) + 3,
  };
}

export type ResolveResult = { people: Candidate[]; merged: number; similar: number };

export function resolveIdentities(input: Candidate[]): ResolveResult {
  const sorted = [...input].sort((a, b) => b.score - a.score);
  const out: Candidate[] = [];
  let merged = 0;

  for (const c of sorted) {
    const i = out.findIndex((p) => strongMatch(p, c) || cautiousMatch(p, c));
    if (i >= 0) {
      out[i] = merge(out[i], c);
      merged++;
    } else {
      out.push(c);
    }
  }

  // Similar but unmerged names: keep both, tell the reader.
  let similar = 0;
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (!sameSurnameInitial(out[i].name, out[j].name)) continue;
      for (const [a, b] of [[i, j], [j, i]]) {
        const note = `Another result, ${out[b].name}, has a similar name. Not merged: no shared ORCID, OpenAlex ID, or organization.`;
        if (!out[a].unresolvedQuestions.includes(note)) {
          out[a] = { ...out[a], unresolvedQuestions: [...out[a].unresolvedQuestions, note] };
        }
      }
      similar++;
    }
  }
  return { people: out, merged, similar };
}
