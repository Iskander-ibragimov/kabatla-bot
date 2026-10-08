# Interval ladder and practice-card onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the FSRS scheduler by a fixed ten-rung ladder with reset, write the grade buttons' intervals in words, and turn the onboarding into a practice card on four buttons with a menu command `/howto`.

**Architecture:** The scheduler is one pure module with the interface the bot already uses (`Mem`, `grade`, `preview`, `stage`, `memoryDays`, `newMem`); the ladder keeps that interface, so the queue, the database and the tables do not change. The practice card is stateless: the pressed buttons travel in the callback data, nothing is written. Onboarding keeps its state machine with one step renamed.

**Tech Stack:** TypeScript strict, Cloudflare Workers + D1, grammY, Vitest with `@cloudflare/vitest-pool-workers` (real D1), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-08-practice-card-onboarding-design.md` (binding; Russian). Read §3, §4, §6, §7.

## Global Constraints

- Branch `ladder`, worktree `/home/claude/kabatla-ladder`. Never commit or push to `master`: a push there deploys the bot.
- No migration, no change to table columns. `cards.stability`, `cards.difficulty`, `users.retention`, `users.hints_seen` stay and are simply not read (stability and difficulty are written as NULL).
- Budgets per Telegram update: ≤ 8 D1 calls, ≤ 3 Telegram calls (autoplay ≤ 10 / ≤ 5), checked with `test/helpers/countingDb.ts` as the existing bot tests do.
- Rungs, exact: 1 min, 10 min, 1 day, 3, 7, 14, 30, 60, 120, 180 days. «Трудно» at rung 0 or 1: 5 minutes. No fuzz.
- Every text exists in `src/i18n/ru.ts` and `src/i18n/tt.ts`; the Russian texts are those of spec §4.2, the Tatar ones those of spec §6, verbatim.
- `src/srs/**` imports no npm package (rule `srs-no-deps` of `.dependency-cruiser.cjs`).
- The repository may become public again: no tokens, ids or learners' words in commits, logs or reports.
- Verification before a task is reported: `pnpm typecheck && pnpm depcruise && pnpm validate && pnpm test:ci`.

## Review Focus

1. A card written by the old scheduler (state `review` with `scheduled_days` 2, 8, 11, 46 or 200 and a fractional `stability`; state `relearning` with `step` 0; state `learning` with `step` NULL) is shown, graded and undone without an error and lands on the rung of spec §3.3 — Task 1 (`rungOf`), Task 2 (a session test on such rows).
2. Undo restores the memory exactly as the log holds it, including old log rows whose `state_before` JSON carries `stability` and `difficulty` — Task 2.
3. A word graded «Снова» comes back in the same session after its minute, and a session with only minute-rung words that are not due yet ends with the "next in N" screen instead of looping — Task 2.
4. A practice button pressed twice, pressed on an old message after the introduction is finished, or pressed while the learner stands on another step, never writes to the database and never answers with an error (Telegram's "message is not modified" included) — Task 3.
5. The four buttons of a card on the top rung show the same interval, and a button label is at most 18 characters in both languages for every rung — Task 1 (label table), Task 2 (card rendering).

---

### Task 1: The ladder and the interval words (pure)

**Files:**
- Create: `src/srs/ladder.ts`, `src/srs/interval.ts`
- Test: `test/srs/ladder.test.ts`, `test/srs/interval.test.ts`
- Do not touch `src/srs/fsrs.ts` or any importer yet (Task 2).

**Interfaces:**
- Produces, `src/srs/ladder.ts`:
  - types `CardState`, `Rating`, `Lang`, `Stage`, `Mem` — copied unchanged from `src/srs/fsrs.ts`;
  - `export const RUNGS: readonly number[]` — the ten intervals in ms, index 0 is rung 1; `export const TOP = 10`; `export const HARD_BOTTOM_MS = 300_000`;
  - `rungOf(m: Mem): number` — 0…10 by spec §3.3: `new` → 0; `learning`/`relearning` → `(m.step ?? 0) + 1`, at most 2; `review` → the highest rung ≥ 3 whose days ≤ `m.scheduledDays`, 3 when none;
  - `newMem(now: number): Mem` — as today, `stability` and `difficulty` null;
  - `grade(m: Mem, rating: Rating, now: number): Mem`;
  - `preview(m: Mem, now: number): Record<Rating, number>` — the due time of each button, equal to `grade(m, r, now).due`;
  - `stage(m: Mem): Stage`, `memoryDays(m: Mem): number` — `review` → `scheduledDays`, anything else → 0.
- Produces, `src/srs/interval.ts`: `formatInterval(ms: number, lang: Lang, form: "plain" | "after" = "plain"): string` by spec §4.4.

- [ ] **Step 1: Write `test/srs/ladder.test.ts`** with these cases (`now` fixed, `MIN = 60_000`, `DAY = 86_400_000`; `at(rung)` builds the Mem `grade` itself produces for that rung):
  - new word: `preview` gives `now + 1·MIN`, `now + 5·MIN`, `now + 10·MIN`, `now + 1·DAY`; `grade(new, 1)` → `{state: "learning", step: 0, scheduledDays: 0, reps: 1, lapses: 0, stability: null, difficulty: null, lastReview: now}`; `grade(new, 3)` → `learning`, `step` 1; `grade(new, 4)` → `{state: "review", step: null, scheduledDays: 1}`;
  - rung 1: «Трудно» → rung 1 with 5 minutes; «Хорошо» → rung 2 (10 min); «Легко» → rung 3;
  - rung 2: «Трудно» → rung 2, 10 min; «Хорошо» → `review`, 1 day; «Легко» → 3 days;
  - every rung 3…10, a table: «Трудно» keeps `scheduledDays`; «Хорошо» gives the next rung's days (180 at the top); «Легко» gives the days two rungs up (180 from rungs 9 and 10); «Снова» → `{state: "relearning", step: 0, scheduledDays: 0, lapses: before + 1}`, due `now + 1·MIN`;
  - a `relearning` word: «Хорошо» from rung 1 stays `relearning` with `step` 1; «Хорошо» from rung 2 → `review`, 1 day; «Снова» on a minute rung does not raise `lapses`;
  - `reps` grows by 1 on every grade; `due = now + interval` exactly; `rungOf(grade(m, r, now))` equals the rung the table expects;
  - old cards: `rungOf` of `review` with `scheduledDays` 0 → 3, 2 → 3, 3 → 4, 8 → 5, 11 → 5, 46 → 7, 200 → 10; `learning` with `step` null → 1; `relearning` with `step` 1 → 2; `learning` with `step` 5 → 2;
  - `stage`: new → `new`; rung 2 → `learning`; 3 days → `learning`; 7 days → `known`; 30 days → `learned`; `memoryDays`: 14-day rung → 14; `relearning` → 0;
  - `RUNGS` equals `[1·MIN, 10·MIN, 1·DAY, 3·DAY, 7·DAY, 14·DAY, 30·DAY, 60·DAY, 120·DAY, 180·DAY]`.
- [ ] **Step 2: Write `test/srs/interval.test.ts`**: `it.each` over
  - ru plain: 30 s → `меньше минуты`; 1, 2, 5, 10, 11, 21, 22, 25 min → `1 минута`, `2 минуты`, `5 минут`, `10 минут`, `11 минут`, `21 минута`, `22 минуты`, `25 минут`; 1, 3, 5, 21 h → `1 час`, `3 часа`, `5 часов`, `21 час`; 1, 3, 7, 14, 21 days → `1 день`, `3 дня`, `7 дней`, `14 дней`, `21 день`; 30, 60, 120, 180 days → `1 месяц`, `2 месяца`, `4 месяца`, `6 месяцев`; 69 days → `2,3 месяца`; 365, 730, 1825, 548 days → `1 год`, `2 года`, `5 лет`, `1,5 года`;
  - ru after: 1 min → `1 минуту`; 21 min → `21 минуту`; 2 min → `2 минуты`; 5 min → `5 минут`; 1 day → `1 день`; 30 s → `меньше минуты`;
  - tt plain: 30 s → `минуттан кимрәк`; 5 min → `5 минут`; 3 h → `3 сәгать`; 14 days → `14 көн`; 60 days → `2 ай`; 548 days → `1,5 ел`; tt after equals tt plain;
  - every one of the ten `RUNGS` in both languages is at most 9 characters (so that «Хорошо · » plus it is ≤ 18).
- [ ] **Step 3: Run both files — expected: FAIL, modules not found.**
- [ ] **Step 4: Implement the two modules.** `grade` is a table over `rungOf(m)` and the rating; the unit boundaries of `formatInterval` are those of today's function in `src/srs/fsrs.ts` (under a minute; minutes under 60; hours under a day, rounded; days under 30; months under 365 days as `d / 30` with one decimal and a comma; years as `d / 365`), without the `<` sign.
- [ ] **Step 5: Run — expected: PASS.** Then the whole verification chain.
- [ ] **Step 6: Commit** `feat(srs): a ten-rung ladder of intervals; intervals in words`.

### Task 2: The bot runs on the ladder

**Files:**
- Modify: `src/review/service.ts`, `src/bot/views.ts`, `src/bot/screens.ts`, `src/bot/bot.ts`, `src/users/service.ts`, `src/db/repo.ts`, `src/db/sql.ts`, `src/stats/service.ts`, `src/tutorial/hints.ts`, `src/i18n/index.ts`, `src/i18n/ru.ts`, `src/i18n/tt.ts`, every test and helper that imports `src/srs/fsrs`, `package.json`, `pnpm-lock.yaml`
- Delete: `src/srs/fsrs.ts`, `test/srs/fsrs.test.ts`
- Test: `test/review/ladder-session.test.ts` (new), the existing suites updated

**Interfaces:**
- Consumes: Task 1's `grade(m, rating, now)`, `preview(m, now)`, `rungOf`, `stage`, `memoryDays`, `newMem`, `TOP`, `formatInterval`.
- Produces: `Feedback` without `keptDays`; i18n key `rung: (n: number) => string` — ru `ступень ${n} из 10`, tt `баскыч ${n}/10`; the grade buttons read `${t.good} · ${interval}`; `SettingKey` without `"retention"`.

- [ ] **Step 1: Write `test/review/ladder-session.test.ts`** (real D1, the helpers of `test/helpers/review.ts` and `test/helpers/catalog.ts`):
  - the first card of a new learner has the buttons `Снова · 1 минута`, `Трудно · 5 минут`, `Хорошо · 10 минут`, `Легко · 1 день` (ru) and `Яңадан · 1 минут`, `Авыр · 5 минут`, `Яхшы · 10 минут`, `Җиңел · 1 көн` (tt);
  - a word graded «Хорошо» six times at its due times stands on 10 min, 1, 3, 7, 14, 30 days in turn (read `scheduled_days` and `state` from the row);
  - «Снова» on the 14-day rung: state `relearning`, due in 1 minute, `lapses` 1; one minute later the same word is the next card; «Хорошо», «Хорошо» bring it to 1 day;
  - undo after that «Снова» restores state `review`, `scheduled_days` 14 and the old due time;
  - rows written by the old scheduler — (`review`, `scheduled_days` 11, `stability` 11.4, `difficulty` 5.2), (`relearning`, `step` 0, `stability` 3.1), (`learning`, `step` NULL) — are each shown with four buttons, graded «Хорошо» and undone without an error; the first lands on 14 days;
  - undo of a log row whose `state_before` JSON holds `stability` and `difficulty` writes the row back with those values;
  - a learner whose only cards are two minute-rung words due in 1 and 5 minutes gets the done screen, not a card, and no D1 write;
  - a card on the top rung shows `6 месяцев` on «Трудно», «Хорошо» and «Легко»;
  - the progress line of a card on the 7-day rung contains `ступень 5 из 10`; a new word's has no rung;
  - `/settings` has no row with «Нагрузка»; the callback `set:ret` from an old message changes nothing in `users` and is answered as the catch-all answers an unknown button.
- [ ] **Step 2: Run it — expected: FAIL.**
- [ ] **Step 3: Switch the bot.** Every import of `srs/fsrs` becomes `srs/ladder` (and `srs/interval` for `formatInterval`); `grade` and `preview` lose the retention argument; `progressLine` writes stage, `t.rung(rungOf(m))` for rungs ≥ 1, and the review number; the buttons get the « · »; `memory` and `setMode` leave the dictionaries; the settings screen loses the row, `bot.ts` the `ret` case, `users/service.ts` the key and `RETENTIONS`; the SQL of the stats' sum of memory days counts a `relearning` card as 0; `pnpm remove ts-fsrs`; delete the two files. The four button hints (removed in Task 3) keep working until then: they get the interval from `formatInterval(…, lang, "after")`, since their Russian text has «через».
- [ ] **Step 4: Update the existing tests** to the ladder's intervals and states. A test whose subject is gone (the retention setting, FSRS numbers) is deleted; a test whose subject remains is kept and re-pinned, never weakened. List in the report every test deleted and why.
- [ ] **Step 5: Run the new file and the whole chain — expected: PASS,** `pnpm depcruise` clean, no `ts-fsrs` in `package.json` or the lockfile.
- [ ] **Step 6: Commit** `feat: the bot schedules by the ladder; the retention setting and ts-fsrs are gone`.

### Task 3: Practice card, `/howto`, texts

**Files:**
- Create: `src/tutorial/practice.ts`; Test: `test/tutorial/practice.test.ts`
- Modify: `src/users/service.ts`, `src/bot/screens.ts`, `src/bot/bot.ts`, `src/tutorial/hints.ts`, `src/review/service.ts`, `src/bot/views.ts`, `src/db/repo.ts` (`keepHints` goes), `src/i18n/ru.ts`, `src/i18n/tt.ts`, `scripts/set-webhook.ts`, `docs/OPERATIONS.md`, `test/bot/tutorial.test.ts`, `test/tutorial/hints.test.ts`, `test/bot/settings.test.ts`, `test/bot/views.test.ts`

**Interfaces:**
- Consumes: `preview`, `newMem`, `RUNGS`, `formatInterval`.
- Produces:
  - `src/tutorial/practice.ts`: `press(mask: number, rating: Rating): number` (`mask | 1 << (rating − 1)`), `tried(mask: number): number` (0…4), `ALL = 15`, `parse(data: string): { mask: number; rating: Rating } | null` for `pr:<mask>:<rating>` with mask 0…15 and rating 1…4;
  - onboarding steps `["lang", "intro1", "practice", "levels"]`; a stored `intro2` reads as `practice`; `OnboardingScreen` has `{ kind: "intro" }` and `{ kind: "practice" }`; answers: `n1` on `intro1` → `practice`, `n2` on `practice` → `levels`;
  - screens: `renderAbout(lang, replay)` — text `intro1`, button «Попробовать» with `ob:n1`, or `pr:start` on replay; `renderPractice(mask, last: Rating | null, lang, replay)` — spec §4.2, the four buttons `pr:<mask>:<rating>` with «✅ » before the tried ones, last row «Пропустить» → `ob:n2`, or «▶ Учить» → `learn` on replay; when `mask === 15` it is the final screen with «Дальше» → `ob:n2`, or «▶ Учить» → `learn`;
  - bot: `/howto` (behind `ready`) sends `renderAbout(lang, true)`; `pr:start` and `pr:<mask>:<rating>` redraw the message, are NOT stopped by the settings gate of the introduction, and choose `replay` by `ctx.user.onboardingStep !== "practice"` (a stored `intro2` counts as `practice`);
  - hints: `HINT = { front: 1, update: 64 }`; `afterGrade(seen)` only marks; `Lead` has no `button`; the texts `hintAgain`, `hintHard`, `hintGood`, `hintEasy`, `hintOrder`, `intro2`, `gotItBtn`, `setTutorial` and the callbacks `set:tut`, `tut:2`, `tut:ok` are removed;
  - menu: `howto` after `levels` in `scripts/set-webhook.ts`, key `cmdHowto`; one line in `help`.

- [ ] **Step 1: Write `test/tutorial/practice.test.ts`**: `press` from each of the 16 masks with each rating; pressing a tried button keeps the mask; `tried` of 0, 5, 15; `parse` accepts `pr:0:1`, `pr:15:4`, refuses `pr:16:1`, `pr:3:5`, `pr:x:1`, `pr:3`, `pr:3:1:1`.
- [ ] **Step 2: Extend `test/bot/tutorial.test.ts`** (the file's harness with the counting database):
  - a new learner: language → the about screen with «Попробовать» → the practice card: text has `Тренировка · 0 из 4`, `китап`, the spoiler with `книга`, the ladder line of spec §4.2, buttons `Снова · 1 минута`, `Трудно · 5 минут`, `Хорошо · 10 минут`, `Легко · 1 день`, `Пропустить`;
  - pressing «Хорошо»: one `editMessageText` and one `answerCallbackQuery`, 1 D1 call, no row written anywhere (compare `SELECT COUNT(*)` of `cards`, `review_log`, `sessions`, `user_progress` and the user's row before and after); text has `1 из 4`, the «Хорошо» explanation of spec §4.2 with `через 10 минут`, `Осталось кнопок: 3`; the button reads `✅ Хорошо · 10 минут`;
  - the «Снова» explanation has `через 1 минуту`;
  - pressing «Хорошо» again: the same text, no error when Telegram answers "message is not modified";
  - the four buttons in any order → the final screen with «Дальше»; «Дальше» → the levels step; «Начать» → the first real card with the same four intervals;
  - «Пропустить» from the fresh card → the levels step;
  - a learner stored on step `intro2` gets the practice card on `/start`;
  - after the introduction: `/howto` → about screen with `pr:start`; `pr:start` → practice card whose last row is «▶ Учить»; four presses → final screen with «▶ Учить»; the whole run writes nothing; `onboarding_step` stays NULL;
  - `/howto` on the steps `intro1`, `practice`, `levels` answers as `/learn` does there; on the language step it gives the language screen;
  - a practice button of the introduction's message pressed after the introduction is over works as a replay and writes nothing; `ob:n2` pressed then is answered as a stale button;
  - `set:tut`, `tut:2`, `tut:ok` from old messages: nothing written, the tap answered;
  - a grade on a real card shows no line about the button; the first real card still has the `hintFront` line;
  - Tatar: the same first three assertions with the texts of spec §6;
  - the commands list built by `scripts/set-webhook.ts` for ru and tt has nine entries with `howto` after `levels` (export the list builder if it is not exported).
- [ ] **Step 3: Run — expected: FAIL.**
- [ ] **Step 4: Implement** by the interfaces above. The ladder line and the three intervals in the «Хорошо» text are built from `RUNGS` with `formatInterval`, not typed. `docs/OPERATIONS.md`: the commands the owner sees, what a new learner goes through, the ladder in one paragraph, and "nine commands" where the deploy report is described.
- [ ] **Step 5: Run the two files and the whole chain — expected: PASS.**
- [ ] **Step 6: Commit** `feat: onboarding through a practice card; /howto; the button hints are gone`.

### Release (controller, after the whole-branch review)

- [ ] Backup: `gh workflow run backup.yml -R Iskander-ibragimov/kabatla-bot --ref master`; wait for success; the artifact is `kabatla-d1-backup-enc`.
- [ ] Fast-forward `master` to `ladder`, push; wait for Deploy; read `deploy.md` on `deploy-report`: every step success, `commands (ru): 9` with `howto`, catalog `500 / 500`, self-check 401 / 200.
