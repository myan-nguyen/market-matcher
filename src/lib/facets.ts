import { normalizeName } from "@/lib/identity";
import type { OrgRecord } from "@/lib/orgs";
import { stateName, US_STATES } from "@/lib/states";
import type { Facets, SearchRequest } from "@/types/search";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "Brown University" -> "Brown". Lets a short mention resolve to the full record. */
const SHORT_FORM = /^(?:the )?(?:university of |college of )?(.+?)(?: (?:university|college|institute of technology|institute|hospital|medical center))?$/i;

const stateNames = new Set(US_STATES.map((s) => s.name.toLowerCase()));

function shortForms(o: OrgRecord): string[] {
  return [o.name, ...o.aliases].flatMap((n) => {
    const m = SHORT_FORM.exec(n.trim());
    const short = m?.[1]?.trim() ?? "";
    // A short form that is also a state ("Rhode Island") would turn the location into an institution.
    return short.length >= 4 && short !== n && !stateNames.has(short.toLowerCase()) ? [short] : [];
  });
}

type Found = { name: string; phrase: string; org: OrgRecord | null };

/**
 * Finds a named institution in free text. Known organization records win;
 * otherwise a generic "University of X" / "X University" pattern is used.
 */
export function findInstitution(text: string, orgs: OrgRecord[]): Found | null {
  let best: Found | null = null;
  const consider = (f: Found) => {
    if (!best || f.phrase.length > best.phrase.length) best = f;
  };
  for (const o of orgs) {
    for (const n of [o.name, ...o.aliases]) {
      if (n.length >= 4 && new RegExp(`\\b${escape(n)}\\b`, "i").test(text)) {
        consider({ name: o.name, phrase: n, org: o });
      }
    }
    for (const s of shortForms(o)) {
      if (new RegExp(`\\b${escape(s)}\\b`).test(text)) consider({ name: o.name, phrase: s, org: o });
    }
  }
  if (best) return best;
  const generic =
    /\b(University of [A-Z][\w'-]+(?: [A-Z][\w'-]+)*|[A-Z][\w'-]+(?: [A-Z][\w'-]+)* (?:University|College|Institute of Technology|Institute))\b/.exec(
      text,
    );
  return generic ? { name: generic[1], phrase: generic[1], org: null } : null;
}

/** Splits the request into independent parts. No part has to appear verbatim in a source. */
export function parseFacets(req: SearchRequest, orgs: OrgRecord[]): Facets {
  const text = [req.query, req.cohort, ...req.include].join(" . ");
  const found = findInstitution(text, orgs);
  const region = stateName(req.state);

  const strip = (s: string): string => {
    let out = s;
    if (found) out = out.replace(new RegExp(`\\b(?:at|from|in|of)?\\s*${escape(found.phrase)}\\b`, "gi"), " ");
    if (region) out = out.replace(new RegExp(`\\b(?:in|at|from)?\\s*${escape(region)}\\b`, "gi"), " ");
    return out.replace(/\s+/g, " ").replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "");
  };

  const topic = strip(req.query) || strip(req.cohort);
  const cohort = strip(req.cohort);
  const seen = new Set([normalizeName(topic)]);
  const related = [...req.include, ...req.prefer, ...(req.method ? [req.method] : [])]
    .map(strip)
    .filter((t) => {
      const k = normalizeName(t);
      if (!t || seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  return {
    topic,
    cohort: normalizeName(cohort) === normalizeName(topic) ? "" : cohort,
    related,
    institution: found
      ? {
          name: found.name,
          domains: found.org?.domains ?? [],
          openalexId: found.org?.ids.openalex,
        }
      : null,
    state: req.state,
    stages: req.stages,
  };
}
