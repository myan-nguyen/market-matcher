import { normalizeUrl } from "@/lib/leads";
import { normalizeName } from "@/lib/identity";
import type {
  Candidate,
  DiscoveredLead,
  LeadLogEntry,
  TraceRow,
  TraceStage,
  TraceStep,
} from "@/types/search";

/**
 * Follows chosen names or URL fragments through every stage:
 * discovered -> fetched -> extracted -> verified -> scored -> selected.
 * The row stops at the first stage that failed and says why, so a missing person
 * points at the real drop point instead of at a search limit.
 */

export type TraceInput = {
  terms: string[];
  discovered: DiscoveredLead[];
  leadLog: LeadLogEntry[];
  resolved: Candidate[]; // people after resolvePeople
  rejected: Map<string, string>; // candidate id -> verifyClaims reason
  verified: Candidate[];
  scored: Candidate[];
  selected: Candidate[];
  minScore: number;
};

const isUrlTerm = (t: string) => /[./]/.test(t) && !/\s/.test(t);
const hasTerm = (c: Candidate, term: string) => {
  const t = term.toLowerCase();
  return isUrlTerm(term)
    ? [...c.profiles.map((p) => p.url), ...c.evidence.map((e) => e.url)].some((u) => u.toLowerCase().includes(t))
    : normalizeName(c.name).includes(normalizeName(term));
};

export function buildTrace(input: TraceInput): TraceRow[] {
  return input.terms.map((term) => {
    const t = term.toLowerCase();
    const matchUrl = (u: string) => (isUrlTerm(term) ? normalizeUrl(u).includes(normalizeUrl(t)) || u.toLowerCase().includes(t) : false);
    const steps: TraceStep[] = [];
    const push = (stage: TraceStage, ok: boolean, detail: string) => steps.push({ stage, ok, detail });
    const done = (): TraceRow => ({ term, steps, stoppedAt: steps.find((s) => !s.ok)?.stage ?? null });

    const person = input.resolved.find((c) => hasTerm(c, term));
    const leads = input.discovered.filter(
      (d) => matchUrl(d.url) || (!isUrlTerm(term) && normalizeName(d.title ?? "").includes(normalizeName(term))),
    );

    // discovered
    if (leads.length === 0 && !person) {
      push("discovered", false, "No search result, directory entry or author record matched. Discovery never returned it; check the queries and which domains were searched.");
      return done();
    }
    push("discovered", true, leads.length ? `${leads.length} lead${leads.length === 1 ? "" : "s"}: ${leads.slice(0, 3).map((l) => `${l.url} (${l.source})`).join("; ")}` : "Found only through an author record.");

    // fetched
    const leadUrls = leads.map((l) => l.url);
    const logged = input.leadLog.filter((e) => matchUrl(e.url) || leadUrls.includes(e.url));
    const notInspected = leads.filter((l) => !l.inspected);
    if (leads.length && logged.length === 0) {
      push("fetched", false, notInspected.length ? "Discovered but cut by the inspection cap before it was fetched." : "No fetch was recorded.");
      if (!person) return done();
    } else if (logged.length) {
      const bad = logged.filter((e) => e.fetch !== "ok");
      push("fetched", bad.length === 0, bad.length ? `Fetch failed: ${bad[0].reason ?? "unknown"}` : "Page fetched.");
    } else {
      push("fetched", true, "No page needed; person came from an author record.");
    }

    // extracted
    if (!person) {
      const why = logged.find((e) => e.extraction !== "person" && e.extraction !== "directory");
      push("extracted", false, why ? `No person was read from the page (${why.extraction}${why.reason ? `: ${why.reason}` : ""}).` : "No person was read from this page.");
      return done();
    }
    push("extracted", true, `Person "${person.name}" with ${person.profiles.length} profile page${person.profiles.length === 1 ? "" : "s"}${person.profiles.some((p) => p.provisional) ? " (some provisional)" : ""}.`);

    // verified
    const reason = input.rejected.get(person.id);
    const kept = input.verified.find((c) => c.id === person.id);
    push("verified", Boolean(kept), kept ? "Passed identity, source, affiliation, topic and filter checks." : `Rejected: ${reason ?? "unknown"}.`);
    if (!kept) return done();

    // scored
    const scored = input.scored.find((c) => c.id === person.id);
    if (!scored) {
      push("scored", false, "Not scored.");
      return done();
    }
    const parts = (scored.scoreBreakdown ?? []).map((s) => `${s.key} ${s.points}/${s.max}`).join(", ");
    const rank = input.scored.findIndex((c) => c.id === person.id) + 1;
    push("scored", true, `Score ${scored.score} (rank ${rank} of ${input.scored.length}): ${parts}.`);

    // selected
    const sel = input.selected.some((c) => c.id === person.id);
    push(
      "selected",
      sel,
      sel ? "In the final list." : scored.score < input.minScore ? `Score ${scored.score} is below the cutoff of ${input.minScore}.` : "Ranked below the 50-person cap.",
    );
    return done();
  });
}
