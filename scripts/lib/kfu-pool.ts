/**
 * The entries of the KFU word lists (scripts/lib/kfu.ts reads them): sorting them into words, phrases, names and free
 * combinations, finding the dictionary form the corpus and the catalog know a word by, and joining the five levels
 * into one pool. Pure: no I/O; scripts/kfu-lists.ts reads and writes the files.
 */
import { wordKey } from "../../src/db/repo";
import { type KfuTopic, kfuTopicSlug } from "./kfu";
import { verbInfinitive } from "./tatar-verbs";

/**
 * Letters of other alphabets that the lists print for Tatar ones, in both cases: U+04CA for ң (U+04A3), U+0473 for ө
 * (U+04E9). Spelled as escapes, so that no look-alike hides in the source.
 */
const LOOKALIKES: Readonly<Record<string, string>> = { "\u04CA": "\u04A3", "\u04C9": "\u04A2", "\u0473": "\u04E9", "\u0472": "\u04E8" };
const fixLookalikes = (text: string): string => text.replace(/[\u04C9\u04CA\u0472\u0473]/g, (c) => LOOKALIKES[c]!);

/**
 * What tells two entries of the lists apart: the letters, without case, the hyphen (сана-рга and санарга are one
 * entry), signs and repeated spaces. The pool holds an entry with a key once.
 */
export const entryKey = (entry: string): string =>
  fixLookalikes(entry).toLowerCase().replace(/-/g, "").replace(/[.,;:!?«»"“”„\u2013\u2014]+/g, "").replace(/\s+/g, " ").trim();

/** A1 prints a verb as its stem and the ending apart: сана-рга, тор-ырга, дус бул-ырга. */
const STEM_AND_ENDING = /^(.+)-[ыеаәя]?рг[аә]$/;

/**
 * The names of action in -у/-ү a form in -рга/-ргә may belong to: the lists give a verb in that
 * form, the catalog in the other. эшләргә is эшлә-ргә or эшл-әргә, so two stems are given, the one in a vowel first;
 * барырга, укырга give one form whichever way they are cut; җыярга, кияргә go back to җый, ки. A stem printed apart
 * (яз-арга) is taken as given. None for a word that is no such form.
 */
export function infinitiveForms(token: string): string[] {
  const apart = STEM_AND_ENDING.exec(token);
  if (apart) return [verbInfinitive(apart[1]!)];
  if (!/^[а-яёәөүҗңһ]{2,}рг[аә]$/.test(token)) return [];
  const base = token.slice(0, -3);
  const cut = base.slice(0, -1);
  switch (base.at(-1)) {
    case "а": case "ә": return [...new Set([verbInfinitive(base), verbInfinitive(cut)])];
    case "ы": case "е": return [verbInfinitive(base)];
    case "я": return [verbInfinitive(cut.endsWith("и") ? cut : `${cut}й`)];
    default: return [];
  }
}

/** What the corpus says about words, as far as the lists need it. */
export interface Corpus {
  /** The words of the frequency list, in dictionary form (`rankWords`). */
  known: ReadonlySet<string>;
  /** Finite verb form → the name of action of its verb (`finiteVerbForms`): ошый → ошау. */
  finite: ReadonlyMap<string, string>;
}
const NO_CORPUS: Corpus = { known: new Set(), finite: new Map() };

/** How the dictionary form of a token was found: it, or its name of action, is a word of the corpus; it is a finite form of a corpus verb; or nothing was found. */
type Found = "lemma" | "form" | "none";

/**
 * The form a token of the lists is looked up under, and how it was found:
 *  - a stem printed apart gives its name of action;
 *  - a word the corpus knows stands as it is (карга is a noun);
 *  - a form in -рга/-ргә gives the name of action the corpus knows — the stem in a vowel when it knows both
 *    (ашарга is ашау before ашу);
 *  - a finite form of a corpus verb gives that verb: the lists print some verbs so (ошый, күрсәтә, ярамый);
 *  - otherwise nothing is found, and the stem of a form in -рга/-ргә is guessed: in a vowel after л or р, where
 *    -ла/-лә and -ра/-рә make verbs (зурла-рга, калтыра-рга), in a consonant otherwise (сүн-әргә).
 */
function dictionaryFormOf(token: string, corpus: Corpus): { form: string; found: Found } {
  const found = (form: string): Found => (corpus.known.has(form) ? "lemma" : "none");
  if (STEM_AND_ENDING.test(token)) { const form = infinitiveForms(token)[0]!; return { form, found: found(form) }; }
  if (corpus.known.has(token)) return { form: token, found: "lemma" };
  const forms = infinitiveForms(token);
  const known = forms.find((form) => corpus.known.has(form));
  if (known !== undefined) return { form: known, found: "lemma" };
  const verb = corpus.finite.get(token);
  if (verb !== undefined) return { form: verb, found: "form" };
  const guess = forms.length === 2 && !/[лр][аә]рг[аә]$/.test(token) ? forms[1] : forms[0];
  return { form: guess ?? token, found: "none" };
}

/** The endings of the third-person possessive, the short ones first: урын-ы, кием-е, бүлмә-се, ризык-лары. */
const POSSESSIVE = ["ы", "е", "сы", "се", "лары", "ләре"] as const;

/**
 * What a token may be the possessive form of: the token without the ending, and with к, п for the г, б a stem has
 * before a vowel (ризыгы → ризык). The head of a combination stands in this form: аяк киеме, эш урыны.
 */
function withoutPossessive(token: string): string[] {
  return POSSESSIVE.filter((ending) => token.endsWith(ending) && token.length > ending.length + 1).flatMap((ending) => {
    const stem = token.slice(0, -ending.length);
    const voiced = /[гб]$/.exec(stem)?.[0];
    return voiced ? [stem, stem.slice(0, -1) + (voiced === "г" ? "к" : "п")] : [stem];
  });
}

/** The word of the corpus a token of a combination stands for, or null: its dictionary form, or what it is the possessive form of. */
function corpusWord(token: string, corpus: Corpus): string | null {
  const { form, found } = dictionaryFormOf(token, corpus);
  return found !== "none" ? form : withoutPossessive(token).find((stem) => corpus.known.has(stem)) ?? null;
}

export type EntryKind = "word" | "phrase" | "name" | "combination";
/**
 * An entry sorted. `lemma` is what the entry is looked up by in the corpus and in the catalog: a word or a combination
 * in lower case with its verb as a name of action, a phrase or a name as printed without its variant. `found` says,
 * for a `word`, how the corpus knows it: `lemma` — the lemma is a word of the frequency list; `form` — the entry is a
 * finite form of the verb in `lemma`; `none` — the corpus has no such word, and the lemma may be an inflected form
 * or a guess. Empty for the other kinds. `words` are the words of a combination that the corpus knows, each once —
 * the candidates for a card (spec §3.6: «белем алырга» → «белем»).
 */
export interface EntryInfo { kind: EntryKind; lemma: string; found: Found | ""; words: string[] }

/**
 * Fixed expressions the lists print without ! or ?: рәхим итегез, гафу итегез, сау бул…, таныш бул…, мин риза,
 * ал да гөл, and a question in -мыни/-мени (чынмыни). Matched against the main form in lower case.
 */
const PHRASE_PATTERNS: readonly RegExp[] = [/^(рәхим|гафу) ит(егез)?$/, /^сау бул/, /^таныш бул/, /^мин риза$/, /^ал да гөл$/, /(мыни|мени)$/];
/** A line of speech begins with a dash (U+2013, U+2014 or a hyphen); C1 prints some after a stray full stop. */
const SPEECH = /^[.\s]*[\u2013\u2014-]\s+/;
const OPENING_QUOTE = /^[«“„"]/;
const isUpper = (c: string | undefined): boolean => c !== undefined && c !== c.toLowerCase();

/** The entry without its variants: a bracket glued to a word marks optional letters (укучы(лар)), one that stands apart another wording. */
function withoutBrackets(text: string): string {
  const out = text.replace(/\s+\([^)]*\)/g, "").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  // The whole entry stands in brackets, as an abbreviation is.
  return out === "" ? text.replace(/[()]/g, "").trim() : out;
}

/**
 * Sorts an entry of the lists. The rules, in this order:
 *  1. `phrase` — a fixed expression that would be a card: the entry has ! or ?, is a line of speech (begins with a
 *     dash), or is one of `PHRASE_PATTERNS`. It is kept as printed, without the dash and the variant in brackets.
 *  2. `name` — the entry begins with a capital letter or an opening quotation mark: a town, a person, a title, an
 *     organisation. (A phrase begins with a capital too; that is why it is asked first.)
 *  3. `word` — one token is left once the variants are cut: what stands in brackets and after a slash or a comma
 *     (әни (әнкәй), гына/генә; of a pair such as бара\бармый the first), and the final sign.
 *  4. `combination` — the rest: several tokens, a free combination. Its words that the corpus knows go to `words`,
 *     the head also when it stands in the possessive form (аяк киеме → аяк, кием).
 * Without the corpus the stem of a verb is guessed and a combination has no words. The sorting is by rule and so
 * imperfect: a common word printed with a capital is a `name`.
 */
export function classifyEntry(entry: string, corpus: Corpus = NO_CORPUS): EntryInfo {
  const text = fixLookalikes(entry).replace(/\s+/g, " ").trim();
  const speech = SPEECH.test(text);
  const said = withoutBrackets(text.replace(SPEECH, "").replace(/^[.\s]+/, ""));
  const main = said.split(/[/\\,]/)[0]!.replace(/[.,;:]+$/, "").trim();
  if (speech || /[!?]/.test(text) || PHRASE_PATTERNS.some((pattern) => pattern.test(main.toLowerCase()))) return { kind: "phrase", lemma: said, found: "", words: [] };
  if (OPENING_QUOTE.test(said) || isUpper(said.replace(/^[^\p{L}]+/u, "")[0])) return { kind: "name", lemma: said, found: "", words: [] };
  const tokens = main.toLowerCase().split(" ");
  const last = dictionaryFormOf(tokens.at(-1)!, corpus);
  const lemma = [...tokens.slice(0, -1), last.form].join(" ");
  if (tokens.length === 1) return { kind: "word", lemma, found: last.found, words: [] };
  const words = tokens.map((token) => corpusWord(token, corpus)).filter((word): word is string => word !== null);
  return { kind: "combination", lemma, found: "", words: [...new Set(words)] };
}

/** One line of the pool: an entry of the lists with the lowest level and the first topic it stands in. */
export interface PoolEntry extends EntryInfo {
  entry: string;
  /** Slug of the level: a1 … c1. */
  level: string;
  /** The heading the entry stands under, as printed. */
  kfuTopic: string;
  /** Slug of the catalog topic the heading is mapped to. */
  topic: string;
  /** Place of a `word` in the frequency list of the corpus, from 1; null for a word the corpus does not have and for the other kinds. */
  rank: number | null;
  /** Slug of the level file that already holds the entry, or empty. */
  inCatalog: string;
}

/**
 * Joins the lists of the levels, lowest first, into the pool: every entry once (`entryKey`), with the level and the
 * topic of its first place. `ranks` gives the place of a word of the corpus in the frequency list, `finite` the verb
 * of a finite form, `catalog` the level file a word key stands in. Throws on a topic that `KFU_TOPICS` does not map.
 */
export function buildPool(
  levels: readonly { level: string; topics: readonly KfuTopic[] }[],
  o: { ranks: ReadonlyMap<string, number>; catalog: ReadonlyMap<string, string>; finite?: ReadonlyMap<string, string> },
): PoolEntry[] {
  const corpus: Corpus = { known: new Set(o.ranks.keys()), finite: o.finite ?? new Map() };
  const seen = new Set<string>();
  const pool: PoolEntry[] = [];
  for (const { level, topics } of levels) {
    for (const { name, heading, entries } of topics) {
      const topic = kfuTopicSlug(level, name);
      for (const entry of entries) {
        const key = entryKey(entry);
        if (key === "" || seen.has(key)) continue;
        seen.add(key);
        const info = classifyEntry(entry, corpus);
        pool.push({
          entry, level, kfuTopic: heading, topic, ...info,
          rank: info.kind === "word" ? o.ranks.get(info.lemma) ?? null : null, inCatalog: o.catalog.get(wordKey(info.lemma)) ?? "",
        });
      }
    }
  }
  return pool;
}

export const POOL_HEADER = ["entry", "level", "kfu_topic", "topic", "kind", "lemma", "found", "rank", "in_catalog", "words"] as const;

/** The pool as a table: tab-separated, a header, one line per entry. */
export function formatPool(pool: readonly PoolEntry[]): string {
  const lines = pool.map((p) => [p.entry, p.level, p.kfuTopic, p.topic, p.kind, p.lemma, p.found, p.rank ?? "", p.inCatalog, p.words.join(", ")].join("\t"));
  return [POOL_HEADER.join("\t"), ...lines].join("\n") + "\n";
}
