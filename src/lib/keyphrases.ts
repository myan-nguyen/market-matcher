import nlp from "compromise";

/** Words that describe the searcher's intent, not the research itself. */
const FILLER = /^(?:research\w*|scientists?|stud(?:y|ies|ying|ied)|people|faculty|labs?|professors?|students?|postdocs?|investigators?|experts?|working|work|focused|focusing)$/i;

/**
 * The noun phrases that carry a query's meaning, found by part-of-speech tagging.
 * "biochemistry researchers studying how cancer cells communicate with each other
 * through extracellular vesicles" -> ["biochemistry", "cancer cells", "extracellular vesicles"].
 * Glue words ("how", "with each other", "through") and intent words drop out.
 */
export function keyPhrases(text: string): string[] {
  if (!text.trim()) return [];
  const doc = nlp(text);
  const out: string[] = [];
  for (const chunk of doc.nouns().json() as { terms: { text: string; tags: string[] }[] }[]) {
    // Split a chunk at filler words: "biochemistry researchers studying" -> "biochemistry".
    let cur: string[] = [];
    const flush = () => {
      if (cur.length) out.push(cur.join(" ").toLowerCase());
      cur = [];
    };
    for (const t of chunk.terms) {
      const w = t.text.replace(/[^\p{L}\p{N}-]/gu, "");
      const content = t.tags.some((g) => g === "Noun" || g === "Adjective") && !t.tags.includes("Pronoun");
      if (!w || FILLER.test(w) || !content) flush();
      else cur.push(w);
    }
    flush();
  }
  // The tagger is a guess ("networks" after "and" is read as a verb). A content word
  // it left out of every phrase is still kept on its own, so the tagger can only
  // group words, never delete the subject.
  const covered = new Set(out.flatMap((p) => p.split(" ")));
  // A leftover word stands alone only if it names something (noun or verb); a lone
  // adjective ("other") is glue.
  for (const w of contentWords(text, true)) if (!covered.has(w)) out.push(w);
  return [...new Set(out.filter((p) => p.length >= 3))];
}

/** Glue words by part of speech (how, each, other, through, with), never by a word list. */
const FUNCTION_TAGS = /^(?:Preposition|Determiner|Conjunction|Pronoun|QuestionWord|Adverb|Copula|Modal|Auxiliary)$/;

function contentWords(text: string, standalone = false): string[] {
  const out: string[] = [];
  for (const t of nlp(text).terms().json() as { terms: { text: string; tags: string[] }[] }[]) {
    const term = t.terms[0];
    const w = term.text.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, "");
    if (w.length < 4 || FILLER.test(w)) continue;
    if (term.tags.some((g) => FUNCTION_TAGS.test(g))) continue;
    if (standalone && !term.tags.some((g) => g === "Noun" || g === "Verb")) continue;
    if (!standalone && !term.tags.some((g) => g === "Noun" || g === "Verb" || g === "Adjective")) continue;
    out.push(w);
  }
  return out;
}

/** Content words of the query: everything except glue and intent words. */
export function keyTerms(text: string): string[] {
  const inPhrases = keyPhrases(text).flatMap((p) => p.split(" "));
  return [...new Set(inPhrases.filter((w) => w.length >= 4))];
}

/** A compact search string: rarest-looking (multi-word) phrases quoted first, then the rest. */
export function conciseQuery(text: string): string {
  const ps = keyPhrases(text);
  if (ps.length === 0) return text;
  return [...ps]
    .sort((a, b) => b.split(" ").length - a.split(" ").length)
    .map((p) => (p.includes(" ") ? `"${p}"` : p))
    .join(" ");
}
