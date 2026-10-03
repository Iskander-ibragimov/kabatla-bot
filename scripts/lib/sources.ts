/** Pure parsers for dictionary sources (corpus.tatar frequency lists, Tatoeba exports). No node: imports. */

export interface LemmaRow { count: number; lemma: string; pos: string }
export interface SentencePair { tatId: number; tat: string; rusId: number; rus: string }

/**
 * One line of a corpus lemma list: `<count> <lemma>\t<tag>` (count may be space-padded, tag optional).
 * `pos` is supplied by the caller (the list file's suffix); the in-line tag is ignored.
 */
export function parseLemmaLine(line: string, pos: string): LemmaRow | null {
  const m = /^\s*(\d+)\s+(\S+)(?:\s.*)?$/u.exec(line.replace(/\r$/, ""));
  if (!m) return null;
  return { count: Number(m[1]), lemma: m[2]!, pos };
}

/** One line of the word-form list: `<form>\t\t<count>`. Returns the form if its count is at least `minCount`. */
export function parseWordformLine(line: string, minCount: number): string | null {
  const m = /^\s*(\S+)\s+(\d+)\s*$/u.exec(line.replace(/\r$/, ""));
  if (!m || Number(m[2]) < minCount) return null;
  return m[1]!;
}

/** Tatoeba `*_sentences.tsv`: `id\tlang\ttext`. */
export function parseSentences(tsv: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of tsv.split("\n")) {
    const [id, , ...rest] = line.replace(/\r$/, "").split("\t");
    const text = rest.join("\t").trim();
    if (id && /^\d+$/.test(id) && text) out.set(Number(id), text);
  }
  return out;
}

/** Tatoeba `*_links.tsv`: `id1\tid2`. */
export function parseLinks(tsv: string): [number, number][] {
  const out: [number, number][] = [];
  for (const line of tsv.split("\n")) {
    const [a, b] = line.replace(/\r$/, "").split("\t");
    if (a && b && /^\d+$/.test(a) && /^\d+$/.test(b)) out.push([Number(a), Number(b)]);
  }
  return out;
}

/** Joins links (tatId, rusId) with the sentence maps; links with a missing side are dropped. */
export function pairSentences(tat: Map<number, string>, rus: Map<number, string>, links: [number, number][]): SentencePair[] {
  const out: SentencePair[] = [];
  for (const [tatId, rusId] of links) {
    const t = tat.get(tatId);
    const r = rus.get(rusId);
    if (t !== undefined && r !== undefined) out.push({ tatId, tat: t, rusId, rus: r });
  }
  return out;
}
