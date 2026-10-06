/**
 * The word lists of the KFU specifications A1–C1 («Лексический минимум», spec §3.6): reading them from the text of a
 * specification. Pure: no I/O; scripts/kfu-lists.ts reads and writes the files, scripts/lib/kfu-pool.ts sorts the
 * entries and joins the levels into one pool.
 *
 * The text is the one that keeps the layout of the pages (`s_<LEVEL>.layout.txt`): there a line of the word table is
 * a line of text and its columns stand apart by two spaces or more, so a heading and the words under it stay together.
 * The plain extraction of the same file tears the columns of a page apart and puts the right one under another heading.
 */

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

/** One topic of a word list: its name in the list of topics, the heading printed over its words, and the entries in the printed order. */
export interface KfuTopic { name: string; heading: string; entries: string[] }
/**
 * Lines of the text that were joined into one entry, in `parts`. `rule` says why: `brackets` and `margin` are the
 * rules of `parseKfuLevel`, `correction` an entry of `KFU_CORRECTIONS`.
 */
export interface KfuJoin { topic: string; rule: "brackets" | "margin" | "correction"; parts: string[] }
/** The word list of one specification. `missing` are the topics of the list of topics that have no heading over the words. */
export interface KfuLevel { topics: KfuTopic[]; missing: string[]; joins: KfuJoin[] }

const TOPICS_START = "Основные темы";
const SECTION_START = /^\s*7\.\s*ЛЕКСИКА\s*$/;
const SECTION_END = /^\s*\d+\.\s*Содержание отдельных частей/;
/** A page number stands alone on its line. */
const PAGE_NUMBER = /^\d+$/;
const NUMBER = /^(\d+)\.\s*/;
const PAGE_BREAK = "\f";

/**
 * The lines of a text and the line the word section begins at. A glyph of a symbol font (a private-use character:
 * the bullet of a list) becomes a space, so that the columns stay where they are. A page break stays in its line.
 */
function sectionOf(text: string): { lines: string[]; start: number } {
  const lines = text.replace(/[\uE000-\uF8FF]/g, " ").split(/\r?\n/);
  const start = lines.findIndex((line) => SECTION_START.test(line.replaceAll(PAGE_BREAK, "")));
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
  const before = lines.slice(0, start).map((line) => line.replaceAll(PAGE_BREAK, "").trim());
  const from = before.lastIndexOf(TOPICS_START);
  if (from < 0) throw new Error(`перед разделом «7. ЛЕКСИКА» нет списка «${TOPICS_START}»`);
  const items = before.slice(from + 1).filter((line) => line !== "" && !PAGE_NUMBER.test(line));
  const numbered = items.some((item) => NUMBER.test(item));
  const topics: string[] = [];
  for (const item of items) {
    if (numbered && !NUMBER.test(item) && topics.length) topics[topics.length - 1] += ` ${item}`;
    else topics.push(item.replace(NUMBER, ""));
  }
  return topics.map((topic) => topic.split("/")[0]!.replace(/\s+/g, " ").trim()).filter((name) => name !== "");
}

/** A cell of a line of the word table: its text without the number, where it begins and ends on the line, and the number that stands before it, if any. */
interface Cell { text: string; start: number; end: number; number: number | null }
/** A line of the word table. `newPage`: a page break stands between this line and the one before it. */
interface Row { cells: Cell[]; newPage: boolean }

/** The cells of a line: runs of words two spaces or more apart. A number that stands alone belongs to the cell after it. */
function cellsOf(line: string): Cell[] {
  const cells: Cell[] = [];
  /** A number that waits for its text, and its place. */
  let waiting: { number: number; start: number } | null = null;
  for (const m of line.matchAll(/\S+(?: \S+)*/g)) {
    const text = m[0].replace(NUMBER, "");
    const number = text === m[0] ? null : Number(NUMBER.exec(m[0])![1]);
    const end = m.index + m[0].length;
    if (text === "") { waiting = { number: number!, start: m.index }; continue; }
    if (number !== null) cells.push({ text, start: m.index, end, number });
    else if (waiting) cells.push({ text, start: waiting.start, end, number: waiting.number });
    else cells.push({ text, start: m.index, end, number: null });
    waiting = null;
  }
  return cells;
}

/** For comparing a heading with the name of a topic: no case, spaces or punctuation. */
const squash = (text: string): string => text.toLowerCase().replace(/[\s.,/:«»"“”]+/g, "");
const isUpper = (c: string | undefined): boolean => c !== undefined && c !== c.toLowerCase();
const isLower = (c: string | undefined): boolean => c !== undefined && c !== c.toUpperCase();

/** True if the cell is the heading of the topic: its name with a capital, alone («Йорт.Фатир») or with more after a sign («Шәһәр. Транспорт»). */
function isHeading(cell: string, name: string): boolean {
  if (!isUpper(cell[0])) return false;
  return squash(cell) === squash(name) || (cell.startsWith(name) && /^[^\p{L}\p{N}]/u.test(cell.slice(name.length)));
}

/** A cell of the right column may begin this many characters to the left of the place the column begins at. */
const COLUMN_SLACK = 2;
/** A cell that stands alone on its line is in the right column when it begins at least this far to the right of the leftmost cell of its page. */
const COLUMN_GAP = 12;

/**
 * The entries of a numbered list, in the order of their numbers — the printed order, whatever the columns. An entry
 * begins at a number, and a cell without one continues the entry of its column: the right column when the cell
 * stands after the second number of its line or at the place of the last right-hand number, the left one otherwise.
 */
function numberedEntries(rows: Row[]): string[] {
  const out: { number: number; text: string }[] = [];
  let left = -1, right = -1, rightStart = Infinity;
  for (const { cells } of rows) {
    let numbers = 0;
    for (const cell of cells) {
      if (cell.number !== null) {
        out.push({ number: cell.number, text: cell.text });
        if (numbers === 0) left = out.length - 1;
        else { right = out.length - 1; rightStart = cell.start; }
        numbers += 1;
        continue;
      }
      const at = numbers >= 2 || cell.start >= rightStart - COLUMN_SLACK ? right : left;
      if (at < 0) out.push({ number: Infinity, text: cell.text });
      else out[at]!.text += ` ${cell.text}`;
    }
  }
  // The sort is stable: entries with one number, and those without any, keep the order they were read in.
  return out.sort((a, b) => a.number - b.number).map((entry) => entry.text);
}

/** The two columns of one page of a list; `right` is empty where the page has one column. */
interface Page { left: Cell[]; right: Cell[] }

/**
 * The pages of a list without numbers, each cut into its columns. The printed order of such a list is page by page,
 * the left column and then the right one (the lists are alphabetical down the left column of a page and on down its
 * right column). The columns of a page stand at their own places, so each page is read by itself. The right column
 * begins where the second cells of the lines begin; on a page whose lines hold one cell each, a cell is in the right
 * column when it begins `COLUMN_GAP` to the right of the leftmost one.
 */
function pagesOf(rows: Row[]): Page[] {
  const pages: Row[][] = [];
  for (const row of rows) {
    if (row.newPage || pages.length === 0) pages.push([]);
    pages.at(-1)!.push(row);
  }
  return pages.map((page) => {
    const cells = page.flatMap((row) => row.cells);
    const leftmost = Math.min(...cells.map((cell) => cell.start));
    const seconds = page.filter((row) => row.cells.length >= 2).map((row) => row.cells[1]!.start);
    const rightStart = Math.min(...(seconds.length ? seconds : cells.map((cell) => cell.start).filter((start) => start >= leftmost + COLUMN_GAP)));
    const inRight = (cell: Cell): boolean => cell.start >= rightStart - COLUMN_SLACK;
    return { left: cells.filter((cell) => !inRight(cell)), right: cells.filter(inRight) };
  });
}

/** A cell that is nothing but brackets: the abbreviation of the name above it, wrapped to its own line. */
const BRACKETS_ONLY = /^\([^()]*\)$/;
const firstLetter = (text: string): string | undefined => /\p{L}/u.exec(text)?.[0];

/**
 * The entries of one column, with the lines of a wrapped entry joined. Two rules, both about a name that did not fit
 * into its cell:
 *  - `brackets`: a cell that is nothing but brackets continues the entry above it;
 *  - `margin`, only in a list printed in one column (`width` is the place its widest line ends at): a name — a line
 *    of several words that begins with a capital — is continued by the next line when that begins with a small letter
 *    and its first word would not have fit on the line above. A word that would have fit was not wrapped, so the
 *    line is an entry of its own.
 * A wrap that neither rule sees stays two entries; `KFU_CORRECTIONS` names the ones found by eye.
 */
function joinWrapped(column: Cell[], topic: string, width: number | null, joins: KfuJoin[]): string[] {
  /** An entry being read: its text so far, its first line, where its last line ends, and the join it is part of. */
  const out: { text: string; first: string; end: number; join: KfuJoin | null }[] = [];
  for (const cell of column) {
    const above = out.at(-1);
    const fits = above !== undefined && width !== null && above.end + 1 + cell.text.split(" ")[0]!.length <= width;
    const rule = !above ? null
      : BRACKETS_ONLY.test(cell.text) ? "brackets"
      : width !== null && !fits && above.first.includes(" ") && isUpper(firstLetter(above.first)) && isLower(firstLetter(cell.text)) ? "margin"
      : null;
    if (!above || rule === null) { out.push({ text: cell.text, first: cell.text, end: cell.end, join: null }); continue; }
    if (!above.join) joins.push(above.join = { topic, rule, parts: [above.text] });
    above.join.parts.push(cell.text);
    above.text += ` ${cell.text}`;
    above.end = cell.end;
  }
  return out.map((entry) => entry.text);
}

/**
 * Reads the word list of a specification. The section runs from «7. ЛЕКСИКА» to «8. Содержание отдельных частей …».
 * A topic begins at the line whose first cell is the name of a topic of the list «Основные темы» that comes after
 * the topic open now: so a heading printed again under itself, and a word that is also the name of a later topic
 * but has no capital, are entries. The cells that share the line with a heading belong to its topic. A topic whose
 * heading is not printed has no list of its own — its words stand under the heading before — and is named in `missing`.
 * Lines before the first heading (the introduction) are left out, and so are page numbers.
 * The entries of a topic come in the printed order: a numbered list by its numbers (`numberedEntries`), a list
 * without numbers page by page, the left column before the right one (`pagesOf`). Lines of a wrapped entry are
 * joined where a rule says so (`joinWrapped`), and every join is named in `joins` for the author to check.
 */
export function parseKfuLevel(text: string): KfuLevel {
  const names = parseKfuTopicNames(text);
  const { lines, start } = sectionOf(text);
  const end = lines.findIndex((line, i) => i > start && SECTION_END.test(line.replaceAll(PAGE_BREAK, "")));
  if (end < 0) throw new Error("у раздела «7. ЛЕКСИКА» нет конца: нет строки «8. Содержание отдельных частей …»");
  const found: { name: string; heading: string; rows: Row[] }[] = [];
  let last = -1;
  /** A page break was passed since the last line of the table. */
  let newPage = false;
  for (const line of lines.slice(start + 1, end)) {
    newPage ||= line.includes(PAGE_BREAK);
    const cells = cellsOf(line.replaceAll(PAGE_BREAK, ""));
    if (cells.length === 0 || (cells.length === 1 && cells[0]!.number === null && PAGE_NUMBER.test(cells[0]!.text))) continue;
    const head = cells[0]!.text;
    const at = names.findIndex((name, i) => i > last && isHeading(head, name));
    if (at >= 0) {
      last = at;
      found.push({ name: names[at]!, heading: head, rows: [{ cells: cells.slice(1), newPage: false }] });
    } else found.at(-1)?.rows.push({ cells, newPage });
    newPage = false;
  }
  const lists = found.map(({ name, heading, rows }) => {
    const filled = rows.filter((row) => row.cells.length > 0);
    const numbered = filled.some((row) => row.cells.some((cell) => cell.number !== null));
    const pages = numbered ? [] : pagesOf(filled);
    return { name, heading, rows: filled, numbered, pages, oneColumn: !numbered && pages.every((page) => page.right.length === 0) };
  });
  // The width of a list printed in one column: the place the widest line of such lists ends at.
  const ends = lists.filter((list) => list.oneColumn).flatMap((list) => list.pages.flatMap((page) => page.left.map((cell) => cell.end)));
  const width = ends.length ? Math.max(...ends) : null;
  const joins: KfuJoin[] = [];
  const topics = lists.map((list) => ({
    name: list.name, heading: list.heading,
    entries: list.numbered
      ? numberedEntries(list.rows)
      : list.pages.flatMap((page) => [page.left, page.right].flatMap((column) => joinWrapped(column, list.name, list.oneColumn ? width : null, joins))),
  }));
  return { topics, missing: names.filter((name) => !topics.some((t) => t.name === name)), joins };
}

/**
 * A place where the layout misleads the rules, found by eye: two entries, one after the other, that are one entry
 * wrapped over two lines (`join`), or an entry that is printed outside its table (`move`, to the topic named, before
 * the entry `before` or to the end).
 */
export type KfuCorrection = { join: readonly [string, string] } | { move: string; to: string; before?: string };

/**
 * The known corrections, by level. Both are in A2 «Татарстан халыклары» and «Табибта»:
 *  - the name of an organisation stands in two cells of the right column, and both begin with a capital, so no rule
 *    of `joinWrapped` sees the wrap;
 *  - the first word of the right column of «Табигать һәм тирәлек» is printed one line above the heading of its
 *    table, where the text gives it to the table before.
 * A correction that no longer fits the text stops the reading (`parseKfuLists`): the files were fetched anew.
 */
export const KFU_CORRECTIONS: Readonly<Record<string, readonly KfuCorrection[]>> = {
  a2: [
    { join: ["Берләшкән Дәүләтләр", "Бердәмлеге (БДБ) илләре"] },
    { move: "кадер-хөрмәт", to: "Табигать һәм тирәлек", before: "капка" },
  ],
};

/** An entry that a correction moved: from the topic the text gives it to, to the one it belongs to. */
export interface KfuMove { entry: string; from: string; to: string }
/** The word list of one level, as read and corrected. */
export type KfuList = KfuLevel & { level: string; moves: KfuMove[] };

/** Applies the corrections of a level to its list. Throws, naming the level and the entry, when one does not fit. */
function corrected(level: string, list: KfuLevel, corrections: readonly KfuCorrection[]): KfuList {
  const topics = list.topics.map((t) => ({ ...t, entries: [...t.entries] }));
  const joins = [...list.joins];
  const moves: KfuMove[] = [];
  const fail = (what: string): never => { throw new Error(`исправление для ${level} не подходит к тексту: ${what} (KFU_CORRECTIONS в scripts/lib/kfu.ts)`); };
  for (const c of corrections) {
    if ("join" in c) {
      const [first, second] = c.join;
      const topic = topics.find((t) => t.entries.some((entry, i) => entry === first && t.entries[i + 1] === second));
      if (!topic) { fail(`записи «${first}» и «${second}» не стоят подряд`); continue; }
      topic.entries.splice(topic.entries.findIndex((entry, i) => entry === first && topic.entries[i + 1] === second), 2, `${first} ${second}`);
      joins.push({ topic: topic.name, rule: "correction", parts: [first, second] });
    } else {
      const to = topics.find((t) => t.name === c.to);
      const from = topics.find((t) => t !== to && t.entries.includes(c.move));
      if (!to) { fail(`темы «${c.to}» нет`); continue; }
      if (!from) { fail(`записи «${c.move}» нет вне темы «${c.to}»`); continue; }
      const at = c.before === undefined ? to.entries.length : to.entries.indexOf(c.before);
      if (at < 0) { fail(`в теме «${c.to}» нет записи «${c.before}»`); continue; }
      from.entries.splice(from.entries.indexOf(c.move), 1);
      to.entries.splice(at, 0, c.move);
      moves.push({ entry: c.move, from: from.name, to: to.name });
    }
  }
  return { level, topics, missing: list.missing, joins, moves };
}

/**
 * Reads the word lists of the specifications given, lowest level first, and applies the known corrections
 * (`KFU_CORRECTIONS`) to each. What was joined and moved is in `joins` and `moves` of every list.
 */
export function parseKfuLists(texts: readonly { level: string; text: string }[], corrections: Readonly<Record<string, readonly KfuCorrection[]>> = KFU_CORRECTIONS): KfuList[] {
  return texts.map(({ level, text }) => corrected(level, parseKfuLevel(text), corrections[level] ?? []));
}
