import { orgOverlap } from "@/lib/identity";
import type { InspectedPage, StageHit } from "@/lib/inspect";
import { hostOf, isInstitutionalHost } from "@/lib/leads";
import { stateName } from "@/lib/states";
import type {
  Claim,
  Contact,
  InspectedProfile,
  Organization,
  StageCode,
} from "@/types/search";

export function unknownClaim<T>(note: string | null = null): Claim<T> {
  return { value: null, status: "unknown", source: null, retrievedAt: null, note };
}

/** A fetched page that Beautiful Soup recognised as one person's profile. */
export type PersonPage = {
  url: string; // final URL after redirects
  retrievedAt: string;
  institutional: boolean;
  name: string;
  orgs: string[];
  headline: string;
  stageHits: StageHit[];
  states: string[];
  focus: string | null;
  emails: string[];
  contactPage: string | null;
};

export function toPersonPage(p: InspectedPage): PersonPage | null {
  const x = p.parsed;
  if (x.kind !== "person" || !x.name) return null;
  return {
    url: p.fetched.finalUrl,
    retrievedAt: p.fetched.retrievedAt,
    institutional: isInstitutionalHost(hostOf(p.fetched.finalUrl)),
    name: x.name,
    orgs: x.orgs ?? [],
    headline: x.headline ?? "",
    stageHits: x.stage_hits ?? [],
    states: x.states ?? [],
    focus: x.focus ?? null,
    emails: x.emails ?? [],
    contactPage: x.contact_page ?? null,
  };
}

/**
 * The first published contact that belongs to this person. An email counts only
 * if its local part matches the person's name (e.g. "akshayn", "anarayan",
 * "akshay.narayan"), so a department inbox or a colleague's address on the same
 * page is not attributed to them. Institutional pages are checked first.
 */
/**
 * Researchers who asked for their contact details to be removed. Comma-separated
 * emails or full names in CONTACT_OPT_OUT. Their card shows no contact.
 */
function optedOut(name: string, email: string | null): boolean {
  const list = (process.env.CONTACT_OPT_OUT ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(name.toLowerCase()) || (email !== null && list.includes(email.toLowerCase()));
}

export function deriveContact(name: string, pages: PersonPage[]): Contact {
  const c = findContact(name, pages);
  return optedOut(name, c.kind === "email" ? c.value : null)
    ? { kind: "none", value: null, source: null, checkedAt: c.checkedAt }
    : c;
}

function findContact(name: string, pages: PersonPage[]): Contact {
  const parts = name.toLowerCase().normalize("NFD").replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  const belongs = (email: string) => {
    const local = email.split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
    return (
      (last.length >= 3 && local.includes(last)) ||
      (first.length >= 3 && local.includes(first)) ||
      (first && last && (local === first[0] + last || local === first + last[0]))
    );
  };
  const ordered = [...pages].sort(byInstitutional);
  for (const p of ordered) {
    const email = p.emails.find(belongs);
    if (email) return { kind: "email", value: email, source: p.url, checkedAt: p.retrievedAt };
  }
  for (const p of ordered) {
    if (p.contactPage) return { kind: "page", value: p.contactPage, source: p.url, checkedAt: p.retrievedAt };
  }
  const latest = ordered.map((p) => p.retrievedAt).sort().pop() ?? null;
  return { kind: "none", value: null, source: null, checkedAt: latest };
}

export function toProfile(p: PersonPage): InspectedProfile {
  return {
    url: p.url,
    retrievedAt: p.retrievedAt,
    institutional: p.institutional,
    name: p.name,
    headline: p.headline,
  };
}

const byInstitutional = (a: PersonPage, b: PersonPage) =>
  Number(b.institutional) - Number(a.institutional);

/* ---------- career stage ---------- */

// Simple categories: faculty, PhD, postdoc. Any PhD student or candidate is "PhD"
// (stored as advanced-phd, labeled "PhD"); how far along is not guessed.
const STAGE_OF: Record<StageHit["kind"], StageCode | null> = {
  postdoc: "postdoc",
  "phd-candidate": "advanced-phd",
  "phd-student": "advanced-phd",
  faculty: "faculty",
};

type StageRead = { page: PersonPage; values: StageCode[]; strong: boolean };

/** Where the stage words were found decides how much they count: header over opening body text. */
function readStage(page: PersonPage): StageRead | null {
  const header = page.stageHits.filter((h) => h.where !== "body");
  // The opening of a personal page ("I am a fifth-year PhD student…") states the
  // person's own role; it is used when the header names none, as a weaker read.
  const hits = header.length ? header : page.stageHits.filter((h) => h.where === "body").slice(0, 1);
  if (hits.length === 0) return null;
  const values: StageCode[] = [];
  for (const h of hits) {
    const v = STAGE_OF[h.kind];
    if (v && !values.includes(v)) values.push(v);
  }
  // Several roles in one header ("Professor … advises PhD students"): the senior role wins.
  const order: StageCode[] = ["faculty", "postdoc", "advanced-phd", "early-phd"];
  values.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { page, values: values.slice(0, 1), strong: header.length > 0 };
}

export function deriveStage(pages: PersonPage[]): Claim<StageCode> {
  const reads = pages.map(readStage).filter((r): r is StageRead => r !== null);
  if (reads.length === 0) {
    return unknownClaim("No inspected profile stated a career stage in its header.");
  }

  const firm = reads.filter((r) => r.page.institutional && r.strong && r.values.length === 1);
  const firmValues = new Set(firm.map((r) => r.values[0]));
  const clashing = reads.filter((r) => r.values.length > 1);

  if (firmValues.size > 1 || (firm.length > 0 && clashing.length > 0) || (firm.length === 0 && clashing.length > 0)) {
    const where = [...firm, ...clashing][0].page;
    return {
      value: null,
      status: "conflicting",
      source: where.url,
      retrievedAt: where.retrievedAt,
      note: "Profile pages name different career stages.",
    };
  }
  if (firmValues.size === 1) {
    const r = firm[0];
    return {
      value: r.values[0],
      status: "verified",
      source: r.page.url,
      retrievedAt: r.page.retrievedAt,
      note: "Read from the header of an institutional profile.",
    };
  }

  const single = reads.filter((r) => r.values.length === 1);
  const singleValues = new Set(single.map((r) => r.values[0]));
  if (singleValues.size > 1) {
    return {
      value: null,
      status: "conflicting",
      source: single[0].page.url,
      retrievedAt: single[0].page.retrievedAt,
      note: "Pages name different career stages.",
    };
  }
  if (singleValues.size === 1) {
    const r = single[0];
    return {
      value: r.values[0],
      status: "inferred",
      source: r.page.url,
      retrievedAt: r.page.retrievedAt,
      note: "Stage comes from a page that is not an institutional site.",
    };
  }
  return unknownClaim('A profile says "PhD student" without saying how advanced.');
}

/* ---------- location ---------- */

export function deriveLocation(
  pages: PersonPage[],
  orgNames: string[],
  stateOrgNames: string[],
  requestedState: string | null,
  fallback: Claim<string>,
): Claim<string> {
  // A page that lists several states is ambiguous, so it proves nothing.
  const single = pages.filter((p) => p.states.length === 1);
  const inst = single.filter((p) => p.institutional);
  const instStates = new Set(inst.map((p) => p.states[0]));

  if (instStates.size > 1) {
    return {
      value: null,
      status: "conflicting",
      source: inst[0].url,
      retrievedAt: inst[0].retrievedAt,
      note: "Institutional pages list different states.",
    };
  }
  if (instStates.size === 1) {
    return {
      value: inst[0].states[0],
      status: "verified",
      source: inst[0].url,
      retrievedAt: inst[0].retrievedAt,
      note: "State read from the address on an institutional profile page.",
    };
  }
  const other = single.filter((p) => !p.institutional);
  if (other.length > 0) {
    return {
      value: other[0].states[0],
      status: "inferred",
      source: other[0].url,
      retrievedAt: other[0].retrievedAt,
      note: "State comes from a page that is not an institutional site.",
    };
  }
  if (requestedState && orgOverlap(orgNames, stateOrgNames)) {
    return {
      value: requestedState,
      status: "inferred",
      source: fallback.source,
      retrievedAt: fallback.retrievedAt,
      note: `Organization is listed in ${stateName(requestedState)} by OpenAlex. No profile stated a location.`,
    };
  }
  return fallback;
}

/* ---------- organization ---------- */

export function deriveOrgs(
  publicationOrgs: Organization[],
  pages: PersonPage[],
): { orgs: Organization[]; questions: string[] } {
  const profile: Organization[] = [];
  for (const p of [...pages].sort(byInstitutional)) {
    const name = p.orgs[0];
    if (!name || profile.some((o) => orgOverlap([o.name], [name]))) continue;
    profile.push({
      name,
      lab: null,
      status: p.institutional ? "verified" : "inferred",
      source: p.url,
      retrievedAt: p.retrievedAt,
    });
  }
  const verified = profile.filter((o) => o.status === "verified");
  if (verified.length > 1) verified.forEach((o) => (o.status = "conflicting"));

  const kept = publicationOrgs.filter((o) => !profile.some((p) => orgOverlap([p.name], [o.name])));
  const questions: string[] = [];
  if (profile.length > 0 && kept.length > 0) {
    questions.push(
      `Publication affiliation (${kept.map((o) => o.name).join(", ")}) differs from the profile organization (${profile[0].name}).`,
    );
  }
  return { orgs: [...profile, ...kept], questions };
}

/* ---------- research focus ---------- */

export function deriveFocus(pages: PersonPage[]): Claim<string> {
  const page = [...pages].sort(byInstitutional).find((p) => p.focus);
  if (!page || !page.focus) return unknownClaim("No research description found on inspected pages.");
  return {
    value: page.focus,
    status: page.institutional ? "verified" : "inferred",
    source: page.url,
    retrievedAt: page.retrievedAt,
    note: page.institutional ? null : "Description comes from a page that is not an institutional site.",
  };
}

/* ---------- open questions ---------- */

export function openQuestions(c: {
  stage: Claim<StageCode>;
  location: Claim<string>;
  organizations: Organization[];
  profiles: InspectedProfile[];
  extra: string[];
}): string[] {
  const out: string[] = [];
  if (c.profiles.length === 0) out.push("No current profile page was found or readable.");
  const line = (label: string, claim: Claim<unknown>) => {
    if (claim.status === "verified") return;
    out.push(`${label}: ${claim.note ?? claim.status}`);
  };
  line("Stage", c.stage);
  line("Location", c.location);
  if (!c.organizations.some((o) => o.status === "verified")) {
    const conflict = c.organizations.some((o) => o.status === "conflicting");
    out.push(
      conflict
        ? "Organization: profile pages name different organizations."
        : "Organization: no institutional profile confirmed it.",
    );
  }
  out.push(...c.extra);
  return out;
}
