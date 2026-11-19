import type { Candidate, Facets, SearchRequest } from "@/types/search";

export const NOW = "2026-11-18T00:00:00.000Z";

export const REQ: SearchRequest = {
  query: "computer systems and networking at Brown, accessible network environments",
  cohort: "computer systems and networking",
  include: ["accessible network environments"],
  prefer: [],
  exclude: [],
  method: null,
  state: "RI",
  stages: [],
  trace: ["Akshay Narayan", "akshayn.xyz", "/people/faculty/akshayn/"],
};

export const FACETS: Facets = {
  topic: "computer systems and networking",
  cohort: "",
  related: ["accessible network environments"],
  institution: { name: "Brown University", domains: ["brown.edu"] },
  state: "RI",
  stages: [],
};

const unknown = { value: null, status: "unknown" as const, source: null, retrievedAt: null, note: null };

function base(over: Partial<Candidate> & Pick<Candidate, "id" | "name">): Candidate {
  return {
    orcid: null,
    openalexId: null,
    organizations: [],
    stage: unknown,
    location: unknown,
    focus: unknown,
    fit: "",
    methods: [],
    evidence: [],
    opportunityChecks: [],
    unresolvedQuestions: [],
    matchedQueries: [],
    profiles: [],
    foundBy: [],
    score: 0,
    ...over,
  };
}

const page = (url: string, name: string, headline: string, institutional: boolean) => ({
  url,
  retrievedAt: NOW,
  institutional,
  name,
  headline,
});

/** Akshay: a Brown faculty profile and a personal site, both read. Networking is the listed area. */
export const AKSHAY = base({
  id: "web-akshay-narayan",
  name: "Akshay Narayan",
  organizations: [{ name: "Brown University", lab: null, status: "verified", source: "https://cs.brown.edu/people/faculty/akshayn/", retrievedAt: NOW }],
  focus: {
    value: "Networking, Computer Systems. I build network systems that make network environments easier to use and reason about.",
    status: "verified",
    source: "https://cs.brown.edu/people/faculty/akshayn/",
    retrievedAt: NOW,
    note: null,
  },
  profiles: [
    page("https://cs.brown.edu/people/faculty/akshayn/", "Akshay Narayan", "Assistant Professor of Computer Science, Networking, Computer Systems", true),
    page("https://akshayn.xyz", "Akshay Narayan", "I work on networking and computer systems", false),
  ],
  evidence: [
    { type: "profile", label: "Networking, Computer Systems faculty profile", url: "https://cs.brown.edu/people/faculty/akshayn/", date: "2026-11-18" },
    { type: "profile", label: "Personal site: networking and systems research", url: "https://akshayn.xyz", date: "2026-11-18" },
  ],
  excerpts: [
    { url: "https://cs.brown.edu/people/faculty/akshayn/", text: "Networking, Computer Systems. I build network systems for accessible network environments." },
    { url: "https://akshayn.xyz", text: "I work on networking and computer systems, building networks that are easy to use." },
  ],
  foundBy: ["institutional", "directory"],
});

/** Karniadakis: strong publication volume, Brown profile, no networking evidence. */
export const KARNIADAKIS = base({
  id: "oa-a-karniadakis",
  name: "George Em Karniadakis",
  openalexId: "A1",
  organizations: [{ name: "Brown University", lab: null, status: "verified", source: "https://vivo.brown.edu/karniadakis", retrievedAt: NOW }],
  focus: {
    value: "Applied mathematics. Physics-informed neural networks and computational science.",
    status: "verified",
    source: "https://vivo.brown.edu/karniadakis",
    retrievedAt: NOW,
    note: null,
  },
  profiles: [page("https://vivo.brown.edu/karniadakis", "George Em Karniadakis", "Professor of Applied Mathematics", true)],
  evidence: [
    { type: "publication", label: "Physics-informed neural networks for scientific computing", url: "https://doi.org/10.1/a", date: "2026-03-01" },
    { type: "publication", label: "Neural operator learning of partial differential equations", url: "https://doi.org/10.1/b", date: "2026-01-01" },
    { type: "publication", label: "Computational methods for fluid dynamics", url: "https://doi.org/10.1/c", date: "2025-06-01" },
  ],
  excerpts: [{ url: "https://vivo.brown.edu/karniadakis", text: "Applied mathematics. Physics-informed neural networks and computational science." }],
  foundBy: ["openalex"],
});

/** Suresh: Brown profile listing algorithmic fairness, and a broad "accessible" overlap only. */
export const SURESH = base({
  id: "web-suresh",
  name: "Suresh Venkatasubramanian",
  organizations: [{ name: "Brown University", lab: null, status: "verified", source: "https://cs.brown.edu/people/faculty/suresh/", retrievedAt: NOW }],
  focus: {
    value: "Algorithmic fairness, accessible and accountable computer systems for society.",
    status: "verified",
    source: "https://cs.brown.edu/people/faculty/suresh/",
    retrievedAt: NOW,
    note: null,
  },
  profiles: [page("https://cs.brown.edu/people/faculty/suresh/", "Suresh Venkatasubramanian", "Professor, Algorithmic Fairness", true)],
  evidence: [{ type: "profile", label: "Algorithmic Fairness faculty profile", url: "https://cs.brown.edu/people/faculty/suresh/", date: "2026-11-18" }],
  excerpts: [{ url: "https://cs.brown.edu/people/faculty/suresh/", text: "Algorithmic fairness, accessible and accountable computer systems for society." }],
  foundBy: ["institutional"],
});

/** A program page that must never be a result. */
export const PROGRAM = base({
  id: "web-brazil-initiative",
  name: "Brazil Initiative",
  evidence: [{ type: "profile", label: "Brazil Initiative networking events", url: "https://brown.edu/brazil", date: "2026-11-18" }],
  profiles: [page("https://brown.edu/brazil", "Brazil Initiative", "Networking events", true)],
  foundBy: ["exa-web"],
});

/** A directory-only lead: no readable page, the listed research area is all there is. */
export const PROVISIONAL = base({
  id: "web-dana-lee",
  name: "Dana Lee",
  organizations: [{ name: "Brown University", lab: null, status: "inferred", source: "https://cs.brown.edu/people/faculty/dlee/", retrievedAt: NOW }],
  profiles: [{ ...page("https://cs.brown.edu/people/faculty/dlee/", "Dana Lee", "Networking, Computer Systems", true), provisional: true }],
  evidence: [{ type: "profile", label: "Networking, Computer Systems", url: "https://cs.brown.edu/people/faculty/dlee/", date: "2026-11-18" }],
  excerpts: [{ url: "https://cs.brown.edu/people/faculty/dlee/", text: "Networking, Computer Systems", provisional: true }],
  foundBy: ["directory"],
});

export const ALL = [AKSHAY, KARNIADAKIS, SURESH, PROGRAM, PROVISIONAL];

/** A comparable query at an independent research center, same pipeline. */
export const CENTER_REQ: SearchRequest = {
  query: "marine microbial genomics at Woods Hole Oceanographic Institution",
  cohort: "marine microbial genomics",
  include: [],
  prefer: [],
  exclude: [],
  method: null,
  state: null,
  stages: [],
};
export const CENTER_FACETS: Facets = {
  topic: "marine microbial genomics",
  cohort: "",
  related: [],
  institution: { name: "Woods Hole Oceanographic Institution", domains: ["whoi.edu"] },
  state: null,
  stages: [],
};
export const CENTER_PERSON = base({
  id: "web-sam-ortiz",
  name: "Sam Ortiz",
  organizations: [{ name: "Woods Hole Oceanographic Institution", lab: null, status: "verified", source: "https://whoi.edu/people/sortiz", retrievedAt: NOW }],
  focus: { value: "Marine microbial genomics of coastal ecosystems.", status: "verified", source: "https://whoi.edu/people/sortiz", retrievedAt: NOW, note: null },
  profiles: [page("https://whoi.edu/people/sortiz", "Sam Ortiz", "Scientist, marine microbial genomics", true)],
  evidence: [{ type: "profile", label: "Marine microbial genomics", url: "https://whoi.edu/people/sortiz", date: "2026-11-18" }],
  excerpts: [{ url: "https://whoi.edu/people/sortiz", text: "Marine microbial genomics of coastal ecosystems." }],
  foundBy: ["institutional"],
});
