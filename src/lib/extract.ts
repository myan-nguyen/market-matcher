import nlp from "compromise";
import type { Lead } from "@/lib/leads";
import { hostOf } from "@/lib/leads";
import { hostMatchesOrg } from "@/lib/identity";

/** A lead whose page could not be read. Kept so it can be verified later. */
export type ProvisionalPerson = {
  name: string;
  org: string | null;
  url: string;
  text: string; // title / snippet / directory context the name came from
  retrievedAt: string;
};

/** Words that name a program, unit or page, never a person. */
export const NOT_A_NAME =
  /universit|college|institute|hospital|school|center|centre|laborator|department|medical|academy|foundation|association|society|news|home|welcome|directory|newsletter|faculty|staff|people|events|admissions|library|program|research|\blabs?\b|group|team|publications|initiative|project|consortium|council|committee|office|network|alliance|collaborative|partnership|studies|services|resources|curriculum|courses|seminar|colloquium|symposium|conference|workshop|opportunities|about|contact|overview/i;

/**
 * Final guard for anything shown as a result: a person has 2-5 name parts and
 * none of them names a program, unit or page ("Brazil Initiative").
 * Lowercase particles such as "van" or "de" are allowed.
 */
export function looksLikePerson(name: string, fromFreeText = true): boolean {
  const s = name.replace(/\s+/g, " ").trim();
  if (!s || NOT_A_NAME.test(s) || /\d/.test(s)) return false;
  const parts = s.split(" ");
  if (parts.length < 2 || parts.length > 5) return false;
  if (!parts.every((t) => /^[\p{L}][\p{L}.'\u2019-]*$/u.test(t)) || !/^[A-Z\u00C0-\u00DE]/.test(parts[0])) return false;
  // Every word is tagged on its own, in lowercase. A name's words are names or
  // unknown words (Schwarzkopf, Krishnamurthi); a heading has an ordinary
  // adjective, verb, plural or acronym ("High Performance Computing",
  // "Graduate Students Advised", "Cybersecurity BS", "Next Page").
  const words = parts.filter((p) => !/^[A-Z]\.?$/.test(p)); // middle initials
  if (words.some((p) => /^[A-Z]{2,}$/.test(p))) return false;
  const HEADING = /^(?:Adjective|Verb|Adverb|Preposition|Determiner|Conjunction|Pronoun|Plural|Gerund|PastTense)$/;
  for (const p of words) {
    if (/[^\x00-\x7F]/.test(p)) continue; // the English tagger has no view on non-ASCII names
    const tags: string[] = nlp(p.toLowerCase()).terms().json()[0]?.terms[0]?.tags ?? [];
    if (!tags.includes("Person") && tags.some((t) => HEADING.test(t))) return false;
  }
  // Names from author records or person pages are already known to be people.
  // Names lifted from free text also need a person tag ("Campus Life" is two nouns).
  if (!fromFreeText) return true;
  if (nlp(s).people().length === 0) return false;
  return true;
}
const ORG_WORDS = /universit|college|institute|hospital|school|center|centre|laborator|medical|academy/i;
const SPLIT_TITLE = /\s+[|\u2013\u2014-]\s+|:\s+/;
const LEADING_TITLE = /^(?:dr|prof|professor)\.?\s+/i;
const TRAILING_DEGREE = /,?\s*(?:ph\.?d\.?|m\.?d\.?|m\.?s\.?c?\.?|m\.?p\.?h\.?|d\.?phil\.?)\b.*$/i;

export function cleanName(raw: string | null | undefined): string | null {
  let s = (raw ?? "").replace(/\s+/g, " ").trim();
  const flipped = /^([^,]+),\s*([^,]+)$/.exec(s); // "Last, First"
  if (flipped) s = `${flipped[2]} ${flipped[1]}`;
  s = s.replace(LEADING_TITLE, "").replace(TRAILING_DEGREE, "").trim();
  if (!s || NOT_A_NAME.test(s)) return null;
  const tokens = s.split(" ");
  if (tokens.length < 2 || tokens.length > 4) return null;
  for (const t of tokens) {
    if (!/^[A-Z\u00C0-\u00DE]/.test(t)) return null;
    if (!/^[\p{L}.'\u2019-]+$/u.test(t)) return null;
  }
  return s;
}

/** First segment of a title or snippet that reads as a personal name. */
export function nameFromText(title: string | null, snippet: string | null): string | null {
  for (const seg of (title ?? "").split(SPLIT_TITLE)) {
    const n = cleanName(seg);
    if (n) return n;
  }
  const m = /^\s*((?:Dr\.|Prof\.|Professor)?\s*[A-Z][\p{L}.'-]+(?: [A-Z][\p{L}.'-]+){1,3}) (?:is|joined|received|holds|leads|directs)\b/u.exec(
    snippet ?? "",
  );
  return m ? cleanName(m[1]) : null;
}

/** An organization named in the title segments or snippet, or the known institution when the host matches it. */
export function orgFromText(
  url: string,
  title: string | null,
  snippet: string | null,
  institution: { name: string; domains: string[] } | null,
): string | null {
  const host = hostOf(url);
  if (
    institution &&
    (institution.domains.some((d) => host === d || host.endsWith(`.${d}`)) || hostMatchesOrg(host, [institution.name]))
  ) {
    return institution.name;
  }
  for (const seg of (title ?? "").split(SPLIT_TITLE).slice(1)) {
    if (ORG_WORDS.test(seg)) return seg.trim();
  }
  const m = /\b(?:at|of) (?:the )?((?:University of )?[A-Z][\w&'-]+(?: [A-Z][\w&'-]+)*(?: University| College| Institute| Laboratory)?)/.exec(
    snippet ?? "",
  );
  return m && ORG_WORDS.test(m[1]) ? m[1] : null;
}

export function provisionalFromLead(
  lead: Pick<Lead, "url" | "title" | "snippet">,
  institution: { name: string; domains: string[] } | null,
  now: string,
): ProvisionalPerson | null {
  const name = nameFromText(lead.title, lead.snippet);
  if (!name || !looksLikePerson(name)) return null;
  return {
    name,
    org: orgFromText(lead.url, lead.title, lead.snippet, institution),
    url: lead.url,
    text: [lead.title, lead.snippet].filter(Boolean).join(" · ").slice(0, 400),
    retrievedAt: now,
  };
}
