import type { Facets } from "@/types/search";

export type WebQuery = { id: string; text: string; branch: string };

const STAGE_WORDS = {
  postdoc: "postdoctoral researcher",
  "advanced-phd": "PhD candidate",
  "early-phd": "PhD student",
  faculty: "professor",
} as const;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * A small set of varied searches built from facets, not one phrase. State and
 * stage appear only when selected, and only as discovery clues: a current page
 * has to verify them later. Nothing here is specific to one institution.
 */
export function webQueryTexts(f: Facets, stateLabel: string | null): { people: WebQuery[]; web: WebQuery[] } {
  const inst = f.institution?.name ?? "";
  const place = f.institution ? "" : (stateLabel ?? "");
  const related = f.related[0] ?? "";
  const stage = f.stages.length === 1 ? STAGE_WORDS[f.stages[0]] : "";
  const sites = (f.institution?.domains ?? []).map((d) => `site:${d}`).join(" OR ");

  const raw: Array<[string, string]> = [
    ["topic+institution", `${f.topic} ${inst} ${place}`],
    ["topic+faculty", `${f.topic} faculty researcher ${inst} ${stage}`],
    ["topic+related", related ? `${f.topic} ${related} ${inst}` : ""],
    ["directory", inst ? `${inst} department research areas ${f.topic} people` : `${f.topic} research group people directory`],
    ["site", sites ? `${f.topic} (people OR faculty OR lab OR students) ${sites}` : ""],
    ["personal/lab", `${f.topic} ${inst} lab personal homepage research interests`],
    ["center", `${f.topic} research center team members ${inst} ${place}`],
  ];

  const seen = new Set<string>();
  const out: WebQuery[] = [];
  for (const [branch, text] of raw) {
    const t = clean(text);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push({ id: `w${out.length + 1}`, text: t, branch });
  }
  // The first three go to the people index too; all go to general web and Brave.
  return { people: out.slice(0, 3), web: out.slice(0, 6) };
}

/**
 * Searches restricted to institutional domains, so department, faculty, lab and
 * research-area pages are investigated as their own path. Works for any
 * institution: the domains come from the organization record.
 */
export function institutionalQueries(
  f: Facets,
  domains: string[],
  opts: { perDomain?: number; max?: number } = {},
): WebQuery[] {
  const perDomain = opts.perDomain ?? 2;
  const max = opts.max ?? 6;
  const out: WebQuery[] = [];
  const related = f.related[0] ?? "";
  for (const d of domains) {
    const site = `site:${d}`;
    const texts = [
      `${site} ${f.topic} ${related} faculty people researchers`,
      `${site} department ${f.topic} research group lab`,
    ].slice(0, perDomain);
    for (const t of texts) out.push({ id: `i${out.length + 1}`, text: clean(t), branch: "institutional" });
  }
  return out.slice(0, max);
}
