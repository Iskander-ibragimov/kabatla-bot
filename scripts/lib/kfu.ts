/**
 * The word lists of the KFU specifications A1–C1 («Лексический минимум», spec §3.6): reading them from the text of a
 * specification, sorting their entries into words, phrases, names and free combinations, and joining the five levels
 * into one pool. Pure: no I/O; scripts/kfu-lists.ts reads and writes the files.
 *
 * The text is the one that keeps the layout of the pages (`s_<LEVEL>.layout.txt`): there a line of the word table is
 * a line of text and its columns stand apart by two spaces or more, so a heading and the words under it stay together.
 * The plain extraction of the same file tears the columns of a page apart and puts the right one under another heading.
 */
import { wordKey } from "../../src/db/repo";
import { verbInfinitive } from "./tatar-verbs";

/**
 * The topics of the specifications → the topics of the catalog (spec §3.2), by level. A topic is named as the list
 * «Основные темы» of its specification prints it (B1 prints «Яшьләр мохиты»). A topic that is not here stops the
 * pool: `kfuTopicSlug`.
 */
export const KFU_TOPICS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  a1: {
    "Танышу": "greet", "Яшәү һәм уку урыны": "home", "Гаилә һәм дуслар белән таныштыру": "family", "Вакыт": "time", "Көндәлек эшләр": "home",
    "Буш вакытым": "leisure", "Һава торышы": "nature", "Ел фасыллары": "nature", "Шәһәр": "city", "Кибеттә": "shop", "Милли ризыклар": "food",
  },
  a2: {
    "Якын кешеләремнең холкы һәм тышкы кыяфәте": "person", "Көндәлек режим": "home", "Һөнәрләр дөньясында": "work", "Эш һәм ял": "work",
    "Кызыксынулар һәм мавыгулар": "leisure", "Йорт. Фатир": "home", "Табибта": "health", "Табигать һәм тирәлек": "nature", "Театрлар һәм музейлар": "culture",
    "Татарстан шәһәрләре": "tatar", "Татарстан халыклары": "tatar",
  },
  b1: {
    "Шәхси бренд": "person", "Үзеңне ярат": "person", "Ихлас дуслык": "family", "Заманча һөнәрләр": "work", "Ял һәм күңел ачу": "leisure",
    "Мода һәм матурлык": "shop", "Студентлар тормышы": "study", "Яшьләр мохиты": "society", "Ясалма интеллект": "media", "Татарлар һәм татар теле": "language",
    "Матбугат һәм массмедиа": "media",
  },
  b2: {
    "Тәрҗемәи хәлем": "person", "Кызыклы хатирәләр": "person", "Хыяллар һәм теләкләр": "person", "Югары белем алу": "study", "Китап дөньясында": "culture",
    "Сәяхәт итү һәм ял": "travel", "Үзгәрә торган дөнья": "society", "Тылсымлы төсләр": "culture", "Тел дигән дәрья бар": "language", "Тарихка сәяхәт": "society",
    "Күренекле шәхесләр": "society",
  },
  c1: {
    "Минем шәҗәрәм": "family", "Гаилә гореф-гадәтләре": "tatar", "Рәсми аралашу": "language", "Сынлы сәнгать": "culture", "Музыка сәнгате": "culture",
    "Спорт һәм сәламәтлек": "health", "Мәгариф һәм фән": "study", "Укытучы һөнәре": "work", "Табигатьне саклау": "nature", "Танылган татар шәхесләре": "tatar",
    "Интернет чыганаклар": "media",
  },
};

/** The slug of the catalog topic a topic of a specification goes to. Throws, naming the topic, when the table has none. */
export function kfuTopicSlug(level: string, name: string): string {
  const slug = KFU_TOPICS[level]?.[name];
  if (slug === undefined) throw new Error(`тема КФУ «${name}» уровня ${level} не сопоставлена теме каталога: добавьте её в KFU_TOPICS (scripts/lib/kfu.ts)`);
  return slug;
}

/** One topic of a word list: its name in the list of topics, the heading printed over its words, and the entries in the order of the file. */
export interface KfuTopic { name: string; heading: string; entries: string[] }
/** The word list of one specification. `missing` are the topics of the list of topics that have no heading over the words. */
export interface KfuLevel { topics: KfuTopic[]; missing: string[] }

const TOPICS_START = "Основные темы";
const SECTION_START = /^\s*7\.\s*ЛЕКСИКА\s*$/;
const SECTION_END = /^\s*\d+\.\s*Содержание отдельных частей/;
/** A page number stands alone on its line. */
const PAGE_NUMBER = /^\d+$/;
const NUMBER = /^(\d+)\.\s*/;

/**
 * The lines of a text and the line the word section begins at. Page breaks are dropped; a glyph of a symbol font
 * (a private-use character: the bullet of a list) becomes a space, so that the columns stay where they are.
 */
function sectionOf(text: string): { lines: string[]; start: number } {
  const lines = text.replace(/\f/g, "").replace(/[\uE000-\uF8FF]/g, " ").split(/\r?\n/);
  const start = lines.findIndex((line) => SECTION_START.test(line));
  if (start < 0) throw new Error("в тексте нет раздела «7. ЛЕКСИКА»");
  return { lines, start };
}

/**
 * The Tatar names of the topics of a specification, from its list «Основные темы», which stands right before the
 * word section. A line is `1. Танышу /Знакомство.`, the name alone, or the number and the name apart; in a numbered
 * list a line without a number continues the one before it.
 */
export function parseKfuTopicNames(text: string): string[] {
  const { lines, start } = sectionOf(text);
  const from = lines.slice(0, start).map((line) => line.trim()).lastIndexOf(TOPICS_START);
  if (from < 0) throw new Error(`перед разделом «7. ЛЕКСИКА» нет списка «${TOPICS_START}»`);
  const items = lines.slice(from + 1, start).map((line) => line.trim()).filter((line) => line !== "" && !PAGE_NUMBER.test(line));
  const numbered = items.some((item) => NUMBER.test(item));
  const topics: string[] = [];
  for (const item of items) {
    if (numbered && !NUMBER.test(item) && topics.length) topics[topics.length - 1] += ` ${item}`;
    else topics.push(item.replace(NUMBER, ""));
  }
  return topics.map((topic) => topic.split("/")[0]!.replace(/\s+/g, " ").trim()).filter((name) => name !== "");
}

/** A cell of a line of the word table: its text without the number, where it begins, and whether a number stands before it. */
interface Cell { text: string; start: number; numbered: boolean }

/** The cells of a line: runs of words two spaces or more apart. A number that stands alone belongs to the cell after it. */
function cellsOf(line: string): Cell[] {
  const cells: Cell[] = [];
  /** The place of a number that waits for its text. */
  let number: number | null = null;
  for (const m of line.matchAll(/\S+(?: \S+)*/g)) {
    const text = m[0].replace(NUMBER, "");
    const numbered = text !== m[0];
    if (text === "") { number = m.index; continue; }
    if (numbered) cells.push({ text, start: m.index, numbered });
    else if (number !== null) cells.push({ text, start: number, numbered: true });
    else cells.push({ text, start: m.index, numbered: false });
    number = null;
  }
  return cells;
}

/** For comparing a heading with the name of a topic: no case, spaces or punctuation. */
const squash = (text: string): string => text.toLowerCase().replace(/[\s.,/:«»"“”]+/g, "");
const isUpper = (c: string | undefined): boolean => c !== undefined && c !== c.toLowerCase();

/** True if the cell is the heading of the topic: its name with a capital, alone («Йорт.Фатир») or with more after a sign («Шәһәр. Транспорт»). */
function isHeading(cell: string, name: string): boolean {
  if (!isUpper(cell[0])) return false;
  return squash(cell) === squash(name) || (cell.startsWith(name) && /^[^\p{L}\p{N}]/u.test(cell.slice(name.length)));
}

/** A continuation cell may begin this many characters to the left of the number of its column. */
const COLUMN_SLACK = 2;

/**
 * The entries of the lines of one topic. Without numbers every cell is an entry. In a numbered list an entry begins
 * at a number, and a cell without one continues the entry of its column — the right column when the cell stands
 * after the second number of its line or at the place of the last right-hand number, the left one otherwise.
 */
function entriesOf(rows: Cell[][]): string[] {
  if (!rows.some((row) => row.some((cell) => cell.numbered))) return rows.flat().map((cell) => cell.text);
  const out: string[] = [];
  let left = -1, right = -1, rightStart = Infinity;
  for (const row of rows) {
    let numbers = 0;
    for (const cell of row) {
      if (cell.numbered) {
        out.push(cell.text);
        if (numbers === 0) left = out.length - 1;
        else { right = out.length - 1; rightStart = cell.start; }
        numbers += 1;
        continue;
      }
      const at = numbers >= 2 || cell.start >= rightStart - COLUMN_SLACK ? right : left;
      if (at < 0) out.push(cell.text);
      else out[at] += ` ${cell.text}`;
    }
  }
  return out;
}

/**
 * Reads the word list of a specification. The section runs from «7. ЛЕКСИКА» to «8. Содержание отдельных частей …».
 * A topic begins at the line whose first cell is the name of a topic of the list «Основные темы» that comes after
 * the topic open now: so a heading printed again under itself, and a word that is also the name of a later topic
 * but has no capital, are entries. The cells that share the line with a heading belong to its topic. A topic whose
 * heading is not printed has no list of its own — its words stand under the heading before — and is named in `missing`.
 * Lines before the first heading (the introduction) are left out, and so are page numbers.
 */
export function parseKfuLevel(text: string): KfuLevel {
  const names = parseKfuTopicNames(text);
  const { lines, start } = sectionOf(text);
  const end = lines.findIndex((line, i) => i > start && SECTION_END.test(line));
  if (end < 0) throw new Error("у раздела «7. ЛЕКСИКА» нет конца: нет строки «8. Содержание отдельных частей …»");
  const found: { name: string; heading: string; rows: Cell[][] }[] = [];
  let last = -1;
  for (const line of lines.slice(start + 1, end)) {
    const cells = cellsOf(line);
    if (cells.length === 0 || (cells.length === 1 && PAGE_NUMBER.test(cells[0]!.text))) continue;
    const head = cells[0]!.text;
    const at = names.findIndex((name, i) => i > last && isHeading(head, name));
    if (at >= 0) {
      last = at;
      found.push({ name: names[at]!, heading: head, rows: [cells.slice(1)] });
    } else found.at(-1)?.rows.push(cells);
  }
  const topics = found.map(({ name, heading, rows }) => ({ name, heading, entries: entriesOf(rows) }));
  return { topics, missing: names.filter((name) => !topics.some((t) => t.name === name)) };
}

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

/**
 * The form a token of the lists is looked up under: a stem printed apart gives its name of action; a word the corpus
 * knows stands as it is (карга is a noun); a form in -рга/-ргә gives the name of action the corpus knows — the stem
 * in a vowel when it knows both (ашарга is ашау before ашу). When it knows none the stem is guessed: in a vowel
 * after л or р, where -ла/-лә and -ра/-рә make verbs (зурла-рга, калтыра-рга), in a consonant otherwise (сүн-әргә).
 */
function dictionaryFormOf(token: string, known: ReadonlySet<string>): string {
  if (STEM_AND_ENDING.test(token)) return infinitiveForms(token)[0]!;
  if (known.has(token)) return token;
  const forms = infinitiveForms(token);
  const guess = forms.length === 2 && !/[лр][аә]рг[аә]$/.test(token) ? forms[1] : forms[0];
  return forms.find((form) => known.has(form)) ?? guess ?? token;
}

export type EntryKind = "word" | "phrase" | "name" | "combination";
/**
 * An entry sorted. `lemma` is what the entry is looked up by in the corpus and in the catalog: a word or a combination
 * in lower case with its verb as a name of action, a phrase or a name as printed without its variant. `words` are the
 * words of a combination that the corpus knows, each once — the candidates for a card (spec §3.6: «белем алырга» → «белем»).
 */
export interface EntryInfo { kind: EntryKind; lemma: string; words: string[] }

/**
 * Fixed expressions the lists print without ! or ?: рәхим итегез, гафу итегез, сау бул…, таныш бул…, мин риза,
 * ал да гөл, and a question in -мыни/-мени (чынмыни). Matched against the main form in lower case.
 */
const PHRASE_PATTERNS: readonly RegExp[] = [/^(рәхим|гафу) ит(егез)?$/, /^сау бул/, /^таныш бул/, /^мин риза$/, /^ал да гөл$/, /(мыни|мени)$/];
/** A line of speech begins with a dash (U+2013, U+2014 or a hyphen); C1 prints some after a stray full stop. */
const SPEECH = /^[.\s]*[\u2013\u2014-]\s+/;
const OPENING_QUOTE = /^[«“„"]/;

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
 *     (әни (әнкәй), гына/генә), and the final sign.
 *  4. `combination` — the rest: several tokens, a free combination. Its words that the corpus knows go to `words`.
 * `known` are the words of the corpus in dictionary form; without them the stem of a verb is guessed and a
 * combination no words. The sorting is by rule and so imperfect: a common word printed with a capital is a `name`.
 */
export function classifyEntry(entry: string, known: ReadonlySet<string> = new Set()): EntryInfo {
  const text = fixLookalikes(entry).replace(/\s+/g, " ").trim();
  const speech = SPEECH.test(text);
  const said = withoutBrackets(text.replace(SPEECH, "").replace(/^[.\s]+/, ""));
  const main = said.split(/[/\\,]/)[0]!.replace(/[.,;:]+$/, "").trim();
  if (speech || /[!?]/.test(text) || PHRASE_PATTERNS.some((pattern) => pattern.test(main.toLowerCase()))) return { kind: "phrase", lemma: said, words: [] };
  if (OPENING_QUOTE.test(said) || isUpper(said.replace(/^[^\p{L}]+/u, "")[0])) return { kind: "name", lemma: said, words: [] };
  const tokens = main.toLowerCase().split(" ");
  const lemma = [...tokens.slice(0, -1), dictionaryFormOf(tokens.at(-1)!, known)].join(" ");
  if (tokens.length === 1) return { kind: "word", lemma, words: [] };
  return { kind: "combination", lemma, words: [...new Set(tokens.map((token) => dictionaryFormOf(token, known)).filter((word) => known.has(word)))] };
}

/** One line of the pool: an entry of the lists with the lowest level and the first topic it stands in. */
export interface PoolEntry {
  entry: string;
  /** Slug of the level: a1 … c1. */
  level: string;
  /** The heading the entry stands under, as printed. */
  kfuTopic: string;
  /** Slug of the catalog topic the heading is mapped to. */
  topic: string;
  kind: EntryKind;
  lemma: string;
  /** Place of a `word` in the frequency list of the corpus, from 1; null for a word the corpus does not have and for the other kinds. */
  rank: number | null;
  /** Slug of the level file that already holds the entry, or empty. */
  inCatalog: string;
  words: string[];
}

/**
 * Joins the lists of the levels, lowest first, into the pool: every entry once (`entryKey`), with the level and the
 * topic of its first place. `ranks` gives the place of a word of the corpus in the frequency list, `catalog` the
 * level file a word key stands in. Throws on a topic that `KFU_TOPICS` does not map.
 */
export function buildPool(
  levels: readonly { level: string; topics: readonly KfuTopic[] }[], o: { ranks: ReadonlyMap<string, number>; catalog: ReadonlyMap<string, string> },
): PoolEntry[] {
  const known = new Set(o.ranks.keys());
  const seen = new Set<string>();
  const pool: PoolEntry[] = [];
  for (const { level, topics } of levels) {
    for (const { name, heading, entries } of topics) {
      const topic = kfuTopicSlug(level, name);
      for (const entry of entries) {
        const key = entryKey(entry);
        if (key === "" || seen.has(key)) continue;
        seen.add(key);
        const info = classifyEntry(entry, known);
        pool.push({
          entry, level, kfuTopic: heading, topic, ...info,
          rank: info.kind === "word" ? o.ranks.get(info.lemma) ?? null : null, inCatalog: o.catalog.get(wordKey(info.lemma)) ?? "",
        });
      }
    }
  }
  return pool;
}

export const POOL_HEADER = ["entry", "level", "kfu_topic", "topic", "kind", "lemma", "rank", "in_catalog", "words"] as const;

/** The pool as a table: tab-separated, a header, one line per entry. */
export function formatPool(pool: readonly PoolEntry[]): string {
  const lines = pool.map((p) => [p.entry, p.level, p.kfuTopic, p.topic, p.kind, p.lemma, p.rank ?? "", p.inCatalog, p.words.join(", ")].join("\t"));
  return [POOL_HEADER.join("\t"), ...lines].join("\n") + "\n";
}
