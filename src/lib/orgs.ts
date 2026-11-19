import { hostOf } from "@/lib/leads";
import { fetchStateOrganizations, searchOrganization, type OAOrganization } from "@/lib/openalex";
import type { Lead } from "@/lib/leads";

export type OrgType =
  | "university"
  | "hospital"
  | "company"
  | "government"
  | "nonprofit"
  | "center"
  | "other";

/**
 * An organization, not a domain list. A person's employer, lab and
 * participating center are separate relationships, so a center that has its
 * own site points at its parent instead of being merged into it.
 */
export type OrgRecord = {
  id: string; // openalex id, ror id, or an override slug
  name: string;
  aliases: string[];
  state: string | null; // two-letter code
  type: OrgType;
  domains: string[]; // website hosts, no scheme
  directoryUrls: string[]; // people, team, trainee or lab listings
  parentId: string | null;
  ids: { openalex?: string; ror?: string };
};

/**
 * Centers and internal units usually lack their own ROR ID. Add them here.
 * Adding a center means adding a record and URLs, not writing a scraper.
 */
export const ORG_OVERRIDES: OrgRecord[] = [];

const OA_TYPE: Record<string, OrgType> = {
  education: "university",
  healthcare: "hospital",
  company: "company",
  government: "government",
  nonprofit: "nonprofit",
  facility: "center",
};

const bareHost = (url: string | null | undefined): string | null => {
  const h = url ? hostOf(url).replace(/^www\./, "") : "";
  return h || null;
};

export function toOrgRecord(o: OAOrganization, state: string): OrgRecord {
  const domain = bareHost(o.homepage_url);
  return {
    id: o.id.replace("https://openalex.org/", ""),
    name: o.display_name,
    aliases: o.display_name_alternatives ?? [],
    state,
    type: OA_TYPE[o.type ?? ""] ?? "other",
    domains: domain ? [domain] : [],
    directoryUrls: [],
    parentId: null,
    ids: {
      openalex: o.id.replace("https://openalex.org/", ""),
      ...(o.ror ? { ror: o.ror.replace("https://ror.org/", "") } : {}),
    },
  };
}

/** State organizations from OpenAlex plus overrides. Overrides win on id. */
export async function loadOrganizations(state: string | null): Promise<OrgRecord[]> {
  const seeded = state
    ? (await fetchStateOrganizations(state)).map((o) => toOrgRecord(o, state))
    : [];
  const overrides = ORG_OVERRIDES.filter((o) => !state || !o.state || o.state === state);
  const ids = new Set(overrides.map((o) => o.id));
  return [...overrides, ...seeded.filter((o) => !ids.has(o.id))];
}

/** Resolves an institution named in the query when no seeded record matched it. */
export async function resolveNamedOrganization(name: string, state: string | null): Promise<OrgRecord | null> {
  const found = await searchOrganization(name);
  return found ? toOrgRecord(found, state ?? "") : null;
}

/** Known directory pages are inspected directly, with no search needed. */
export function directoryLeads(orgs: OrgRecord[]): Lead[] {
  return orgs.flatMap((o) =>
    o.directoryUrls.map((url) => ({
      url,
      title: o.name,
      snippet: null,
      source: "institutional" as const,
      queryId: `org:${o.id}`,
    })),
  );
}
