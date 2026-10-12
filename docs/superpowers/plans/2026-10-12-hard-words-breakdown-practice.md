# Hard words, word-by-word breakdown, three-word practice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the loop of hard words (Part A), give every catalog example a «🔎 Разбор» toggle fed by checked per-level gloss files (Part B, code only), and turn the practice card into a three-word walkthrough (practice spec).

**Architecture:** Three groups, done in this order, each releasable alone (a push to `master` deploys): **Group A** (Tasks 1–4) changes the ladder, `pick()`, the queue read and the session screens; **Group B** (Tasks 5–9) adds `data/gloss/<level>.tsv` → validation → `notes.example_gloss` JSON → the card toggle; **Group C** (Tasks 10–11) rewrites the practice card. Pure logic lives in `src/srs`, `src/review/pick.ts`, `src/content/gloss.ts`, `src/tutorial/practice.ts`, `scripts/lib/gloss.ts`; D1 in `src/db`; text in `src/bot` + `src/i18n`.

**Tech Stack:** TypeScript, Cloudflare Worker + D1, grammY, vitest (`@cloudflare/vitest-pool-workers`), tsx scripts, dependency-cruiser.

**Spec:** `docs/superpowers/specs/2026-10-12-hard-words-and-breakdown-design.md` (Part A → Group A, Part B → Group B), `docs/superpowers/specs/2026-10-12-three-word-practice-design.md` (Group C). Read the spec section a task names before starting it.

## Global Constraints

- Every task ends green on: `pnpm typecheck`, `pnpm depcruise`, `pnpm test:ci`, `pnpm validate --base origin/master`. Run all four before each commit (budget tests in `test/budget/` are part of `test:ci` and must stay within their budgets).
- TDD: the failing test is written and seen failing before the code.
- Style as the code around it: comments and doc comments in English, full sentences; user-facing texts Russian in `src/i18n/ru.ts`, Tatar in `src/i18n/tt.ts` (Tatar letters only — `test/i18n/dict.test.ts` checks it; every new function key needs a `SAMPLE_ARGS` entry there).
- `srs/` stays pure (depcruise `srs-is-pure`); only `src/bot` imports grammy; services never import `src/bot`.
- `data/work/` is never committed; no learner data or secrets in code, data or logs.
- Every commit message ends with these two lines:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01CiDfx5Vzphh1nTYfcQvAx1
  ```
- Fixed numbers from the specs: a new word after **2** learning cards in a row; **3** answers today → «Снова»/«Трудно» give **1 day**; gloss ≤ **40** characters; Telegram text limit **4096** (`TEXT_LIMIT` in `src/bot/views.ts`); practice words **китап — книга, су — вода, әни — мама**.
- Migrations: Group A adds `migrations/0010_log_card_index.sql`, Group B adds `migrations/0011_example_gloss.sql`. If B is ever released before A, renumber B's file to 0010.

## Review Focus

1. **Undo after a grade that postponed a word** — the undone `review_log` row must not count: the card comes back with the 1-/5-minute previews if it now has fewer than 3 answers today (Task 4 test).
2. **Direction «both»** — the sibling card of the word just answered must not come next while anything else can be shown, and the done-screen line counts words, not cards (Tasks 2 and 3 tests).
3. **The learner's day boundary (04:00 local, `dayWindow`)** — on the next day the count of answers starts at 0, and the postponed card is counted in 🔴 and given as an ordinary learning card once due (Task 4 test).
4. **A «🔎» press that cannot be honoured** — a card already graded, a forged `gl:` with another user's card id, a card without gloss (own or AI word: no button at all) all answer like a stale button and write nothing (Tasks 8–9 tests).
5. **Example tokenisation edge cases** — a lone «—» disappears, `5-че` and `әкрен-әкрен` stay one word, «» and quotes are stripped at the edges only, so validator, seed and `check_gloss.py` agree on the same words (Task 5 test).

---

# Group A — hard words (spec Part A)

### Task 1: The ladder knows today's answers

**Files:**
- Modify: `src/srs/ladder.ts`
- Test: `test/srs/ladder.test.ts`

**Interfaces:**
- Produces: `export const DAY_ANSWERS = 3;` `export const TOMORROW_MS = 24 * 60 * 60_000;` `grade(m: Mem, rating: Rating, now: number, answersToday = 0): Mem`; `preview(m: Mem, now: number, answersToday = 0): Record<Rating, number>` (still `grade(...).due` for each rating, same `answersToday`).

- [ ] **Step 1: Write the failing tests** in a new `describe("enough for today (spec A3)")`:

```ts
const learning1: Mem = { ...newMem(T), state: "learning", step: 0, reps: 3 };
it("«Снова» and «Трудно» after 3 answers today give 1 day on rung 1", () => {
  for (const r of [1, 2] as const) {
    const m = grade(learning1, r, T, 3);
    expect(m).toMatchObject({ state: "learning", step: 0, due: T + TOMORROW_MS, scheduledDays: 0, reps: 4 });
    expect(rungOf(m)).toBe(1);
  }
});
it("a review card answered for the 4th time today goes to relearning, and «Снова» counts a lapse", () => {
  const rel: Mem = { ...learning1, state: "relearning" };
  expect(grade(rel, 2, T, 4)).toMatchObject({ state: "relearning", step: 0, due: T + TOMORROW_MS });
  const rev: Mem = { ...newMem(T), state: "review", scheduledDays: 14, reps: 5, lapses: 1 };
  expect(grade(rev, 1, T, 3)).toMatchObject({ state: "relearning", step: 0, due: T + TOMORROW_MS, lapses: 2 });
});
it("«Хорошо» and «Легко» ignore the count; fewer than 3 answers change nothing", () => {
  expect(grade(learning1, 3, T, 5)).toEqual(grade(learning1, 3, T));
  expect(grade(learning1, 4, T, 5)).toEqual(grade(learning1, 4, T));
  expect(grade(learning1, 1, T, 2)).toEqual(grade(learning1, 1, T));
});
it("preview says exactly what grade stores, with the same count", () => {
  expect(preview(learning1, T, 3)).toEqual({ 1: T + TOMORROW_MS, 2: T + TOMORROW_MS, 3: T + 10 * MIN, 4: T + DAY });
});
```

- [ ] **Step 2: Run** `pnpm vitest run test/srs/ladder.test.ts` — Expected: FAIL (`TOMORROW_MS` not exported / wrong due).
- [ ] **Step 3: Implement** in `grade`: when `answersToday >= DAY_ANSWERS && rating <= 2` return `{ state: m.state === "review" || m.state === "relearning" ? "relearning" : "learning", step: 0, stability: null, difficulty: null, due: now + TOMORROW_MS, lastReview: now, scheduledDays: 0, reps: m.reps + 1, lapses: (rating === 1 && m.state === "review") ? m.lapses + 1 : m.lapses }`; otherwise unchanged. `preview` passes the count through. Doc comment: the count is the card's answers today that were not undone, before this one.
- [ ] **Step 4: Run** the same command — Expected: PASS; then the four global checks.
- [ ] **Step 5: Commit** `feat(srs): «Снова»/«Трудно» after three answers today send the word to tomorrow` (+ the two trailer lines).

### Task 2: `pick()` mixes new words in and never repeats the last word

**Files:**
- Modify: `src/review/pick.ts`
- Test: `test/review/pick.test.ts`

**Interfaces:**
- Creates the type Task 3 fills: `export interface RecentAnswer { cardId: number; noteId: number; stateBefore: CardState }` in `src/db/queue.ts`, re-exported from `src/db/repo.ts` (as `CardRow` is); `pick.ts` imports it from `../db/repo`.
- Produces: `export interface Recent { noteId: number | null; learningRun: number }`; `export const NO_RECENT: Recent = { noteId: null, learningRun: 0 }`; `export const NEW_AFTER_LEARNING = 2`; `export function recentOf(log: RecentAnswer[]): Recent` (log newest first: `noteId` of the first entry; `learningRun` = how many leading entries have `stateBefore` `learning`/`relearning`); `pick(c: Candidates, newLeft: number, now: number, mix: number, recent: Recent = NO_RECENT): Pick | null`.

- [ ] **Step 1: Write the failing tests** (reuse the file's `card`, `fresh`, `cands`; give `card` an optional `noteId` and direction):

```ts
it("after two learning cards in a row a new word comes before a due learning card (A1)", () => {
  const c = cands([card(1, "learning", T - 1)], [], [fresh(1)]);
  expect(pick(c, 5, T, 0, { noteId: 9, learningRun: 2 })?.kind).toBe("new");
  expect(pick(c, 5, T, 0, { noteId: 9, learningRun: 1 })?.kind).toBe("card");
  expect(pick(c, 0, T, 0, { noteId: 9, learningRun: 2 })?.kind).toBe("card"); // the day's limit holds
});
it("the word just answered is not next while another due card exists (A2)", () => {
  const p = pick(cands([card(1, "learning", T - 2), card(2, "learning", T - 1)], [], []), 0, T, 0, { noteId: 1, learningRun: 1 });
  expect(p).toEqual({ kind: "card", card: expect.objectContaining({ id: 2 }) });
});
it("nor its card of the other direction", () => { /* card 1 and card 3 share noteId 1, card 3 ru_tt; recent noteId 1; card 2 of note 2 due later → id 2 */ });
it("a new word or a learn-ahead card counts as another card", () => {
  expect(pick(cands([card(1, "learning", T - 1)], [], [fresh(1)]), 5, T, 0, { noteId: 1, learningRun: 0 })?.kind).toBe("new");
  expect(pick(cands([card(1, "learning", T - 1), card(2, "learning", T + 30_000)], [], []), 0, T, 0, { noteId: 1, learningRun: 0 }))
    .toEqual({ kind: "card", card: expect.objectContaining({ id: 2 }) });
});
it("the same card again when nothing else can be shown (L6 kept)", () => {
  expect(pick(cands([card(1, "learning", T + 30_000)], [], []), 0, T, 0, { noteId: 1, learningRun: 1 }))
    .toEqual({ kind: "card", card: expect.objectContaining({ id: 1 }) });
});
it("recentOf: the last word and the run of learning answers", () => {
  expect(recentOf([])).toEqual(NO_RECENT);
  expect(recentOf([{ cardId: 5, noteId: 7, stateBefore: "learning" }, { cardId: 6, noteId: 8, stateBefore: "relearning" }])).toEqual({ noteId: 7, learningRun: 2 });
  expect(recentOf([{ cardId: 5, noteId: 7, stateBefore: "new" }, { cardId: 6, noteId: 8, stateBefore: "learning" }])).toEqual({ noteId: 7, learningRun: 0 });
});
```
Existing tests stay as they are (they use the default `NO_RECENT`).

- [ ] **Step 2: Run** `pnpm vitest run test/review/pick.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Move today's body into a private `pickFrom(c, newLeft, now, mix, learningRun)` that adds A1: when a due learning card exists, return the first new note instead if `newLeft > 0 && learningRun >= NEW_AFTER_LEARNING` and one exists. `pick` calls `pickFrom` on the candidates without every card/new note whose `noteId === recent.noteId`, and only when that gives null, on the full candidates. Update the doc comment of `pick` (order, A1, A2, L6).
- [ ] **Step 4: Run** — Expected: PASS; global checks.
- [ ] **Step 5: Commit** `feat(review): a new word after two learning cards, and never the same word twice in a row`.

### Task 3: The queue reads today's answers, the last two answers and the postponed words

**Files:**
- Create: `migrations/0010_log_card_index.sql`
- Modify: `src/db/queue.ts` (`Queue`, `readQueue`), `src/db/sql.ts`, `src/db/repo.ts`
- Test: `test/db/repo.test.ts` (or a new `test/db/hard-words.test.ts`), `test/db/schema.test.ts` if it lists indexes

**Interfaces:**
- Consumes: `RecentAnswer` (Task 2, `src/db/queue.ts`).
- Produces:
  - `export interface LearningRow extends CardRow { answersToday: number }`; `Queue.learning: LearningRow[]`; `Queue.recent: RecentAnswer[]` (≤ 2, newest first, today only).
  - `export const waitsPastToday = (c: string, dayEndMs: string) => \`(${c}.due >= ${dayEndMs} AND ${c}.due - ${c}.last_review >= 86400000)\`` in `src/db/sql.ts`: a learning/relearning card the A3 rule sent to tomorrow (ordinary learning steps are never a day long).
  - `Repo.cardForGrade(userId: number, cardId: number, dayStartMs: number): Promise<(CardRow & { answersToday: number }) | null>` — one query.
  - `Repo.dayEnd(...)` result gains `postponedToday: number`.

- [ ] **Step 1: Write the failing tests** (seed with `seedUser`/`bulkCards`, write log rows with `logStmt` from `test/helpers/review.ts`):
  - `"learning rows carry the answers of today that were not undone"`: a card with 3 log rows today, 1 yesterday, 1 undone today → `q.learning[0].answersToday === 3`.
  - `"recent: the last two answers of today, newest first, undone ones skipped"` → `[{ cardId, noteId, stateBefore: "learning" }, …]`; no answers today → `[]`.
  - `"a card sent to tomorrow is out of the learning list and the 🔴 count until the day it is due"`: card `learning`, `last_review = T`, `due = T + DAY` → absent from `q.learning`, `q.counts.learning` excludes it; read with the window of the next day → present and counted. A 10-minute card due 5 minutes after the day ends stays counted.
  - `"cardForGrade gives the card with today's answers, and null for another user's card"`.
  - `"dayEnd counts the words sent to tomorrow today, once per word"`: direction both, both cards of one note postponed today + one of another note → `postponedToday === 2`.
- [ ] **Step 2: Run** `pnpm vitest run test/db` — Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `0010_log_card_index.sql`: header comment (why: the count of a card's answers today, spec A3, read per learning card without reading the learner's whole day) and `CREATE INDEX IF NOT EXISTS idx_log_card_time ON review_log(card_id, reviewed_at);`.
  - Learning statement of `readQueue`: add `(SELECT COUNT(*) FROM review_log l WHERE l.card_id = c.id AND l.reviewed_at >= ${p(w.dayStartMs)} AND l.undone = 0) AS answers_today` and `AND NOT ${waitsPastToday("c", p(w.dayEndMs))}`; the same `NOT` in the learning count. New statement in the same batch (no new D1 call): `SELECT l.card_id, c.note_id, json_extract(l.state_before, '$.state') AS state_before FROM review_log l JOIN cards c ON c.id = l.card_id WHERE l.user_id = ? AND l.undone = 0 AND l.reviewed_at >= ? ORDER BY l.reviewed_at DESC, l.id DESC LIMIT 2` (mind the result indexes: streams are read by position `res[4 + i]`).
  - `cardForGrade`: `SELECT ${CARD_COLS}, (same subquery) AS answers_today FROM cards c JOIN notes n … WHERE c.id = ? AND c.user_id = ?`.
  - `dayEnd`: add to its batch `SELECT COUNT(DISTINCT note_id) AS n FROM cards WHERE user_id = ? AND state IN ('learning','relearning') AND last_review >= ? AND due - last_review >= 86400000`.
  - Update the doc comments of `readQueue` and `dayEnd`.
- [ ] **Step 4: Run** `pnpm vitest run test/db test/budget` — Expected: PASS (budgets hold: the new reads are index lookups and 2 log rows); global checks.
- [ ] **Step 5: Commit** `feat(db): the queue reads today's answers per learning card and the last two answers`.

### Task 4: The session uses them; the done screen says what went to tomorrow

**Files:**
- Modify: `src/review/service.ts`, `src/bot/views.ts` (`renderDone`), `src/i18n/ru.ts`, `src/i18n/tt.ts`
- Test: `test/review/service.test.ts` (new `describe("hard words (spec A)")`), `test/bot/views.test.ts`, `test/i18n/dict.test.ts`

**Interfaces:**
- Consumes: Task 1 `grade/preview(…, answersToday)`, Task 2 `pick(…, recentOf(q.recent))`, Task 3 `Queue.learning[].answersToday`, `Queue.recent`, `cardForGrade`, `dayEnd().postponedToday`.
- Produces: `DaySummary.postponedToday: number`; i18n `donePostponed: (n: number) => string`.

- [ ] **Step 1: Write the failing tests.**
  - `"the fourth answer of a word today: «Снова» and «Трудно» say and give 1 day"`: one word; grade it «Снова» three times, each time once it is due (`T`, `T+1min+1s`, …); the screen before the 4th answer has `intervals` `{1: "1 день", 2: "1 день", 3: "10 минут", 4: "1 день"}`; grading «Трудно» stores `due === now + DAY`, `state "learning"`, `step 0`, and gives a `done` screen with `summary.postponedToday === 1` and `nextLearningInMs === null`.
  - `"«Хорошо» on the fourth answer goes on as before"` (rung 2, 10 minutes).
  - `"an undone answer does not count"` (Review Focus 1): after 3 answers, `undo()`; the card screen's intervals are `1 минута / 5 минут / …`.
  - `"ten hard words: a new word comes after every two learning cards, and no word twice in a row"`: 10 words started, all graded «Трудно» once and due; `newPerDay` 5; walk 12 screens grading «Трудно», assert no two consecutive equal `noteId` and the kinds follow learning, learning, new, … while the limit lasts (use `view.reps === 0` for a new card).
  - `"the next day the postponed word is an ordinary learning card"` (Review Focus 3): at `T + DAY + 1min` the first screen is that card and `counts.l` counts it.
  - `"grade uses at most 4 D1 calls"` stays green unchanged.
  - views: `renderDone` with `postponedToday: 2` contains `ru.donePostponed(2)`; with 0 it does not.
  - dict: `donePostponed: [[1], [4]]` in `SAMPLE_ARGS`.
- [ ] **Step 2: Run** `pnpm vitest run test/review test/bot/views.test.ts test/i18n` — Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `intervalsOf(mem, user, answersToday)` passes the count to `preview`. In `nextScreen`: `pick(..., recentOf(q.recent))`; the shown card's count is `q.learning.find((x) => x.id === row.id)?.answersToday ?? 0` (a review or new card has no answers today). `grade()` and `undo()` read the card with `cardForGrade(user.id, cardId, dayWindow(...).dayStartMs)` and pass `answersToday` to `ladderGrade` / `intervalsOf`. Summary gets `postponedToday: end.postponedToday`.
  - `ROWS_PER_REVIEW` 9 → 10 (the new index row), comment updated.
  - `renderDone`: after the next-learning line, `if (s.postponedToday > 0) lines.push("", t.donePostponed(s.postponedToday))`.
  - ru: `donePostponed: (n: number) => \`Трудные слова отложены на завтра: ${n} — после сна они запоминаются лучше.\``; tt in the style of `doneNextLearning` (e.g. `Авыр сүзләр иртәгәгә калдырылды: ${n} — йокыдан соң алар яхшырак истә кала.`).
- [ ] **Step 4: Run** the same command, then all four global checks — Expected: PASS.
- [ ] **Step 5: Commit** `feat(review): hard words leave the loop — mixed with new words, sent to tomorrow after three answers`.

**Group A release check:** all four global checks green on the branch head.

---

# Group B — word-by-word breakdown (spec Part B, code only)

### Task 5: The pure rules of a breakdown

**Files:**
- Create: `src/content/gloss.ts`
- Test: `test/content/gloss.test.ts`

**Interfaces:**
- Produces:
  - `export const GLOSS_MAX = 40;` `export const GLOSS_EDGE = ".,!?;:«»\"()…—–-'“”„[]";` (exactly `PUNCT` of `.superpowers/sdd/gloss/check_gloss.py`)
  - `export function exampleWords(example: string): string[]` — `example.split(/\s+/)`, each stripped of `GLOSS_EDGE` characters at both ends, empty ones dropped (Python `str.split()` + `strip(PUNCT)`).
  - `export function glossKey(word: string): string` — NFC, trim, strip `GLOSS_EDGE` at the edges, lower case, `ё`→`е` (Python `key`).
  - `export interface GlossLine { form: string; lemma: string; gloss: string }`
  - `export type GlossEntry = [form: string, lemma: string, gloss: string, level: string | null]`
  - `export function cardWordLines(word: string, lines: Pick<GlossLine, "form" | "lemma">[]): boolean[]` — true where `glossKey(lemma)` or `glossKey(form)` equals `glossKey(word)` or `glossKey(first whitespace word of word)`.
  - `export function parseGloss(json: string | null): GlossEntry[] | null` — null for null, non-JSON, a non-array, an empty array or an entry not of 3 strings + string|null.
  - `export const TATAR_WORD = /^[0-9а-яёәөүҗңһА-ЯЁӘӨҮҖҢҺ]+(?:-[0-9а-яёәөүҗңһА-ЯЁӘӨҮҖҢҺ]+)*$/` (Python `TT`).

- [ ] **Step 1: Write the failing tests** (Review Focus 5):

```ts
expect(exampleWords("— Сәлам! Хәлләр ничек? — Яхшы, ә синең?")).toEqual(["Сәлам", "Хәлләр", "ничек", "Яхшы", "ә", "синең"]);
expect(exampleWords("Ул 5-че сыйныфта әкрен-әкрен укый.")).toEqual(["Ул", "5-че", "сыйныфта", "әкрен-әкрен", "укый"]);
expect(exampleWords("«Китап» (яңа)…")).toEqual(["Китап", "яңа"]);
expect(exampleWords("")).toEqual([]);
expect(glossKey(" Ёлка! ")).toBe("елка");
expect(cardWordLines("Хәлләр ничек?", [{ form: "Сәлам", lemma: "сәлам" }, { form: "Хәлләр", lemma: "хәл" }])).toEqual([false, true]);
expect(cardWordLines("булу", [{ form: "булдым", lemma: "булу" }])).toEqual([true]);
expect(parseGloss('[["китабымны","китап","мою книгу","A1"]]')).toEqual([["китабымны", "китап", "мою книгу", "A1"]]);
for (const bad of [null, "", "{}", "[]", '[["a","b"]]', '[["a","b","c",5]]']) expect(parseGloss(bad)).toBeNull();
```
- [ ] **Step 2: Run** `pnpm vitest run test/content/gloss.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the module (no imports; doc comment: shared by the validator, the seed and the card, so all three cut an example the same way as the interim checker).
- [ ] **Step 4: Run** — PASS; global checks.
- [ ] **Step 5: Commit** `feat(content): the rules that cut an example into words for its breakdown`.

### Task 6: `data/gloss/<level>.tsv` is read and checked by `pnpm validate`

**Files:**
- Create: `scripts/lib/gloss.ts`
- Modify: `scripts/lib/files.ts`, `scripts/validate-catalog.ts`
- Test: `test/scripts/gloss.test.ts`, `test/scripts/files.test.ts`

**Interfaces:**
- Consumes: Task 5 helpers; `CatalogLevel` from `scripts/lib/catalog.ts`; `LEVELS` (slug a1…c1, code A1…C1).
- Produces:
  - `export const GLOSS_HEADER = ["word", "n", "form", "lemma", "gloss"] as const;`
  - `export interface GlossFileLine { line: number; fields: string[] }`; `export interface GlossLevel { level: number; header: string; lines: GlossFileLine[] }`
  - `export function parseGlossLevel(level: number, text: string): GlossLevel` (split on `\n`, `\r` trimmed, empty lines skipped, `line` = 1-based line of the file).
  - `export function glossByWord(g: GlossLevel): Map<string, GlossLine[]>` (exact `word` string → its lines in file order; only 5-field lines).
  - `export function checkGloss(levels: CatalogLevel[], gloss: GlossLevel[]): string[]`
  - In `files.ts`: `export const GLOSS_DIR = "data/gloss";` `readGloss(dir = GLOSS_DIR): GlossLevel[]` (levels whose `<slug>.tsv` exists, A1 first); `strayGlossFiles(dir = GLOSS_DIR): string[]` (like `strayCatalogFiles`, for `.tsv`).
- Error texts (decided here): header `gloss/a1.tsv:1 заголовок «…», нужен «word\tn\tform\tlemma\tgloss»` (tabs shown as `\t`); a level without its catalog file `gloss/b2.tsv: нет файла уровня b2.csv`; a line of the file `gloss/a1.tsv:57 разбор: полей 4, нужно 5` / `gloss/a1.tsv:57 разбор: слова «…» нет в a1.csv`; a card `a1:12 разбор: нет строк` / `a1:12 разбор: n не 1…3` / `a1:12 разбор: формы «…» не совпадают со словами примера «…»` / `a1:12 разбор: слово карточки «…» не стоит ни в lemma, ни в form`; a line of a card `a1:12 разбор, строка 57: пустая lemma` / `…: пустой gloss` / `…: gloss длиннее 40` / `…: пробелы по краям` / `…: «…» не татарскими буквами` (checked on `form` and `lemma`) — `a1:12` is the catalog line (header = 1), `строка 57` the gloss-file line.

- [ ] **Step 1: Write the failing tests.** Fixture: `parseCatalogLevel(1, …)` with the real rows `Исәнмесез!`, `һәм`, `булу`, `Хәлләр ничек?` (copy them from `data/catalog/a1.csv` lines 2, 5, 8, 11) and their gloss lines from `data/work/gloss/a1-p1.tsv` (`Хәлләр ничек?` has 6 lines: Сәлам, Хәлләр, ничек, Яхшы, ә, синең).
  - `"a level whose breakdown matches its examples has no violation"` → `[]`.
  - one test per error text above, each mutating one fixture line, asserting the exact string.
  - `"a level without a gloss file is not checked"`: `checkGloss(levels, [])` → `[]`.
  - files: `readGloss` / `strayGlossFiles` on a temp dir under `/tmp` as `files.test.ts` does for the catalog.
- [ ] **Step 2: Run** `pnpm vitest run test/scripts/gloss.test.ts test/scripts/files.test.ts` — FAIL.
- [ ] **Step 3: Implement**, porting every rule of `check_gloss.py` (tokenisation through `exampleWords`, head-word rule through `cardWordLines`). Wire into `validate-catalog.ts` `main()`: `errors.push(...strayGlossFiles().map(…), ...checkGloss(levels, readGloss()))`, and add the gloss to the doc comment at the top of the script. A missing `data/gloss/` folder means no file and no error.
- [ ] **Step 4: Run** the tests, then `pnpm validate --base origin/master` (no `data/gloss` yet: still «нарушений нет») — PASS; global checks.
- [ ] **Step 5: Commit** `feat(scripts): pnpm validate checks the breakdown files data/gloss/<level>.tsv`.

### Task 7: The seed loads the breakdown into `notes.example_gloss`

**Files:**
- Create: `migrations/0011_example_gloss.sql`
- Modify: `src/content/csv.ts` (`SeedLevel`, `catalogToSql`), `scripts/csv-to-sql.ts`, `src/db/sql.ts` (`NoteFields`, `noteCols`, `noteFields`)
- Test: `test/seed.test.ts`, `test/db/schema.test.ts` (if it lists columns); fix test fixtures that build `NoteFields` literals (e.g. `test/review/pick.test.ts` `note`)

**Interfaces:**
- Consumes: Task 5 `GlossLine`, `GlossEntry`, `cardWordLines`; Task 6 `readGloss`, `glossByWord`; `wordKey` from `src/db/repo`.
- Produces: `SeedLevel.gloss?: ReadonlyMap<string, GlossLine[]>` (absent: the level has no gloss file); `NoteFields.exampleGloss: string | null` (raw JSON, read for every note by `noteCols`).

- [ ] **Step 1: Write the failing tests** in `test/seed.test.ts`, `describe("the breakdown of the examples")`:
  - `"a row with gloss lines stores them as JSON [form, lemma, gloss, level]; the level is the catalog level of the lemma, null for the card's word and for a lemma outside the catalog"`: A1 rows `китап`, `уку`; A2 row whose example lemma is `китап` → its entry has `"A1"`; the card's own word has `null`.
  - `"a level without a gloss file stores NULL, and loading the same files again writes no row"` (use `applySeed(...).rowsWritten === 0` on the second load).
  - `"a changed gloss rewrites only that note"`; `"a gloss change does not raise catalog_version"` (the hash passed is unchanged because `catalogHash()` does not read `data/gloss`).
- [ ] **Step 2: Run** `pnpm vitest run test/seed.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
  - `0011_example_gloss.sql`: comment (the breakdown of a catalog example, JSON written by the seed; NULL for own and AI notes) + `ALTER TABLE notes ADD COLUMN example_gloss TEXT;`.
  - `catalogToSql`: before the rows, `levelOfKey: Map<string, string>` = word key → level `code` over all `levels`. Per row: `lines = l.gloss?.get(row.word)`; value = `lines?.length ? sqlText(JSON.stringify(lines.map((g, k) => [g.form, g.lemma, g.gloss, isCard[k] ? null : levelOfKey.get(wordKey(g.lemma)) ?? null]))) : "NULL"`, with `isCard = cardWordLines(word, lines)`; add `["example_gloss", value]` to `values` so the UPDATE/INSERT and the «differs» check carry it. Extend the function's doc comment.
  - `csv-to-sql.ts`: `const gloss = new Map(readGloss().map((g) => [g.level, glossByWord(g)]))`, `gloss: gloss.get(level)` in each `SeedLevel`; print the number of levels with a breakdown.
  - `noteCols` adds `n.example_gloss`; `noteFields` maps it. The deploy needs no change: «Check catalog» in `.github/workflows/deploy.yml` runs `validate-catalog.ts` and `csv-to-sql.ts`, which now read `data/gloss`, and `data/gloss/**` is not in `paths-ignore`.
- [ ] **Step 4: Run** `pnpm vitest run test/seed.test.ts test/db test/budget` — PASS; global checks.
- [ ] **Step 5: Commit** `feat(content): the catalog seed stores each example's breakdown in notes.example_gloss`.

### Task 8: «🔎 Разбор» on the card, fitted under the Telegram limit

**Files:**
- Modify: `src/review/service.ts` (`CardView`, `toView`), `src/bot/views.ts` (`renderCard`, `CardFit`, `fitCard`, `cardText`), `src/i18n/ru.ts`, `src/i18n/tt.ts`
- Test: `test/bot/views.test.ts`, `test/i18n/dict.test.ts`

**Interfaces:**
- Consumes: Task 5 `parseGloss`, `cardWordLines`; Task 7 `NoteFields.exampleGloss`.
- Produces: `CardView.gloss: GlossEntry[] | null`; `renderCard(v, c, intervals, canUndo, lang, lead = "", glossOpen = false): Rendered`; callback data `gl:<cardId>:<reps>:<open 0|1>:<undo 0|1>` (open = the state after the press); i18n strings `glossBtn` «🔎 Разбор», `glossHideBtn` «🔎 Скрыть разбор» (tt «🔎 Тикшерү», «🔎 Тикшерүне яшерү»).

- [ ] **Step 1: Write the failing tests** in `views.test.ts`:
  - `"a card with a breakdown has «🔎 Разбор» in the row of 🔊 ↩ ⚑, before ⚑; a card without one has no such button"` — button data `gl:<id>:<reps>:1:<undo>`.
  - `"open: the breakdown stands under the example, all of it in a spoiler; the card's word is bold, a catalog lemma has its level"`: text contains `<blockquote><tg-spoiler>китабымны → китап (A1) — мою книгу` style lines and `<b>укыйм → уку</b> — (я) читаю` for the card word; the button reads «🔎 Скрыть разбор» with `gl:…:0:…`.
  - `"a breakdown too long for one message loses its last lines first, then ends with «…»; the example and the word stay whole"`: 200 entries of 40-character glosses → `visible length ≤ 4096`, the example text present whole, the block's last line `…`.
  - `"text in the breakdown is escaped"` (`<`/`&` in a gloss).
  - dict: no new function keys (both are strings).
- [ ] **Step 2: Run** `pnpm vitest run test/bot/views.test.ts test/i18n` — FAIL.
- [ ] **Step 3: Implement.** `toView` sets `gloss: parseGloss(row.exampleGloss)`. `CardFit` gains `gloss: number` (lines shown; `Infinity` in `WHOLE_CARD`); `cardText(…, glossOpen)` appends, right after the example's blockquote, `<blockquote><tg-spoiler>${lines.join("\n")}</tg-spoiler></blockquote>` when open and `v.gloss`; a cap below the number of lines shows the first `cap` lines and a last line `…`. `fitCard` first tries `largestFit(0, v.gloss.length, (cap) => render({ ...WHOLE_CARD, gloss: cap }))` when open, then the existing chain with `gloss: 0`. Line: `${bold(esc(form) + " → " + esc(lemma) + (level ? \` (${level})\` : ""))} — ${esc(gloss)}` with `bold` only for `cardWordLines(v.word, …)`.
- [ ] **Step 4: Run** — PASS; global checks.
- [ ] **Step 5: Commit** `feat(bot): «🔎 Разбор» shows the example word by word`.

### Task 9: The toggle redraws the card in place

**Files:**
- Modify: `src/review/service.ts` (new method), `src/bot/bot.ts`
- Test: `test/bot/handlers.test.ts` (new `describe("«🔎 Разбор»")`), `test/review/service.test.ts`

**Interfaces:**
- Consumes: Task 8 `renderCard(..., glossOpen)`, the card read `undo()` uses (`cardForGrade` after Group A).
- Produces: `ReviewService.cardAgain(user: User, cardId: number, reps: number, canUndo: boolean): Promise<Screen>` — `{ kind: "stale" }` when the card is not the user's or `mem.reps !== reps`; otherwise the card screen as `undo()` builds it (counters from one `readQueue`, nothing stored), `feedback: null`, `lead: onCard(user.hintsSeen)`.

- [ ] **Step 1: Write the failing tests** (harness `test/helpers/botHarness.ts`, catalog note with `example_gloss` set by SQL):
  - `"«🔎 Разбор» edits the same message: the breakdown opens, the button becomes «Скрыть разбор»; a second press closes it; nothing is written"` — methods `["editMessageText", "answerCallbackQuery"]`, same `message_id`, row counts of `cards`, `review_log`, `sessions` unchanged, no voice sent with autoplay on.
  - `"after the card is graded its «🔎» is a stale button"` (Review Focus 4) — toast `ru.staleButton`, no edit.
  - `"«🔎» with another learner's card id is a stale button"`.
  - `"↩ stays on the redrawn card when it was there"`.
- [ ] **Step 2: Run** `pnpm vitest run test/bot/handlers.test.ts test/review/service.test.ts` — FAIL.
- [ ] **Step 3: Implement** `cardAgain`; in `bot.ts` next to the `g:` handler: `c.callbackQuery(/^gl:(\d+):(\d+):([01]):([01])$/, …)` → `s.kind === "stale"` → `toast(ctx, t.staleButton)`; otherwise `redraw(ctx, renderCard(s.view, s.counts, s.intervals, s.canUndo, lang, lead, open === "1"))`. A comment says why it edits in place (the same card: a revealed spoiler may stay revealed).
- [ ] **Step 4: Run** — PASS; global checks.
- [ ] **Step 5: Commit** `feat(bot): the breakdown button opens and closes in the card's own message`.

**Group B release check:** all four global checks green; with no `data/gloss/` the bot behaves as before (no button anywhere). Content files are added later by level, each passing `pnpm validate`.

---

# Group C — three-word practice (practice spec)

### Task 10: The pure part of the practice

**Files:**
- Modify: `src/tutorial/practice.ts`
- Test: `test/tutorial/practice.test.ts` (rewrite)

**Interfaces:**
- Produces:
  - `export const PRACTICE_WORDS = [{ word: "китап", translation: "книга" }, { word: "су", translation: "вода" }, { word: "әни", translation: "мама" }] as const;`
  - `export type PracticeWordNo = 1 | 2 | 3;`
  - `export const practiceData = (word: PracticeWordNo, rating: Rating): string => \`pr:s${word}:${rating}\`;`
  - `export type PracticePress = { kind: "press"; word: PracticeWordNo; rating: Rating } | { kind: "restart" };`
  - `export function parsePress(data: string): PracticePress | null` — `pr:s<1-3>:<1-4>` → press; the old `pr:<mask 0–15>:<1-4>` → restart; anything else null.
  - `newWordIntervals()` kept. The old `parse`, `ALL`, `press`, `tried`, `PRACTICE_WORD` stay untouched in this task (the bot still uses them) and are deleted in Task 11.

- [ ] **Step 1: Write the failing tests** (added beside the old ones): the three words and translations; `practiceData(2, 3) === "pr:s2:3"`; `parsePress("pr:s3:4")` → press; `parsePress("pr:0:3")`, `parsePress("pr:15:1")` → restart; `parsePress("pr:s4:1")`, `parsePress("pr:s1:5")`, `parsePress("pr:16:1")`, `parsePress("pr:x")` → null.
- [ ] **Step 2: Run** `pnpm vitest run test/tutorial/practice.test.ts` — FAIL.
- [ ] **Step 3: Implement**; rewrite the module doc comment (three cards, one press each, state in the button data; old data restarts).
- [ ] **Step 4: Run** — PASS; global checks.
- [ ] **Step 5: Commit** `feat(tutorial): the data of the three-word practice`.

### Task 11: The practice card shows three words with one press each

**Files:**
- Modify: `src/bot/screens.ts` (`renderPractice`), `src/bot/bot.ts` (practice handlers), `src/bot/views.ts` (`gradeRows` loses `tried`), `src/i18n/ru.ts`, `src/i18n/tt.ts`
- Test: `test/bot/tutorial.test.ts` (practice tests rewritten), `test/bot/views.test.ts` (the `gradeRows` test), `test/i18n/dict.test.ts`

**Interfaces:**
- Consumes: Task 10.
- Produces: `renderPractice(next: 1 | 2 | 3 | 4, last: Rating | null, lang: Lang, replay: boolean): Rendered` (`next` 4 = the final screen); i18n: `practiceTitle: (k: number) => string` («🎓 Тренировка · слово ${k} из 3»), `practiceNote` (string, the spec's «Так выглядит карточка. …» sentence), `practiceAgain/Hard: (interval: string) => string`, `practiceGood: (interval: string, then: string) => string`, `practiceEasy: (interval: string, good: string) => string`, `practiceDone` (string); removed keys `practiceTask`, `practiceLadder`, `practiceLeft`; `intro1` gains the line «Сейчас попробуем на трёх словах — это займёт полминуты.» after a blank line.
- Russian texts are exactly the spec's table (§2) with `{i}`/`{g}` in the «after» form: «Слово вернулось бы через 1 минуту и начало бы лесенку заново.», «…через 5 минут на той же ступеньке.», «…через 10 минут, потом через 1 день, 3 дня, 7 дней — всё реже.», «…не через 10 минут, а сразу через 1 день.»; `practiceDone` = «🎉 Готово! Так и идёт обучение: бот показывает слова по одному, вы честно оцениваете, и каждое слово возвращается тогда, когда его пора повторить — трудные чаще, лёгкие реже.\nВернуться к этой тренировке — /howto.». Tatar: rewrite the existing tt `practice*` lines in the same voice («Сез «Яхшы» дип бастыгыз — …»), «Күнегү · сүз ${k}/3», intro1 line «Хәзер өч сүздә сынап карыйбыз — ярты минут кына.» or the builder's better wording.

- [ ] **Step 1: Write the failing tests** — replace the four-button tests of `describe("the practice card of the introduction")` and `describe("/howto, «Как это работает»")`:
  - `"the practice is three cards: китап, су, әни; each press edits the message once, reads the database once and writes nothing"`: `pr:start` (or `ob:n1`) → «Тренировка · слово 1 из 3», `<b>китап</b>`, `<tg-spoiler><b>книга</b></tg-spoiler>`, buttons `pr:s1:1…4` labelled as a real new card («Снова · 1 минута» …), last row «Пропустить» `ob:n2`; press `pr:s1:3` → the «Хорошо» explanation above «слово 2 из 3» with `су`; `pr:s2:1` → «Снова» explanation + word 3 `әни`; `pr:s3:4` → «Легко» explanation, then `practiceDone`, keyboard `[["Дальше", "ob:n2"]]`; `held()` unchanged throughout.
  - `"each button's explanation names its own interval"`: one press of each rating checks the four exact sentences above.
  - `"a press of an old practice button of the four-button card shows the practice from its first word"`: `pr:0:3`, `pr:15:2` → word 1, no explanation, edited in place.
  - `"a double tap shows the same screen; «message is not modified» is no error"`.
  - `"«Пропустить» on any word goes to the levels"`; `/howto` replay ends with «▶ Учить» on every card and on the final screen.
  - `"in Tatar: the same words, the Russian translations, Tatar texts"`.
  - `"the screen about the bot says the practice is three words"` (intro1 contains the new line, both languages).
  - Keep the tests of the introduction flow (`/start → … → «Дальше» → levels`) and the hints, updated to three presses.
  - `views.test.ts`: the `gradeRows` test no longer passes `tried`.
  - `dict.test.ts`: `SAMPLE_ARGS` — `practiceTitle: [[1], [3]]`, drop `practiceLadder`, `practiceLeft`.
- [ ] **Step 2: Run** `pnpm vitest run test/bot/tutorial.test.ts test/bot/views.test.ts test/i18n test/tutorial` — FAIL.
- [ ] **Step 3: Implement.** `renderPractice`: `explained` as today but by `last` with the new texts (all intervals `"after"`; `RUNGS_AFTER_GOOD` kept); `leave = replay ? learnKeyboard(lang) : [[btn(next === 4 ? t.nextBtn : t.skipBtn, "ob:n2")]]`; `next === 4` → `[explained, "", t.practiceDone]`; otherwise `[explained, ""]` (when any) + `t.practiceTitle(next)`, `t.practiceNote`, `""`, the word and its spoiler, grade rows with `practiceData(next, r)`. In `bot.ts`: `practice(ctx, next, last)`; `pr:start` → `(1, null)`; `/^pr:/` → `parsePress`: null → stale toast; restart → `(1, null)`; press → `(press.word + 1, press.rating)`. Update the comments of both. Delete the old `parse`, `ALL`, `press`, `tried`, `PRACTICE_WORD` and their tests in `test/tutorial/practice.test.ts`; remove `tried` from `gradeRows` and its doc comment.
- [ ] **Step 4: Run** the tests, then all four global checks — PASS.
- [ ] **Step 5: Commit** `feat(tutorial): the practice is three words with one honest press each`.

**Group C release check:** all four global checks green.
