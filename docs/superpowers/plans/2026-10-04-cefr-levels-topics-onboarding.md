# «Кабатла»: CEFR levels, topics, word-order modes, new onboarding — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 20×100 level ladder and the placement test with a catalog on the CEFR scale A1–C1 (level, topic and part of speech on every card), level and part-of-speech checkboxes, three new-word orders, and an onboarding that explains the grade buttons — without losing any learner's progress.

**Architecture:** Catalog notes get `level`, `topic_no`, `seq`, `tseq` and live in one container deck per level. A learner's scope is stored on the user row (`levels` and `pos_groups` bit masks, `new_mode`, `topic_no`); new catalog words are read per checked level through an index, from a stored read position, and merged by the mode's rule. Progress is kept in per-user counters (`user_progress`), so screens and the session end no longer scan the catalog. All rules about levels live in `src/levels`; onboarding screens and hints live in `src/tutorial`.

**Tech Stack:** TypeScript 5 strict, Cloudflare Workers + D1, grammY, ts-fsrs, Vitest + `@cloudflare/vitest-pool-workers` (real D1), dependency-cruiser, pnpm, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-04-cefr-levels-topics-onboarding-design.md` (binding). The older spec `2026-10-03-tatar-srs-bot-design.md` stays binding where the new one does not replace it (new spec §2).

**Existing code map:** `.superpowers/sdd/2026-10-04-cefr-levels/interfaces-digest.md` — exact signatures, file lines, tests and helpers of the code this plan changes. Read the sections named in your task before you start.

## Global Constraints

- Work in the worktree `/home/claude/kabatla-cefr`, branch `cefr`. Never commit to `master`: a push to `master` deploys the bot. `master` is merged only in Task 11.
- Repository `Iskander-ibragimov/kabatla-bot` (private). Worker `kabatla-bot`, D1 `kabatla`.
- Budgets per Telegram update: ≤ 8 D1 calls, ≤ 3 Telegram calls. Tick: ≤ 35 sends, ≤ 10 D1 calls; an idle tick is exactly 2 calls. Checked with `test/helpers/countingDb.ts`.
- D1 rows read, with the full catalog (3 850 notes: 500 / 850 / 850 / 800 / 850), all five levels checked, any learner progress: a grade (including the one that ends the session) ≤ 2 500; `/levels`, «Темы», settings screens ≤ 2 500; reminder ≤ 300 per due user; the first queue read after a settings change or a catalog load ≤ 20 000. Checked with `test/helpers/readingDb.ts`.
- Level scale, exact: A1 = 1 (500), A2 = 2 (850), B1 = 3 (850), B2 = 4 (800), C1 = 5 (850). Slugs `a1 a2 b1 b2 c1`.
- Topics, exact: numbers 0–20 with the slugs and titles of spec §3.2. Topic 0 is `core`.
- Part-of-speech groups, exact bits: 0 `n`; 1 `v`; 2 `adj`; 3 `adv`; 4 `pron`; 5 `num`; 6 `func` = `post, part, conj, intj`; 7 `phr`.
- New-word modes, exact values: `guided` (default), `topic`, `freq`.
- Catalog CSV header, exact: `word,transcription,pos,translation,example_tt,example_ru,example_src,topic,audio_file_id`.
- Defaults of a new learner: levels = A1, all part-of-speech groups, `guided`, no topic, 10 new words a day, reminder 09:00, UTC+3.
- Checkboxes and the mode act on **new catalog words only**. Started cards are always reviewed. Own and AI decks are not filtered and come before catalog words.
- The bot never checks a level by itself.
- No card, review-log row or own note of a learner is deleted or reset by any migration or seed.
- Interface languages `ru` and `tt`. Tatar text uses ә ө ү җ ң һ; `test/i18n/dict.test.ts` must pass for every new key (function keys need `SAMPLE_ARGS`; add `A1|A2|B1|B2|C1` to `LATIN_OK`).
- Layer rules of `.dependency-cruiser.cjs` hold; `src/levels` and `src/tutorial` import neither `src/bot` nor grammy.
- Secrets, chat ids, Telegram `file_id`s and learners' own words never appear in files, logs or reports.
- Network from the workspace: GitHub and npm only. Anything else runs in GitHub Actions.
- Every commit ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01CiDfx5Vzphh1nTYfcQvAx1`
- Run `pnpm typecheck && pnpm depcruise && pnpm test` before every commit that ends a task; the suite is green at the end of every task.

## Decisions beyond the spec

Recorded here because tasks are ambiguous without them. The spec is updated in the same places (Task 10).

1. **Hub.** `/levels` is the hub for catalog settings: it shows levels, mode, current topic, part-of-speech summary and own decks, with buttons «Уровни», «Части речи», «Порядок слов», «Темы». `/settings` gets one row that opens the hub, plus «Часовой пояс» and «Показать обучение заново».
2. **Time zone** is chosen with buttons only: UTC+2 … UTC+12, each labelled with the current local time. No typed input.
3. **Hints are marked as seen by the first grade**, in the grade's own write. The first-card hint therefore shows on every card until the first grade. The grade also marks the update notice.
4. **🔵 counter** = `min(new words left today, candidates)`; when any level stream returned its full limit, candidates are taken as unlimited. Near the very end of the catalog the counter may over-report.
5. **Read position** per level is a pair `{from, to}`: nothing at or before `from`, and nothing after `to` (when known), can be a new word in the current scope. It is stored on the user row together with the scope key and the catalog version, and is ignored when either differs.
6. **Own-word starts are counted** in `user_progress` under the pair (level 0, topic 0), so the counter statement always writes exactly one row.
7. **Transitional fixtures.** Until Task 9 the test helpers keep both representations (old: `decks.level_no`, `user_decks`, `users.level`; new: `notes.level`, `users.levels`), so modules can be switched one task at a time.
8. **Deploy window.** Migrations and the seed run a minute or two before the new worker code. During that window the old code may show «Открываю уровень N» or «Пока учить нечего». No data is lost; accepted.

## Review Focus

Inputs the spec implies and no single task's happy path exercises; each is pinned by a test in the task named.

1. A learner unchecks a level in the middle of it and checks it again a week later → started words kept coming for review meanwhile; new words resume where they stopped (Task 5).
2. A learner switches the direction to «оба» after 300 words → reverse cards come as new words in the mode's order, and a grade still reads ≤ 2 500 rows (Tasks 4, 5).
3. Two taps on the last checked level, or two different taps at once → the set is never empty and equals the last tap (Task 6).
4. A catalog load moves a started word to another level or topic → the learner's card and schedule stay; `/levels` counters are right after the load (Task 3).
5. A learner who was in the middle of the old onboarding, or presses a button of an old screen after the release → lands on the new «Уровни» step or gets «Эта кнопка уже неактуальна» with the current screen; no crash (Tasks 8, 9).

---

### Task 1: Scale and ordering rules (pure)

**Files:**
- Create: `src/levels/scale.ts`, `src/levels/order.ts`
- Test: `test/levels/scale.test.ts`, `test/levels/order.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (`scale.ts`):
  - `type LevelNo = 1 | 2 | 3 | 4 | 5`
  - `LEVELS: readonly { no: LevelNo; code: "A1"|"A2"|"B1"|"B2"|"C1"; slug: "a1"|"a2"|"b1"|"b2"|"c1"; size: number }[]` (sizes 500, 850, 850, 800, 850)
  - `ALL_LEVELS = 31`, `levelCode(no: number): string`, `levelsOf(mask: number): LevelNo[]` (ascending), `hasLevel(mask: number, no: number): boolean`, `levelBit(no: number): number`
  - `type PosGroup = "n"|"v"|"adj"|"adv"|"pron"|"num"|"func"|"phr"`; `POS_GROUPS: readonly { bit: number; key: PosGroup; codes: readonly string[] }[]`; `ALL_POS = 255`
  - `posCodesOf(mask: number): string[] | null` — `null` when every group is checked (no filter)
  - `toggled(mask: number, bit: number): number | null` — the mask with that bit flipped; `null` when the result would be 0
  - `type NewMode = "guided" | "topic" | "freq"`; `NEW_MODES: readonly NewMode[]`
  - `TSEQ_BASE = 1_000_000`; `tseqOf(topicNo: number, seq: number): number`
- Produces (`order.ts`):
  - `interface Ordered { level: number; topicNo: number; seq: number }`
  - `mergeStreams<T extends Ordered>(streams: T[][], mode: NewMode): T[]` — `guided`/`topic`: by `(topicNo, level, seq)`; `freq`: by `(level, seq)`
  - `type EmptyReason = { kind: "pickTopic" } | { kind: "allPos" } | { kind: "addLevel"; level: LevelNo } | { kind: "allDone" }`
  - `interface EmptyFacts { mode: NewMode; levels: number; posGroups: number; totals: Record<number, number>; started: Record<number, number> }` (`totals`, `started`: catalog cards per level 1–5)
  - `emptyReason(f: EmptyFacts): EmptyReason` — spec §5: `topic` mode → `pickTopic`; else `posGroups != ALL_POS` and some checked level has `totals > started` → `allPos`; else the lowest unchecked level with `totals > 0` → `addLevel`; else `allDone`
  - `interface Span { from: number; to: number | null }`; `type Spans = Partial<Record<number, Span>>`
  - `scopeKey(u: { levels: number; posGroups: number; newMode: NewMode; topicNo: number | null; direction: string }): string`
  - `readSpans(raw: string | null, key: string): { version: number; spans: Spans }` — `{version: -1, spans: {}}` for null, broken JSON or another key
  - `CURSOR_STEP = 25`, `STREAM_LIMIT = 3`
  - `nextSpans(prev: Spans, seen: Partial<Record<number, { first: number | null; last: number | null; full: boolean }>>): { spans: Spans; save: boolean }` — per level: `first == null` → `{from: prev.from, to: prev.from}` (nothing left); else `from = first - 1`; `to = full ? null : last`. `save` is true when some level's `from` moved by ≥ `CURSOR_STEP` or its `to` changed
  - `writeSpans(key: string, version: number, spans: Spans): string`

- [ ] **Step 1: Write the failing tests.** `scale.test.ts`: `levelsOf(0b10110)` is `[2, 3, 5]`; `toggled(1, 0)` is `null`; `toggled(3, 0)` is `2`; `posCodesOf(255)` is `null`; `posCodesOf(1 << 6)` is `["post","part","conj","intj"]`; sizes sum to 3 850; `tseqOf(7, 12) === 7_000_012`. `order.test.ts`: `mergeStreams` of level 1 `[(t2,s5),(t3,s1)]` and level 2 `[(t2,s1)]` in `guided` gives `(1,t2,s5), (2,t2,s1), (1,t3,s1)` and in `freq` gives level 1 first; the four `emptyReason` branches, with `addLevel` choosing the lowest unchecked level that has cards; `readSpans(writeSpans("k", 4, {1: {from: 10, to: null}}), "k")` round-trips and another key gives `{}`; `nextSpans` saves at a move of 25, not at 24, and when `to` becomes known.
- [ ] **Step 2: Run** `pnpm test test/levels` — expected: FAIL, modules not found.
- [ ] **Step 3: Implement both modules.** No imports from other `src` folders except types.
- [ ] **Step 4: Run** `pnpm test test/levels && pnpm typecheck && pnpm depcruise` — expected: PASS.
- [ ] **Step 5: Commit** `feat(levels): the CEFR scale, part-of-speech groups and the order of new words`.

### Task 2: Schema — additive migration, types, fixtures

**Files:**
- Create: `migrations/0008_cefr_schema.sql`
- Modify: `src/db/repo.ts` (types `User`, `NoteInput`, `NoteFields` consumers; `insertNotes`), `test/apply-migrations.ts`, `test/helpers/seed.ts`
- Test: `test/db/schema.test.ts`, `test/helpers/seed.test.ts`

**Interfaces:**
- Consumes: Task 1 `tseqOf`, `levelBit`.
- Produces:
  - Columns `notes.level INTEGER`, `notes.topic_no INTEGER`, `notes.seq INTEGER`, `notes.tseq INTEGER` (all NULL for own notes).
  - Indexes `idx_notes_catalog_key` UNIQUE `(word_key) WHERE level IS NOT NULL`; `idx_notes_level_seq (level, seq) WHERE level IS NOT NULL`; `idx_notes_level_tseq (level, tseq) WHERE level IS NOT NULL`.
  - Tables `topics (no INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title_ru TEXT NOT NULL, title_tt TEXT NOT NULL)`; `catalog_groups (level INTEGER NOT NULL, topic_no INTEGER NOT NULL, total INTEGER NOT NULL, PRIMARY KEY (level, topic_no))`; `user_progress (user_id INTEGER NOT NULL, level INTEGER NOT NULL, topic_no INTEGER NOT NULL, started INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, level, topic_no))`; `meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)` with rows `('catalog_version','0')`, `('catalog_hash','')`.
  - Columns `users.levels INTEGER NOT NULL DEFAULT 1`, `users.pos_groups INTEGER NOT NULL DEFAULT 255`, `users.new_mode TEXT NOT NULL DEFAULT 'guided' CHECK (new_mode IN ('guided','topic','freq'))`, `users.topic_no INTEGER`, `users.hints_seen INTEGER NOT NULL DEFAULT 0`, `users.new_cursors TEXT`.
  - `User` fields `levels: number; posGroups: number; newMode: NewMode; topicNo: number | null; hintsSeen: number; newCursors: string | null`.
  - `NoteInput` gains optional `level?: number; topicNo?: number; seq?: number`; `insertNotes` writes them and `tseq = tseqOf(topicNo, seq)` when `level` is given.
  - Test helpers (transitional, decision 7): `seedLevels(db, levels, coverage)` also sets on every note `level = n`, `topicNo = 0`, `seq = index + 1`, and upserts `catalog_groups (n, 0, count)`; new `seedCatalog(db, rows: { level: number; word: string; topic?: number; pos?: string; translation?: string }[]): Promise<number[]>` (creates the level decks with slugs `a1…c1` and `level_no` 1–5 when absent; `seq` in call order per level; keeps `catalog_groups` in step; returns note ids); `seedUser` also sets `users.levels = levelBit(level)` when `level ≤ 5` and accepts `levels?: number`.
  - `test/apply-migrations.ts` also clears `user_progress`, `catalog_groups`, `topics` and resets the two `meta` rows.

- [ ] **Step 1: Write the failing tests.** `schema.test.ts`: a new user row has `levels = 1`, `pos_groups = 255`, `new_mode = 'guided'`, `topic_no IS NULL`, `hints_seen = 0`; `new_mode = 'x'` is rejected; two catalog notes (level set) with the same `word_key` in different decks are rejected, two own notes with the same key in different decks are accepted; `meta` holds `catalog_version = '0'`. `seed.test.ts`: `seedCatalog` with three A1 rows and one A2 row gives `seq` 1, 2, 3 and 1, `tseq = topic * 1_000_000 + seq`, `catalog_groups` totals per pair; `seedUser({ level: 2 })` gives `levels = 2`.
- [ ] **Step 2: Run** `pnpm test test/db/schema.test.ts test/helpers/seed.test.ts` — expected: FAIL (no such column).
- [ ] **Step 3: Write `0008_cefr_schema.sql`** with exactly the objects above. No data is moved in this migration.
- [ ] **Step 4: Extend the types, `insertNotes` and the helpers.** If an existing fixture puts the same word into two catalog levels, give the words distinct spellings in that fixture; do not weaken the unique index.
- [ ] **Step 5: Run** `pnpm typecheck && pnpm test` — expected: the whole suite passes.
- [ ] **Step 6: Commit** `feat(db): columns and tables for CEFR levels, topics, progress counters`.

### Task 3: Catalog files tooling — check, seed SQL, scripts

**Files:**
- Create: `scripts/lib/catalog.ts`, `scripts/validate-catalog.ts`
- Modify: `src/content/csv.ts` (replace `csvToSql`/`SeedDeck` by `catalogToSql`), `scripts/csv-to-sql.ts`, `scripts/lib/files.ts`, `package.json` (script `validate:catalog`)
- Test: `test/scripts/catalog.test.ts`, `test/seed.test.ts` (rewritten)
- Read first: digest §8, §12 (`seedSql.ts`), spec §3.5, §10.

**Interfaces:**
- Consumes: Task 1 scale; Task 2 schema.
- Produces (`scripts/lib/catalog.ts`):
  - `CATALOG_HEADER` (Global Constraints), `TOPICS_HEADER = ["no","slug","title_ru","title_tt"]`
  - `interface Topic { no: number; slug: string; titleRu: string; titleTt: string }`; `parseTopics(text: string): Topic[]`
  - `interface CatalogLevel { level: number; rows: Record<string,string>[]; header: string[] }`
  - `interface CatalogCheck { topics: Topic[]; attested: Set<string>; meta: { level: number; coveragePct: number }[] }`
  - `checkCatalog(levels: CatalogLevel[], o: CatalogCheck): string[]` — one message per violation, prefixed `a1:<line> `. Rules: header exact; topics are numbers 0–20 with unique slugs; word, transcription, translation, `example_tt`, `example_ru` not empty on every row, phrases included; `pos` in the eleven codes; `topic` is a known slug; Tatar letters only in `word`, `example_tt`, and in `transcription` with the extra signs; `example_src` matches `^(own|tatoeba:\d+)$`; one Tatoeba id is used once in the whole catalog; a word key is unique in the whole catalog; every token of `example_tt` is attested; for rows other than `phr` the example holds a form of the word (`wordForm`); a level has no more rows than its size; `meta` has an entry for every level file and coverage never falls.
- Produces (`src/content/csv.ts`):
  - `interface SeedLevel { level: number; slug: string; titleRu: string; titleTt: string; coveragePct: number | null; rows: Record<string,string>[] }`
  - `interface SeedTopic { no: number; slug: string; titleRu: string; titleTt: string }`
  - `catalogToSql(levels: SeedLevel[], topics: SeedTopic[], renames: Rename[], hash: string): string` — one statement per line, in this order: topics upsert (written only when a field differs); level decks by slug (`kind = 'catalog'`, `level_no = level`, title, coverage); renames, catalog-wide by `word_key`; per row an `UPDATE notes … WHERE level IS NOT NULL AND word_key = ? AND (<a field, level, deck, topic_no, seq or tseq differs>)`, then an `INSERT … WHERE NOT EXISTS (catalog note with that key)`; deck totals; `catalog_groups` recount (upsert when differs, delete pairs without notes); `user_progress` recount for every user (pair `(COALESCE(level,0), COALESCE(topic_no,0))`, count of distinct notes with a card not in state `new`; upsert when differs, delete rows without such notes); `UPDATE meta SET value = value + 1 WHERE key = 'catalog_version' AND (SELECT value FROM meta WHERE key = 'catalog_hash') IS NOT '<hash>'`, then store the hash.
  - `seq` = 1-based row number in the level file; `topic_no` from the slug.
  - Never written: cards, review_log, users, own notes, `audio_tries`; `audio_file_id` only fills an empty value; a note absent from the files stays.
- Produces (scripts): `scripts/lib/files.ts` — `CATALOG_DIR = "data/catalog"`, `readCatalog(): CatalogLevel[]`, `readTopics(): Topic[]`, `readCatalogMeta()`, `catalogHash(): string` (sha256 of the catalog and topics files); `scripts/validate-catalog.ts` prints `уровней: N, карточек: M, нарушений нет` or the violations and exits 1; with no catalog files prints `каталога нет` and exits 0; `scripts/csv-to-sql.ts` writes `seed/catalog.sql` from `data/catalog`, level titles `A1…C1`.
  - `data/renames.csv` keeps its header; `level` is 1–5.

- [ ] **Step 1: Write the failing tests.** `catalog.test.ts`, in-memory fixtures: a valid two-level catalog has no violations; each rule above has one test that breaks only that rule and expects exactly one message naming the file and line (phrase without example → `a1:3 нет примера`; same Tatoeba id in A1 and A2; same word in A1 and B1; 501 rows in A1; unknown topic slug). `seed.test.ts` against D1 through `applySeed`: a first load creates decks `a1`, `a2` with `level_no` 1, 2 and notes with `level`, `topic_no`, `seq`, `tseq`; a second identical load writes 0 rows and leaves `catalog_version` unchanged; changing a translation writes that note only and bumps the version; **moving a word from A1 to A2 keeps the note id, a card and its schedule, and moves `user_progress` from pair (1, t) to (2, t)**; changing a topic moves `catalog_groups` totals; a stored `audio_file_id` survives an empty CSV value; a note missing from the files is kept; a rename keeps the note id and clears its audio.
- [ ] **Step 2: Run** `pnpm test test/scripts/catalog.test.ts test/seed.test.ts` — expected: FAIL.
- [ ] **Step 3: Implement `scripts/lib/catalog.ts`**, reusing `tokenize`, `isAttested`, `wordForm`, `coverageDrops` and the letter checks of `scripts/lib/levels.ts` by import.
- [ ] **Step 4: Implement `catalogToSql`** and delete `csvToSql`, `SeedDeck`. Keep `parseCsv`, `toCsv`, `Rename`.
- [ ] **Step 5: Rewrite `scripts/csv-to-sql.ts`, extend `scripts/lib/files.ts`, add `scripts/validate-catalog.ts` and the package script.** `scripts/validate-levels.ts` and `data/levels` stay until Task 10.
- [ ] **Step 6: Run** `pnpm typecheck && pnpm test` — expected: PASS. `npx tsx scripts/validate-catalog.ts` prints `каталога нет`.
- [ ] **Step 7: Commit** `feat(scripts): catalog files by CEFR level — check and seed`.

### Task 3b: Catalog content — the 400 cards as A1 (content task, may run beside Tasks 4–6)

**Files:**
- Create: `data/topics.csv`, `data/catalog/a1.csv`, `data/catalog/meta.json`
- Modify: `data/attested.txt`
- Work data (git-ignored): copy `/home/claude/kabatla-t12/data/work` to `data/work` of the worktree (corpus word forms, 45 079 Tatoeba pairs, lemma list).

**Interfaces:**
- Consumes: Task 3 `validate-catalog`.
- Produces: `data/catalog/a1.csv` — the 400 rows of `data/levels/l01.csv … l04.csv` in that order, unchanged in the eight old columns except `example_*` of phrases, plus `topic`; `data/topics.csv` — the 21 rows of spec §3.2; `data/catalog/meta.json` — `[{"level":1,"coveragePct":45}]`.

- [ ] **Step 1: Build `a1.csv`** by concatenating the four level files and adding the `topic` column.
- [ ] **Step 2: Assign a topic to each of the 400 rows** by the rule of spec §3.2 («Как слову назначается тема»). The KFU word lists by topic are in the private branch `kfu-specs` (`git show origin/kfu-specs:s_A1.txt`, section 7); use them as the first signal.
- [ ] **Step 3: Give each of the 63 phrases one example** (spec §3.4): a Tatoeba sentence that contains the phrase when there is one (unchanged, with its id; an id not used elsewhere in the catalog), otherwise a one-line exchange written by the author, `example_src = own`. Every Tatar token must be an attested corpus form; add the forms the new examples use to `data/attested.txt` only when they are found in the corpus word forms.
- [ ] **Step 4: Independent second pass** (a separate agent that has not seen the author's work, given only the files): topic of every row against the rule; every new example for meaning, naturalness, level of its words, translation. Corrections are applied by the author; disagreements are listed for the controller.
- [ ] **Step 5: Run** `npx tsx scripts/validate-catalog.ts` — expected: `уровней: 1, карточек: 400, нарушений нет`. Report the topic histogram and how many phrase examples came from Tatoeba and how many are `own`.
- [ ] **Step 6: Commit** `feat(data): the 400 cards as A1 with topics; examples for the 63 phrases`.

### Task 4: Repo — the new queue and the progress counters

**Files:**
- Modify: `src/db/repo.ts`
- Test: `test/db/queue.test.ts`, `test/db/progress.test.ts`, `test/budget/queue-rows.test.ts`
- Read first: digest §1 (all of it), the comment block `repo.ts:133-153`.

**Interfaces:**
- Consumes: Task 1 (`Span`, `Spans`, `STREAM_LIMIT`, `NewMode`), Task 2 schema.
- Produces (new methods beside the old ones; nothing is removed in this task):
  - `interface NewScope { levels: number[]; posCodes: string[] | null; mode: NewMode; topicNo: number | null; spans: Spans; spansVersion: number }`
  - `interface CatalogNew extends NewNote { level: number; topicNo: number; seq: number }`
  - `interface Queue { learning: CardRow[]; review: CardRow[]; ownNew: NewNote[]; newRows: NewNote[]; streams: Partial<Record<number, CatalogNew[]>>; seen: Partial<Record<number, { first: number | null; last: number | null; full: boolean }>>; counts: { learning: number; review: number; newDoneToday: number; easyNewToday: number }; catalogVersion: number; hasCards: boolean }`
  - `queue(userId: number, w: DayWindow, s: NewScope): Promise<Queue>` — **one D1 call** (one batch):
    - `learning`, `review`: as in `candidateCards`, but every card of the user in the asked directions, without the deck filter;
    - `ownNew`: the present `todo → work → fresh` query restricted to decks with an owner;
    - `newRows`: cards of catalog notes in state `new`, asked direction, word not buried today, not an owned copy, read through `idx_cards_user_new` in note-id order, `LIMIT 20`;
    - `streams[level]`: for each scope level the first `STREAM_LIMIT` notes, in `tseq` order (`guided`, `topic`) or `seq` order (`freq`), read through the matching index, with order value `> from` and `≤ to` when `to` is known (the span is used only when `meta.catalog_version = spansVersion`, else the whole level), `topic` restriction when `topicNo != null` (`tseq` in that topic's range), `pos IN posCodes` when given, not an owned copy, word not buried today, and lacking a card row in an asked direction; one `CatalogNew` per lacking direction, in the order of `w.directions`;
    - `seen[level]`: `first`/`last` order value of that level's stream notes, `full` = the stream returned `STREAM_LIMIT` notes;
    - invariant to keep: a level must never look exhausted (`full = false`) because of words that are only hidden for today; a note that lacks a card in an asked direction is not buried (the grade that buries a word creates its other card), so the stream does not need the buried filter — state this in a comment and pin it with a test;
    - `counts`, `catalogVersion`, `hasCards` (the user has any card).
  - `progressStmt(userId: number, noteId: number, cardId: number, wasNew: boolean): D1PreparedStatement` — guarded by `changes() = 1`; upserts `user_progress (userId, COALESCE(level,0), COALESCE(topic_no,0))` adding 1 when `wasNew` and the note has no other card outside state `new`, else adding 0; it always changes exactly one row when the guard passes.
  - `unprogressStmt(userId: number, cardId: number): D1PreparedStatement` — subtracts 1 (not below 0) for the card's note pair when the note has no card outside state `new`; run after the card is restored.
  - `progress(userId: number): Promise<{ level: number; topicNo: number; started: number }[]>`
  - `catalogTotals(): Promise<{ level: number; topicNo: number; total: number }[]>`
  - `todayLog(userId: number, dayStartMs: number): Promise<{ reviewsToday: number; learnedToday: number }>` — reads today's `review_log` rows only.

- [ ] **Step 1: Write the failing tests.** `queue.test.ts` (fixtures by `seedCatalog`): `freq`, levels 1 and 2 → streams hold the first three notes of each level in `seq` order; `guided` → in `tseq` order; `topic` with `topicNo = 5` → only topic 5; `posCodes = ["num"]` → only numerals, later in the level; a note with a started `tt_ru` card is skipped for a `tt_ru` learner and is a candidate (direction `ru_tt`) for a «оба» learner; an owned copy is skipped; a word buried today is skipped; span `{from: 40, to: null}` starts after 40; span `{from: 40, to: 55}` stops at 55; a span stored for another `catalog_version` is ignored; `newRows` returns the reverse card of a word graded yesterday for any scope; `learning`/`review` include a card of an unchecked level; `ownNew` returns own-deck words as `candidateCards` did; the whole read is one D1 call (`countingDb`). `progress.test.ts`: first grade of a catalog word adds 1 to its pair; grading its reverse card adds 0; a first grade of an own word adds 1 to (0, 0); the statement after a failed guard writes nothing; `unprogressStmt` after an undone first grade subtracts 1, and subtracts 0 when the other direction is started. `queue-rows.test.ts` (full catalog 3 850, all five levels, `readingDb`): `queue` reads ≤ 1 500 rows for a learner at the start, in the middle (1 900 started) and at the end (all but 2 started) once the spans are stored, in each mode, with all parts of speech and with `["num"]` only, for `tt_ru` and for «оба»; the first read with empty spans reads ≤ 20 000.
- [ ] **Step 2: Run** `pnpm test test/db/queue.test.ts test/db/progress.test.ts test/budget/queue-rows.test.ts` — expected: FAIL (`repo.queue` is not a function).
- [ ] **Step 3: Implement** the methods. Reuse the private SQL pieces (`noteCols`, `ownedCopy`, `wordNotBuried`, `lacksCard`, `NEW_CARDS`, `askedDirection`).
- [ ] **Step 4: Run** the three test files, then `pnpm typecheck && pnpm test` — expected: PASS.
- [ ] **Step 5: Commit** `feat(db): a queue of new catalog words by level, mode and part of speech; progress counters`.

### Task 5: Review service on the new queue

**Files:**
- Modify: `src/review/service.ts`, `src/review/pick.ts` (types only if needed), `src/db/repo.ts` (remove `candidateCards`, `summary` use in the session, the level-opening statements' callers), `src/users/service.ts` (transitional: onboarding finish also writes `levels`), `src/bot/bot.ts` and `src/bot/views.ts` (only what the changed `Screen` forces), `test/helpers/sim.ts`, `test/helpers/seed.ts`
- Test: `test/review/scope.test.ts` (replaces `test/review/levels.test.ts`), `test/review/both.test.ts`, `test/review/service.test.ts`, `test/budget/rows.test.ts`, and the tests elsewhere that assert the automatic level-up
- Read first: digest §2, §12; spec §4, §5, §9.3.

**Interfaces:**
- Consumes: Task 1 (`mergeStreams`, `emptyReason`, `scopeKey`, `readSpans`, `nextSpans`, `writeSpans`, `posCodesOf`, `levelsOf`), Task 4.
- Produces:
  - `Screen` loses `levelUp`; the `done` screen gains `empty: EmptyReason | null`; `DaySummary` becomes `{ reviewsToday: number; learnedToday: number; nextLearningInMs: number | null; streak: number }` (no `totals`).
  - `ReviewService.nextScreen(user, feedback?)`: builds the scope from the user row; one `repo.queue` call; new notes for `pick` are `ownNew`, then `newRows`, then `mergeStreams(streams, mode)`; counter `n` by decision 4. When `nextSpans(...).save`, writes `users.new_cursors` (one extra D1 call, only then). `guided` with a chosen topic and no stream note → clears `users.topic_no` and reads again (at most once). When nothing is picked: `nothing` if the user has no cards and no feedback; else `done` with `todayLog` and, when new words are still allowed today, `empty = emptyReason(...)` from `progress` and `catalogTotals`.
  - `grade`: the batch gains `progressStmt` after the usage statement and before the sibling statement. `undo`: the batch gains `unprogressStmt` after the card is restored.
  - No level is opened by the service; `LevelUp`, `openLevelStmts`, `openCurrentLevelStmt` have no callers left.
  - Transitional (removed in Task 8): the old onboarding's last step also writes `levels = levelBit(min(level, 5))`.
  - `test/helpers/sim.ts` `allNewCards` is rewritten as the reference for the new order (own decks; then by the mode's rule over checked levels and parts of speech).
  - `test/budget/rows.test.ts`: `fullCatalog` = 3 850 notes in five levels (topics spread over 0–20), budgets from Global Constraints, the matrix of spec §9.3, plus a grade that ends the session.

- [ ] **Step 1: Write the failing tests.** `scope.test.ts`: (a) levels A2+B1 checked → new words only from them, A2 first in `freq`; (b) in `guided` topic 1 of A2 comes before topic 2 of A2, and topic 1 of B1 before topic 2 of A2; (c) `topic` mode gives only the chosen topic and ends with `empty = {kind:"pickTopic"}`; (d) `guided` with a chosen topic gives that topic first, then clears `topic_no` and continues from the first unfinished topic; (e) **Review Focus 1**: uncheck A1 after 10 words → the 10 keep coming for review, no new A1 word; check it again → the 11th word is next; (f) `pos_groups` = numerals only → only numerals; when none is left and other words remain → `empty = {kind:"allPos"}`; (g) all checked levels exhausted, A2 has cards → `{kind:"addLevel", level: 2}`; nothing anywhere → `{kind:"allDone"}`; (h) own-deck words come before catalog words and ignore the checkboxes; (i) the daily limit and the «Легко» rule hold as before; (j) a grade is ≤ 8 D1 calls; a grade that stores the read position is one call more than a plain one; (k) after 30 new words `users.new_cursors` holds `from ≥ 25` for that level. `both.test.ts`: the simulations compare with the rewritten `allNewCards`; **Review Focus 2**: switch to «оба» after 300 words → the reverse cards of started words come in the mode's order. `service.test.ts`: a first grade adds to `user_progress`, undo takes it back. `rows.test.ts`: every case ≤ 2 500 rows; the first grade after a mode change ≤ 20 000.
- [ ] **Step 2: Run** `pnpm test test/review test/budget` — expected: FAIL.
- [ ] **Step 3: Rewrite `nextScreen`, extend `grade` and `undo`,** remove `candidateCards` and its private SQL that nothing uses any more. Keep `levelsOverview`, `startLevel`, `openSkippedLevels`, `summary`, `statsExtra` — other modules still call them until Tasks 6–9.
- [ ] **Step 4: Adapt the callers** (`show()` in `bot.ts` no longer builds a level-up lead; `renderDone` drops the totals line; remove `renderLevelUp`) and every test that asserted an automatic level-up or the totals line (digest §12: `bot/handlers` 262 and 337, `bot/levels` level-up cases, `bot/views` 96, 314, 356, 440, `e2e` 52 and 117–118).
- [ ] **Step 5: Run** `pnpm typecheck && pnpm depcruise && pnpm test` — expected: PASS.
- [ ] **Step 6: Commit** `feat(review): new words by checked levels, parts of speech and mode; no automatic level change`.

### Task 6: Levels service, statistics, reminders

**Files:**
- Create: `src/levels/service.ts`
- Modify: `src/stats/service.ts`, `src/reminders/service.ts`, `src/db/repo.ts`
- Test: `test/levels/service.test.ts`, `test/stats/service.test.ts`, `test/reminders/service.test.ts`, `test/budget/rows.test.ts` (levels screen and reminder rows)
- Read first: digest §4, §5; spec §4, §6.

**Interfaces:**
- Consumes: Tasks 1, 2, 4.
- Produces (`src/levels/service.ts`):
  - `interface LevelLine { no: LevelNo; code: string; checked: boolean; total: number; size: number; started: number; coveragePct: number | null }`
  - `interface TopicLine { no: number; titleRu: string; titleTt: string; started: number; total: number }` (totals and starts over the checked levels)
  - `interface Hub { levels: LevelLine[]; mode: NewMode; posGroups: number; topic: TopicLine | null; own: Pick<DeckRow, "kind"|"titleRu"|"titleTt"|"total">[] }` — `topic`: the chosen one; in `guided` without a choice, the first topic by number with `started < total`; in `freq`, null
  - `hub(repo: Repo, user: User): Promise<Hub>` — ≤ 2 D1 calls
  - `topicLines(repo: Repo, user: User): Promise<TopicLine[]>` — topics with `total > 0` in the checked levels, by number
  - `toggleLevel(repo, user, no: number): Promise<"ok" | "last" | "soon">` — one UPDATE; `soon` when the level has no cards; `last` when it is the only checked one; when the chosen topic has no cards in the new set, the same statement clears `topic_no`
  - `togglePos(repo, user, bit: number): Promise<"ok" | "last">` — one UPDATE
  - `setMode(repo, user, mode: NewMode): Promise<void>`; `setTopic(repo, user, topicNo: number | null): Promise<"ok" | "empty">`
  - `addAllPos(repo, user): Promise<void>`
- Produces (repo): `levelDecks(): Promise<{ level: number; total: number; coveragePct: number | null }[]>`; `topicsList(): Promise<{ no: number; slug: string; titleRu: string; titleTt: string }[]>`; `stageCounts(userId, direction): Promise<{ learned: number; known: number; learning: number }>` (over the user's cards only).
- Produces (stats): `Cumulative` — `level` is replaced by `levels: number[]`; `fresh` = cards of checked levels not started (from the counters, never below 0); `coveragePct` = coverage of the highest level L such that every level ≤ L is fully started, else null. `levelsView`, `LevelsView` are removed.
- Produces (reminders): `new_n = MIN(left today, new rows of the user (≤ 20) + own-deck unshown words + MAX(0, cards of checked levels − started in checked levels))`; `NEXT_LEVEL_WORDS` and the catalog branch of `NEW_IN_OPEN_DECKS` are removed.

- [ ] **Step 1: Write the failing tests.** `levels/service.test.ts`: `hub` for a learner with A1 checked and 12 of 40 started in topic 2 gives that `LevelLine` and `TopicLine`; an empty level is `total = 0`; **Review Focus 3**: `toggleLevel` on the only checked level returns `last` and writes nothing; two concurrent toggles of different levels both apply; toggling an empty level returns `soon`; unchecking the level that held the chosen topic clears `topic_no`; `togglePos` on the last group returns `last`; `setTopic` with a topic that has no cards in the checked levels returns `empty`; `hub` is ≤ 2 D1 calls. `stats`: `levels`, `fresh` and `coveragePct` by the rules above. `reminders`: a learner with A1 checked, 10 of 400 started and nothing due gets a push that counts `min(newPerDay, 390)`; unchecking every level with unstarted cards and having nothing due → no push; an idle tick is still 2 D1 calls. `rows`: `/levels` ≤ 2 500 and reminder ≤ 300 per due user on the full catalog.
- [ ] **Step 2: Run** the four test files — expected: FAIL.
- [ ] **Step 3: Implement.** Remove `levelsOverview`, `openSkippedLevels`, `LevelRow`, the exported SQL builders that only the old reminder used.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm depcruise && pnpm test` — expected: PASS (the old `/levels` handler is adapted to render from `hub` with the present text keys until Task 7 replaces the screen).
- [ ] **Step 5: Commit** `feat(levels): the settings service; statistics and reminders by the learner's scope`.

### Task 7: Bot screens — hub, checkboxes, mode, topics, settings, end-of-session buttons

**Files:**
- Modify: `src/bot/bot.ts`, `src/bot/screens.ts`, `src/bot/views.ts`, `src/i18n/ru.ts`, `src/i18n/tt.ts`, `src/users/service.ts` (`SettingKey` gains `tzOffsetMin`), `scripts/set-webhook.ts` (command descriptions, `botAbout`)
- Test: `test/bot/levels.test.ts` (rewritten), `test/bot/settings.test.ts`, `test/bot/views.test.ts`, `test/i18n/dict.test.ts`
- Read first: digest §6, §7; spec §4–§6, §10; decisions 1, 2.

**Interfaces:**
- Consumes: Task 6 service; Task 5 `EmptyReason`.
- Produces — callbacks (exact data strings):
  - `levels` → sends the hub; `hub` → edits the message into the hub
  - `hub:lv` → levels checkboxes; `lv:t:<1-5>` toggles and re-renders; `hub:pos` → part-of-speech checkboxes; `ps:t:<0-7>`; `hub:mode` → three options; `md:<guided|topic|freq>`; `hub:tp` → topics; `tp:<no>`; `tp:none`. Every sub-screen has «Готово» = `hub`.
  - `set:hub` (settings row → hub), `set:tz` → time-zone buttons `tz:<minutes>` for 120…720 step 60, `set:tut` (Task 8).
  - End of session: `fix:topic` → topics screen; `fix:pos` → `addAllPos` then the next card; `fix:lv:<n>` → `toggleLevel` then the next card.
  - `lv:skip` and any other callback of a removed screen → toast `staleButton`.
- Produces — renderers: `renderHub(h: Hub, lang): Rendered`, `renderLevelChecks(lines: LevelLine[], lang): Rendered`, `renderPosChecks(mask: number, lang): Rendered`, `renderModes(mode: NewMode, lang): Rendered`, `renderTopics(lines: TopicLine[], chosen: number | null, lang): Rendered`, `renderTimeZones(now: number, current: number, lang): Rendered`; `renderDone(s: DaySummary, lang, empty: EmptyReason | null): Rendered`; `renderSettings` with the rows of decision 1 and `setMode` renamed in text to «🎯 Нагрузка».
- Produces — texts (ru; Tatar by the same meaning):
  - hub level line: `☑ A1 · 137 из 400 (будет 500) · ≈45 % текста`; a full level omits «(будет N)»; an empty one: `☐ A2 · скоро`
  - hub mode line: `🧭 Бот ведёт по темам · сейчас «Семья и близкие»: 12 из 40` / `🧭 Сам выбираю тему · «Еда»: 3 из 20` / `🧭 Сам выбираю тему · тема не выбрана` / `🧭 По частоте`
  - hub part-of-speech line, only when not all are checked: `🧩 Части речи: существительные, глаголы`
  - checkbox toasts: «Нужен хотя бы один уровень», «В этом уровне пока нет слов», «Нужна хотя бы одна часть речи»
  - mode options: «Бот ведёт по темам — темы идут по порядку, можно перескочить», «Сам выбираю тему — слова только из выбранной темы», «По частоте — от самых нужных к редким, вперемешку»
  - end of session: «Новых слов по вашим настройкам нет: тема закончилась.» + «Выбрать тему»; «…: в отмеченных частях речи слова кончились.» + «Включить все части речи»; «…: отмеченные уровни пройдены.» + «Добавить уровень A2»; «Все слова каталога в работе 🎉» (no button)
  - `/stats` first line: `🎓 Уровни: A1, A2[ · покрытие текста ≈P%]`
  - `/help`: no hundreds; the sources line gains «темы — по спецификациям уровней проекта „Мин татарча беләм!“ (КФУ)»
  - `botAbout`: «…слова по уровням A1–C1 и темам…» in place of «2 000 самых частых слов в 20 уровнях»
- Removed keys: `levelUp`, `levelsDone`, `levelsPassed`, `levelsSkipped`, `levelProgress`, `levelsAhead`, `openSkippedBtn`, `doneTotals`, `levelTitle` (the seed script uses `levelCode`).

- [ ] **Step 1: Write the failing tests.** `bot/levels.test.ts`: `/levels` shows the hub text above for a seeded learner; `hub:lv` then `lv:t:2` on a level with cards checks it and the message is edited, not re-sent; `lv:t:1` on the only level answers the toast and changes nothing; `lv:t:3` on an empty level answers «В этом уровне пока нет слов»; `md:freq` changes the hub line; `tp:8` then the next `/learn` card is from topic 8; `tp:none`; each update ≤ 8 D1 and ≤ 3 Telegram calls. `bot/settings.test.ts`: `set:tz` then `tz:300` stores 300 and moves `next_daily_at`; `set:hub` shows the hub. End of session: each of the four `EmptyReason` kinds renders its line and button; `fix:lv:2` checks A2 and shows a card from it; `fix:pos` sets all groups; `lv:skip` answers `staleButton`. `dict.test.ts`: updated for the removed and new keys, `LATIN_OK` extended.
- [ ] **Step 2: Run** `pnpm test test/bot test/i18n` — expected: FAIL.
- [ ] **Step 3: Implement** handlers, renderers and texts.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm depcruise && pnpm test` — expected: PASS.
- [ ] **Step 5: Commit** `feat(bot): levels hub, checkboxes, word order, topics, time zone`.

### Task 8: Onboarding without the test, hints, replay, update notice

**Files:**
- Create: `src/tutorial/hints.ts`
- Modify: `src/users/service.ts`, `src/review/service.ts`, `src/bot/bot.ts`, `src/bot/screens.ts`, `src/bot/views.ts`, `src/i18n/ru.ts`, `src/i18n/tt.ts`, `src/db/repo.ts` (`finishOnboardingStmts`)
- Delete: `src/users/placement.ts`
- Test: `test/tutorial/hints.test.ts`, `test/users/service.test.ts`, `test/bot/handlers.test.ts`, `test/e2e/scenario.test.ts`, `test/i18n/dict.test.ts`
- Read first: digest §3, §6.1 (`answerOb`), §11 item on `onboarding_step`; spec §7, §8.

**Interfaces:**
- Consumes: Tasks 5–7.
- Produces (`src/tutorial/hints.ts`):
  - `HINT = { front: 1, again: 2, hard: 4, good: 8, easy: 16, order: 32, update: 64 } as const`; `ALL_HINTS = 63` (without `update`)
  - `type Lead = { kind: "front" } | { kind: "update" } | { kind: "button"; rating: Rating; interval: string; withOrder: boolean }`
  - `afterGrade(seen: number, rating: Rating, interval: string): { lead: Lead | null; seen: number }` — a button lead when that button's bit is clear (with `withOrder` when `order` is clear); the returned `seen` has `front`, `update`, the button bit and, when shown, `order` set
  - `onCard(seen: number): Lead | null` — `front` when its bit is clear, else `update` when its bit is clear, else null
- Produces (onboarding): steps `lang → intro1 → intro2 → levels → NULL`; `OnboardingScreen = { kind: "lang" } | { kind: "intro"; n: 1 | 2 } | { kind: "levels"; lines: LevelLine[] } | { kind: "finished" } | { kind: "invalid"; step: string } | { kind: "stale" }`; answers: `ru`/`tt`; `next`; `lv:<n>` (toggles a level while on the step; the same rules as `toggleLevel`); `go` (finishes: guarded on `onboarding_step = 'levels'`, sets `onboarding_step = NULL`, `hints_seen = HINT.update`, `next_daily_at`, `next_evening_at` from the defaults). After `go` the bot shows the first card. Free text during onboarding answers `chooseAbove`.
- Produces (review): `Screen` of kind `card` and `done` gains `lead: Lead | null`. `grade` computes `afterGrade(user.hintsSeen, rating, formatInterval(after.due − now, lang))`, writes `hintsSeen` in the guarded user statement, mirrors it in the in-memory user, and passes the lead to the next screen. `nextScreen` without a grade uses `onCard`. A button lead wins over `front` and `update`.
- Produces (bot): `renderLead(l: Lead, lang): string`; the lead is the first lines of the card (through `renderCard`'s `lead`) or of the done screen. `set:tut` → intro 1 (`tut:2` → intro 2 with «Понятно» = `tut:ok` → settings), and sets `hints_seen = hints_seen & HINT.update`.
- Texts (ru, exact; Tatar by the same meaning): the two intro screens and the levels step of spec §7.1; the six hint lines of spec §7.2 with `{интервал}` = the interval; update notice «Бот обновился: уровни A1–C1, темы и порядок слов — в /levels».
- Removed: `PLACEMENT`, `placementLevel`, `startLevel`, steps `placement`, `goal`, `remind`, `tz`, keys `placementQ`, `knowBtn`, `dontKnowBtn`, `goalQ`, `goalBtn`, `remindQ`, `tzQ`, `finished`, `easyHint`; the transitional write of Task 5.

- [ ] **Step 1: Write the failing tests.** `hints.test.ts`: `afterGrade(0, 3, "10 мин")` → button lead for 3 with `withOrder: true`, `seen = 1 | 8 | 32 | 64`; the second «Хорошо» gives no lead; `afterGrade(HINT.good | HINT.order, 1, "1 мин")` → lead for 1 without the order line; `onCard(0)` is `front`; `onCard(ALL_HINTS)` is `update`; `onCard(127)` is null. `users/service.test.ts`: the step sequence; `lv:1` on the only checked level is invalid and writes nothing; `go` twice at once finishes once (`stale` for the other); defaults stored. `handlers`/`e2e`: `/start` → `ob:ru` → `ob:next` → `ob:next` → `ob:lv:…`/`ob:go` → the first card carries the `front` lead; grade «Хорошо» → the next card starts with the «Хорошо» line holding the real interval and the order line; grade «Хорошо» again → no lead; each update ≤ 8 D1 and ≤ 3 Telegram calls; a learner seeded with `hints_seen = 63` sees the update notice once and not after a grade; `set:tut` shows the two screens and the hints come again; an old `ob:1` press during the new onboarding → `chooseAbove`, after it → `staleButton`.
- [ ] **Step 2: Run** `pnpm test test/tutorial test/users test/bot test/e2e` — expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm typecheck && pnpm depcruise && pnpm test` — expected: PASS.
- [ ] **Step 5: Commit** `feat(tutorial): onboarding with intro screens and a level choice; grade hints; replay`.

### Task 9: Data migration and removal of the old model

**Files:**
- Create: `migrations/0009_cefr_data.sql`
- Modify: `src/db/repo.ts`, `src/content/service.ts`, `src/users/service.ts`, `src/stats/service.ts`, `test/helpers/seed.ts`, `test/helpers/sim.ts`, tests that still use `level_no` above 5, `users.level` or catalog `user_decks`
- Test: `test/db/migration-0009.test.ts`, `test/db/repo.test.ts`, `test/content/service.test.ts`
- Read first: digest §11, §12; spec §8, §10; decision 8.

**Interfaces:**
- Consumes: everything above.
- Produces — `0009_cefr_data.sql`, in this order, every statement safe to run on an empty or already migrated database:
  1. catalog notes of decks with `level_no` 1…20 get `level = 1`, `topic_no = 0`, `seq = level_no * 100000 + id`, `tseq = seq`, when `level IS NULL`;
  2. the notes of the old decks `l02…` move to the deck `l01` (`deck_id`); that deck becomes slug `a1`, `level_no = 1`, title `A1`; its `total` is recounted; `coverage_pct` = the largest coverage of the merged decks;
  3. the emptied catalog decks and every `user_decks` row of a catalog deck are deleted;
  4. `users`: `levels = 1`, `pos_groups = 255`, `new_mode = 'guided'`, `topic_no = NULL`, `new_cursors = NULL` for everyone; `hints_seen = 63` where `onboarding_step IS NULL`; `onboarding_step = 'levels'`, `onboarding_data = NULL` where the step is `placement`, `goal`, `remind` or `tz`;
  5. `catalog_groups` and `user_progress` are filled by the recount of Task 3.
- Produces — code: no reader of `users.level`, `LAST_LEVEL`, `decks.level_no` above 5 or catalog `user_decks` remains; `levelSlug` is removed (slugs come from `LEVELS`); `findCatalogNotes` selects by `n.level IS NOT NULL` and returns `level`; `findNotesForUser` and `visibleNote` treat a catalog note as the learner's when the learner has a card for it; `summary`, `statsExtra`'s coverage sub-select and the remaining level statements are removed; the test helpers drop the transitional representation (decision 7): `seedLevels` is removed in favour of `seedCatalog`, `seedUser({ levels })`.

- [ ] **Step 1: Write the failing test.** `migration-0009.test.ts` builds the old shape by hand (decks `l01…l04` with `level_no` 1–4 and 3 notes each, interleaved own notes; learner A at old level 2 with started cards in levels 1–2 and a «оба» reverse card in state `new`; learner B in onboarding step `goal`; learner C finished, nothing started; their `user_decks` rows), runs the statements of the migration file, and asserts: every note id, card and review-log row is unchanged; one catalog deck `a1` with `level_no = 1`, `total = 12`, coverage of the old level 4; notes ordered by `seq` as old level then id; no catalog `user_decks` row; own-deck subscriptions kept; A: `levels = 1`, `hints_seen = 63`, `user_progress (1, 0)` = the number of started words; B: step `levels`, `hints_seen = 0`; running the file a second time changes nothing; **Review Focus 5**: `nextScreen` for A after the migration returns the next unstarted word of the old order.
- [ ] **Step 2: Run** `pnpm test test/db/migration-0009.test.ts` — expected: FAIL (no such file).
- [ ] **Step 3: Write the migration.**
- [ ] **Step 4: Remove the old model** from the code and the helpers; rewrite the tests that depended on it (digest §12 marks them). Keep the column `users.level` and `decks.level_no` in the schema.
- [ ] **Step 5: Run** `pnpm typecheck && pnpm depcruise && pnpm test && pnpm test:ci` — expected: PASS, coverage thresholds met. `grep -rn "LAST_LEVEL\|levelSlug\|placement\|\.level\b" src` shows no reader of the old level.
- [ ] **Step 6: Commit** `feat(db): move the live catalog to A1; remove the hundred-level model`.

### Task 10: Tooling switch, workflows, documents

**Files:**
- Delete: `data/levels/`, `data/wordlist.csv`, `data/core.csv`, `scripts/validate-levels.ts`, the `cut` subcommand and its helpers in `scripts/build-wordlist.ts` and `scripts/lib/wordlist.ts`, the level-file helpers of `scripts/lib/levels.ts` and `scripts/lib/files.ts` that nothing uses, their tests
- Modify: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `package.json` (`validate` = `tsx scripts/validate-catalog.ts`), `scripts/build-wordlist.ts` (new subcommand `attest`: rewrites `data/attested.txt` from the examples of `data/catalog/*.csv` and the corpus word forms), `docs/OPERATIONS.md`, `README.md`, `docs/review/README.md`, both specs (the decisions of this plan)
- Create: `.github/workflows/kfu-specs.yml` on the default branch (from branch `kfu-specs-fetch`, trigger `workflow_dispatch` and push to `.github/trigger/kfu-specs`)
- Read first: digest §13, §14.

**Interfaces:**
- Consumes: Tasks 3, 3b, 9.
- Produces: CI runs `validate-catalog`; deploy detects `data/catalog/*.csv`, validates, seeds with the new script, and its report says `catalog levels in repo: N`; `docs/OPERATIONS.md` §3 describes fixing a word in `data/catalog/<level>.csv` (a word may now move between levels and topics; phrases need an example), §1 the new scale, new §9 «Письмо в КФУ» with a ready letter (who writes, a non-commercial study bot, the word lists of the specifications are used as a guide for which words and topics belong to a level, cards carry our own translations and examples, a request to confirm and to say how to credit; 5–7 sentences, no invented facts); spec §4 says time zone by buttons, spec §6 describes the hub.

- [ ] **Step 1: Switch the workflows and the package script; delete the old tooling and data.**
- [ ] **Step 2: Update the documents.** Every file, command, branch and secret named in `docs/OPERATIONS.md` must exist.
- [ ] **Step 3: Run** `pnpm typecheck && pnpm depcruise && pnpm validate && pnpm test:ci && npx tsx scripts/csv-to-sql.ts && python3 -c "import yaml,glob; [yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]"` — expected: all pass; `seed/catalog.sql` is written; `validate` prints `уровней: 1, карточек: 400, нарушений нет`.
- [ ] **Step 4: Commit** `chore: catalog tooling by CEFR level in CI and deploy; guide and specs updated`, push the branch, and wait for a green CI run on `cefr`.

### Task 11: Release

**Files:** none in the repository beyond the merge.

- [ ] **Step 1: Whole-branch review has passed** (controller).
- [ ] **Step 2: Backup.** `gh workflow run backup.yml -R Iskander-ibragimov/kabatla-bot --ref cefr`; wait for success. From `cefr`, not `master`: the repository is public, and until this branch is merged the `backup.yml` of `master` uploads the dump unencrypted (final review, C1). The artifact must be `kabatla-d1-backup-enc`.
- [ ] **Step 3: Merge `cefr` into `master`** (fast-forward or a merge commit) and push. The push starts Deploy.
- [ ] **Step 4: Verify.** `gh run watch`; then `git fetch origin deploy-report && git show origin/deploy-report:deploy.md`. Expected: every step success; migrations applied; catalog validation `уровней: 1, карточек: 400, нарушений нет`; webhook host matches; `last_error_message` empty; self-check as before; notes without audio: 0.
- [ ] **Step 5: If Deploy is red** — read the report, fix on `cefr`, merge again; at most three runs, then stop and report. The backup of Step 2 is the way back for data.

### Task 12: Content tooling for filling the levels (after the release)

**Files:**
- Create: `scripts/kfu-lists.ts` (reads `data/work/kfu/s_<LEVEL>.txt`, writes `data/work/kfu/lists.json`: per level and KFU topic, the entries; and `data/work/kfu/pool.tsv`: entry, KFU level, KFU topic, mapped topic slug by spec §3.2, kind `word | phrase | name | combination`, corpus rank or empty), `scripts/coverage.ts` (recomputes `data/catalog/meta.json` from the catalog words and the lemma counts)
- Modify: `scripts/build-wordlist.ts` (`candidates` takes `--level <a1…c1>` and lists, by spec §3.6 rules 1–4, the next words for that level that are not in the catalog)
- Test: `test/scripts/kfu.test.ts` (parsing on a small fixture text: headings, numbered entries, repeated headings, a level whose second topic has no heading), `test/scripts/coverage.test.ts`

- [ ] **Step 1: Tests first, then the three tools.** Expected counts on the real files, as a check: entries A1 526, A2 871, B1 1 004, B2 892, C1 1 153; unique over all levels 3 854.
- [ ] **Step 2: Commit** `feat(scripts): KFU word lists as a pool; coverage; candidates by level`.

### Task 13: A1 to 500 cards (content, after Task 12)

- [ ] **Step 1: Author** adds the next 100 cards to `data/catalog/a1.csv` by spec §3.6 (KFU A1 words first, then the most frequent missing words), each with transcription, part of speech, translation, topic and one example; rows that the rule moves out of A1 are listed, not moved, until A2 is built.
- [ ] **Step 2: Independent second pass** on the 100 new rows and on the 56 open questions of `docs/review/level-01.md … level-04.md` (spec §3.6 «Качество»); corrections applied.
- [ ] **Step 3:** `pnpm validate`, `scripts/coverage.ts`, commit `feat(data): A1 complete — 500 cards`, merge to `master`, verify Deploy and that the voicing run leaves 0 notes without audio.
