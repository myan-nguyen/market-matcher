import { stateName } from "@/lib/states";
import {
  STAGE_CODES,
  type Candidate,
  type ClaimStatus,
  type Evidence,
  type EvidenceType,
  type OpportunityCheck,
  type OpportunityStatus,
  type SearchRequest,
  type StageCode,
} from "@/types/search";

const FIRST = [
  "Maya", "Jonas", "Priya", "Elena", "Marcus", "Aiko", "Tomas", "Nadia",
  "Daniel", "Sofia", "Kwame", "Lena", "Omar", "Chloe", "Ravi", "Ingrid",
  "Mateo", "Hana", "Isaac", "Zara",
];
const LAST = [
  "Alvarez", "Brennan", "Chen", "Dubois", "Eriksen", "Fofana", "Gupta",
  "Haddad", "Ito", "Jensen", "Kowalski", "Lindqvist", "Mbeki", "Novak",
  "Okafor", "Petrov", "Quinn", "Rossi", "Suzuki", "Torres",
];
const TYPES: EvidenceType[] = ["profile", "publication", "project"];
const OPPS: OpportunityStatus[] = ["checked", "unresolved", "not checked"];
const STATUSES: ClaimStatus[] = ["verified", "inferred", "unknown"];
const OTHER_STATES = ["RI", "MA", "CT", "NY", "CA", "TX", "PA", "WA"];

const NOW = new Date().toISOString();

/** Mock people only. Placeholder data until the real engine exists. */
export function generateMockCandidates(req: SearchRequest, count: number): Candidate[] {
  const methods = req.method
    ? [req.method, "Mixed methods", "Computational analysis"]
    : ["Field study", "Cohort analysis", "Computational modeling", "Qualitative interviews"];

  return Array.from({ length: count }, (_, i) => {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7 + 3) % LAST.length]}`;
    const slug = name.toLowerCase().replace(/\s+/g, "-");

    // Cycle through statuses so every state of the contract appears.
    const stageStatus = STATUSES[i % 3];
    const locStatus = STATUSES[(i + (i % 4 === 0 ? 1 : 0)) % 3];

    // If the user chose constraints, some verified people match, some contradict.
    const wantedStage = req.stages[i % Math.max(1, req.stages.length)];
    const stageValue: StageCode | null =
      stageStatus === "unknown"
        ? null
        : i % 5 === 4
          ? STAGE_CODES[(i + 1) % STAGE_CODES.length]
          : (wantedStage ?? STAGE_CODES[i % STAGE_CODES.length]);

    const locValue: string | null =
      locStatus === "unknown"
        ? null
        : req.state && i % 5 !== 4
          ? req.state
          : OTHER_STATES[i % OTHER_STATES.length];

    const orgName = locValue
      ? `${stateName(locValue) ?? locValue} University`
      : "Unknown institution";

    const evidence: Evidence[] = Array.from({ length: 2 + (i % 2) }, (_, j) => {
      const type = TYPES[(i + j) % TYPES.length];
      const year = 2025 - ((i + j * 2) % 8);
      return {
        type,
        label: `${type[0].toUpperCase()}${type.slice(1)}: ${req.query}`,
        url: `https://example.org/${slug}/${type}`,
        date: `${year}-0${1 + ((i + j) % 9)}-15`,
      };
    });

    const oppStatus = OPPS[i % OPPS.length];
    const opportunityChecks: OpportunityCheck[] = [
      {
        label: "Open to outreach",
        status: oppStatus,
        note: oppStatus === "unresolved" ? "Profile page did not say." : null,
      },
    ];

    const unresolvedQuestions: string[] = [];
    if (stageStatus !== "verified") unresolvedQuestions.push("Confirm current career stage.");
    if (locStatus !== "verified") unresolvedQuestions.push("Confirm current affiliation and state.");

    return {
      id: `cand-${slug}-${i + 1}`,
      orcid: null,
      openalexId: null,
      name,
      organizations: [
        {
          name: orgName,
          lab: locValue ? `${LAST[(i * 3 + 5) % LAST.length]} Lab` : null,
          status: locStatus,
          source: locStatus === "unknown" ? null : `https://example.org/${slug}/profile`,
          retrievedAt: locStatus === "unknown" ? null : NOW,
        },
      ],
      stage: {
        value: stageValue,
        status: stageStatus,
        source: stageStatus === "unknown" ? null : `https://example.org/${slug}/profile`,
        retrievedAt: stageStatus === "unknown" ? null : NOW,
        note: null,
      },
      location: {
        value: locValue,
        status: locStatus,
        source: locStatus === "unknown" ? null : `https://example.org/${slug}/profile`,
        retrievedAt: locStatus === "unknown" ? null : NOW,
        note: null,
      },
      focus: { value: null, status: "unknown", source: null, retrievedAt: null, note: null },
      fit: `Work related to "${req.query}" that may overlap with: ${req.cohort}. Placeholder text until the real engine is connected.`,
      methods: methods.slice(0, 2 + (i % 2)),
      evidence,
      opportunityChecks,
      unresolvedQuestions,
      matchedQueries: [], // filled in by the search pipeline
      profiles: [],
      foundBy: ["mock"],
      score: 100 - i * 1.3 + ((i * 13) % 7),
    };
  });
}
