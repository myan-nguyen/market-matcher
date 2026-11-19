const STOP = new Set([
  "university", "college", "institute", "school", "medical", "center", "centre",
  "hospital", "department", "laboratory", "health", "sciences", "science",
  "research", "of", "the", "and", "for", "at", "in", "dept", "lab", "program",
]);

export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same last name, and first names equal or compatible as an initial. */
export function sameName(a: string, b: string): boolean {
  const x = normalizeName(a).split(" ");
  const y = normalizeName(b).split(" ");
  if (x.length < 2 || y.length < 2) return false;
  const [fx, lx] = [x[0], x[x.length - 1]];
  const [fy, ly] = [y[0], y[y.length - 1]];
  if (lx !== ly) return false;
  return fx === fy || (fx[0] === fy[0] && (fx.length === 1 || fy.length === 1));
}

function distinctive(name: string): string[] {
  return normalizeName(name)
    .split(/[\s-]+/)
    .filter((t) => t.length >= 4 && !STOP.has(t));
}

/** True when two lists of organization names share a distinctive word. */
export function orgOverlap(a: string[], b: string[]): boolean {
  const left = new Set(a.flatMap(distinctive));
  return b.flatMap(distinctive).some((t) => left.has(t));
}

/** True when a host such as cs.brown.edu plausibly belongs to one of the organizations. */
export function hostMatchesOrg(host: string, orgs: string[]): boolean {
  const h = host.toLowerCase();
  return orgs.flatMap(distinctive).some((t) => h.includes(t));
}
