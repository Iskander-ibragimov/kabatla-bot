# «Кабатла» MVP — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Telegram-бот, который учит 2 000 частотных татарских слов интервальными повторениями: 20 уровней по 100 слов, транскрипция татарскими буквами, озвучка, свои слова, интерфейс на русском или татарском.

**Architecture:** Код копируется из `Iskander-ibragimov/bot-anki@deab0ff` в отдельный репозиторий и переводится на татарскую модель данных. Один Cloudflare Worker (вебхук + тик раз в минуту) и одна база D1. Словарь собирается скриптами и агентами из корпуса и Tatoeba в CSV; синтез речи идёт только в GitHub Actions, воркер хранит `file_id`.

**Tech Stack:** TypeScript 5 strict, Cloudflare Workers + D1, grammY, ts-fsrs, zod, Vitest + `@cloudflare/vitest-pool-workers`, dependency-cruiser, pnpm 12, GitHub Actions, ffmpeg, Piper.

**Spec:** `docs/superpowers/specs/2026-10-03-tatar-srs-bot-design.md`

## Global Constraints

- Рабочая копия: `/home/claude/tatar-bot`. Источник кода: `/home/claude/iskander-ibragimov/bot-anki` (только чтение, не менять).
- Репозиторий `Iskander-ibragimov/kabatla-bot`, приватный. Ветка `master`. Воркер `kabatla-bot`, база D1 `kabatla`.
- Коммиты идут в `master`. `deploy.yml` появляется только в задаче 17, до этого ничего не выкладывается.
- Бюджет $0. Вебхук: не больше 8 обращений к D1 и 3 к Telegram. Тик: не больше 35 отправок и 10 обращений к D1. Проверяется тестами со счётчиком (`test/helpers/countingDb.ts`).
- Языки интерфейса: только `ru` и `tt`. Перевод слов всегда на русский.
- Татарский текст (слова, примеры, транскрипция, тексты `tt`) пишется буквами ә ө ү җ ң һ (U+04D9, U+04E9, U+04AF, U+0497, U+04A3, U+04BB и заглавные). Латинские и чужие кириллические двойники запрещены.
- Транскрипция хранится без скобок (`wакъы́т`), скобки добавляет отрисовка. Ударение: U+0301 после гласной; в односложных словах не ставится.
- Коды частей речи: `n, v, adj, adv, pron, num, post, conj, part, intj, phr`.
- Колонки CSV уровня: `word, transcription, pos, translation, example_tt, example_ru, example_src, audio_file_id`. `example_src`: `tatoeba:<id>` или `own`.
- Сеть из рабочей среды: только GitHub, npm, PyPI. corpus.tatar, Tatoeba, Google Drive, сервис озвучки доступны только из GitHub Actions.
- Секреты (токен бота, ключи) не пишутся в файлы, логи и чат. Они живут в секретах репозитория, вводит их владелец.
- Workflow с ручным запуском имеет и второй триггер: `push` по пути `.github/trigger/<имя>`. Если `gh workflow run` недоступен, запуск делается коммитом в этот файл.
- Минуты GitHub Actions: приватный репозиторий, 2 000 минут в месяц. Задача по расписанию без работы завершается быстрее 2 минут.
- После первого деплоя слово каталога не меняет уровень; исправляются только поля карточки.
- Слои и правила зависимостей из `.dependency-cruiser.cjs` сохраняются: сервисы не импортируют `bot`.
- Каждый коммит заканчивается строками:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` и `Claude-Session: https://claude.ai/code/session_01CiDfx5Vzphh1nTYfcQvAx1`

## Решения сверх спеки

Записаны здесь, потому что без них задачи неоднозначны. Спека обновлена в тех же местах.

1. **Слово из закрытого уровня** копируется в «Мои слова» вместе с озвучкой. Когда уровень откроется, слово каталога с тем же `word_key` пропускается и считается показанным.
2. **`users.level = 21`** означает «все уровни пройдены». Отдельного флага поздравления нет.
3. **Предел «лёгких» слов:** не больше 200 новых слов в день, оценённых «Легко» с первого показа. Дальше новые слова в этот день не выдаются. Защищает общий лимит записей D1.
4. **`notes.audio_tries`:** счётчик неудачных попыток озвучки. После трёх слово больше не берётся в работу.
5. **Импорт CSV через чат (`message:document`) убран.** Каталог состоит только из уровней и обновляется через репозиторий.
6. **Бытовое ядро** стоит в уровнях 1–3 вперемешку с самыми частотными словами; что не поместилось, идёт в уровень 4.
7. **Сообщение о новом уровне** приходит первой строкой той же карточки, а не отдельным сообщением: иначе вебхук превысит 3 обращения к Telegram.

## Review Focus

Пять случаев, которые спека подразумевает, но её список тестов не покрывает. Тест на каждый добавлен в задачу-владельца.

1. Слово набрано без татарских букв («эни», «уй») и совпадает с каталогом только после восстановления написания → берётся карточка каталога, дубль не создаётся. Задача 11.
2. Слово, которое синтез не может озвучить (эмодзи, латиница, 300 символов), не блокирует очередь озвучки остальных. Задача 15.
3. Повторная загрузка каталога при деплое исправляет поля карточки, но не сбрасывает прогресс и не стирает `audio_file_id`, если в CSV он пуст. Задача 12.
4. «Отменить» сразу после открытия уровня: уровень остаётся открытым, карточка возвращается, повторная оценка не даёт второго сообщения об уровне. Задача 8.
5. `transcribe` получает латиницу, цифры, пустую строку, фразу с пунктуацией → не падает, нетатарские куски возвращает как есть. Задача 5.

## Порядок и остановки

```
1 репозиторий ─ 2 источники ─ 3 проба голосов ──(G2: владелец выбирает голос)── 15 озвучка
      │                └────── 12 скрипты словаря ─ 13 уровень 1 ──(G3: вычитка)── 14 уровни 2–20
      └─ 4 модель данных ─ 5…11 код бота ──────────────────────────────────────── 16 сценарий ─ 17 запуск
```

| Остановка | Что нужно от владельца | Что блокирует |
|---|---|---|
| G1, после задачи 1 | Новый токен бота в секрете `BOT_TOKEN`, `ADMIN_TG_ID`; нажать «Start» в боте | Задачу 3 |
| G2, задача 3 | Послушать 20 слов × 4 голоса, назвать голос | Задачу 15 |
| G3, задача 13 | Вычитать уровень 1 и татарские тексты интерфейса (~1 час) | Задачу 14 |
| G4, задача 17 | Остальные секреты; письмо на dev@translate.tatar, если выбран голос speech.tatar | Запуск |

Задачи 4–11 остановок не ждут.

## File Structure

```
migrations/0001_init.sql            одна начальная миграция (§9 спеки)
src/db/repo.ts                      типы и запросы; новая схема, уровни, жалобы
src/content/tatar.ts                НОВЫЙ: алфавит, проверка букв, ряд гласных
src/content/transcribe.ts           НОВЫЙ: правила транскрипции
src/content/transcribe-exceptions.ts НОВЫЙ: список исключений
src/content/llm.ts                  схема и подсказки под татарский
src/content/service.ts              каталог → нейросеть → каталог
src/content/audio.ts                только playVoice
src/content/dictionary.ts           УДАЛЁН
src/review/service.ts               автопереход уровня, предел «лёгких»
src/users/{service,placement}.ts    онбординг без колоды, стартовый уровень
src/i18n/{ru,tt,index}.ts           tt вместо en
src/bot/{bot,views,screens}.ts      /levels, ⚑, транскрипция на карточке
src/admin/service.ts                жалобы; импорт CSV убран
src/reminders/service.ts            без фоновой озвучки
scripts/fetch-sources.ts            скачивание корпуса и Tatoeba (в Actions)
scripts/build-wordlist.ts           candidates | examples | cut | review
scripts/validate-levels.ts          проверки §4.4, запускается в CI
scripts/csv-to-sql.ts               data/levels → seed/catalog.sql
scripts/voice.ts                    sample | catalog | db
scripts/lib/{sources,levels,tts-api,tts-local,tatar-verbs}.ts
scripts/check_transcription.py      сверка с espeak-ng
data/wordlist.csv                   авторский список, порядок строк = порядок изучения
data/core.csv                       бытовое ядро
data/attested.txt                   словоформы примеров, подтверждённые корпусом
data/levels/l01.csv … l20.csv, meta.json
data/voice.json                     выбранный голос
.github/workflows/{ci,fetch-sources,voice-sample,voice-catalog,voice-db,deploy,backup}.yml
```

---

## Этап A. Основа

### Task 1: Репозиторий и каркас

**Files:**
- Create: весь код копией из `bot-anki@deab0ff`, кроме `.git`, `README.md`, `.github/workflows/{deploy,expand-decks,voice-decks,backup}.yml`
- Modify: `package.json` (name `kabatla-bot`), `wrangler.toml` (name `kabatla-bot`, `database_name = "kabatla"`), `.gitignore` (+ `data/work/`, `seed/`)
- Create: `README.md` (10 строк: что это, команды `pnpm test`, ссылка на спеку)

**Interfaces:**
- Produces: репозиторий с зелёным CI; команды `pnpm typecheck`, `pnpm test`, `pnpm depcruise`.

- [ ] **Step 1: Создать репозиторий**

```bash
cd /home/claude/tatar-bot
gh repo create Iskander-ibragimov/kabatla-bot --private --source . --remote origin
```
Если GitHub отказывает: остановиться и попросить владельца создать пустой приватный репозиторий `kabatla-bot` и выдать доступ приложению Claude; затем подключить репозиторий с правом записи и `git remote add origin`.

- [ ] **Step 2: Скопировать код и переименовать**

```bash
rsync -a --exclude .git --exclude README.md --exclude node_modules --exclude docs \
  --exclude '.github/workflows/deploy.yml' --exclude '.github/workflows/expand-decks.yml' \
  --exclude '.github/workflows/voice-decks.yml' --exclude '.github/workflows/backup.yml' \
  /home/claude/iskander-ibragimov/bot-anki/ /home/claude/tatar-bot/
```
Английские колоды и их тесты на этом шаге остаются: они удаляются в задачах 4 и 12.

- [ ] **Step 3: Проверить, что копия рабочая**

Run: `pnpm install && pnpm typecheck && pnpm depcruise && pnpm test`
Expected: 119 passed, 0 failed.

- [ ] **Step 4: Commit и push**

```bash
git add -A && git commit -m "chore: bootstrap from bot-anki@deab0ff" && git push -u origin master
gh run watch --exit-status
```
Expected: CI зелёный.

- [ ] **Step 5: Остановка G1** — написать владельцу, какие два секрета нужны для задачи 3 и где их ввести (`Settings → Secrets and variables → Actions`), и попросить нажать «Start» в новом боте.

### Task 2: Источники словаря

**Files:**
- Create: `scripts/lib/sources.ts`, `scripts/fetch-sources.ts`, `.github/workflows/fetch-sources.yml`
- Test: `test/scripts/sources.test.ts`

**Interfaces:**
- Produces: ветка `sources` с файлами
  - `lemmas.tsv` — `count\tlemma\tpos` (pos как в корпусе), все списки частей речи
  - `wordforms.txt.gz` — по одной словоформе в строке, только с частотой ≥ 3
  - `tatoeba.tsv` — `tat_id\ttat\trus_id\trus`
  - `STATS.md` — число лемм по частям речи, сумма частот, число словоформ, число пар Tatoeba
- Produces: `parseLemmaLine(line: string, pos: string): { count: number; lemma: string; pos: string } | null`, `pairSentences(tat: Map<number,string>, rus: Map<number,string>, links: [number, number][]): { tatId: number; tat: string; rusId: number; rus: string }[]`

- [ ] **Step 1: Написать падающий тест**

```ts
it("parses a corpus line and skips garbage", () => {
  expect(parseLemmaLine("12345 вакыт\tN", "n")).toEqual({ count: 12345, lemma: "вакыт", pos: "n" });
  expect(parseLemmaLine("", "n")).toBeNull();
  expect(parseLemmaLine("abc вакыт", "n")).toBeNull();
});
it("pairs Tatar sentences with Russian translations", () => {
  const tat = new Map([[1, "Вакыт бик тиз уза."], [2, "Сәлам!"]]);
  const rus = new Map([[10, "Время проходит очень быстро."]]);
  expect(pairSentences(tat, rus, [[1, 10], [2, 99]])).toEqual([{ tatId: 1, tat: "Вакыт бик тиз уза.", rusId: 10, rus: "Время проходит очень быстро." }]);
});
```

- [ ] **Step 2:** Run `pnpm test test/scripts/sources.test.ts` → FAIL (модуль не найден).
- [ ] **Step 3:** Реализовать обе функции в `scripts/lib/sources.ts`.
- [ ] **Step 4:** Run тот же тест → PASS.
- [ ] **Step 5: Скрипт и workflow**

`scripts/fetch-sources.ts` (Node, запускается только в Actions):
- со страницы `https://www.corpus.tatar/stat_en.htm` берёт все ссылки вида `stat/*.txt`; списки `lemmas_frequency_<pos>` идут в `lemmas.tsv`, список словоформ в `wordforms.txt.gz`;
- Tatoeba: `https://downloads.tatoeba.org/exports/per_language/tat/tat_sentences.tsv.bz2`, `…/per_language/rus/rus_sentences.tsv.bz2`, `…/per_language/tat/tat-rus_links.tsv.bz2`;
- пишет `out/` и `STATS.md`. Любой файл больше 50 МБ — ошибка.

`fetch-sources.yml`: `on: workflow_dispatch` и `push` по пути `scripts/fetch-sources.ts`; `permissions: contents: write`; результат — принудительный push содержимого `out/` в ветку-сироту `sources`.

- [ ] **Step 6: Запустить и проверить**

```bash
git add -A && git commit -m "feat(scripts): fetch corpus lists and Tatoeba pairs" && git push
gh run watch --exit-status && git fetch origin sources && git show origin/sources:STATS.md
```
Expected: в `STATS.md` ненулевые числа лемм по каждой части речи и число пар Tatoeba. Число пар записать в задачу 13: при числе меньше 3 000 примеры в основном пишутся как `own`.

### Task 3: Проба голосов

**Files:**
- Create: `scripts/lib/tts-api.ts`, `scripts/lib/tts-local.ts`, `scripts/voice.ts`, `data/voice-sample.txt`, `.github/workflows/voice-sample.yml`
- Test: `test/scripts/tts.test.ts`

**Interfaces:**
- Produces (`tts-api.ts`, без Node-модулей, тестируется):
  - `interface Tts { synth(text: string): Promise<Uint8Array> }` — WAV
  - `class TtsError extends Error {}`
  - `apiTts(speaker: "alsu" | "almaz", deps?: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number }): Tts` — GET `https://tat-tts.api.translate.tatar/listening/?speaker=<s>&text=<urlencoded>`, ответ `{ wav_base64, sample_rate }`; между запросами не меньше 1 000 мс
  - `speakable(text: string): boolean` — 1…80 символов, есть хотя бы одна кириллическая буква
  - `sendVoice(o: { token: string; chatId: string; ogg: Uint8Array; caption?: string; fetch?: typeof fetch }): Promise<string>` — возвращает `file_id`
- Produces (`tts-local.ts`, Node): `piperTts(modelPath: string): Tts`, `toOgg(wav: Uint8Array): Promise<Uint8Array>` (ffmpeg, libopus, 24k)
- Produces: `data/voice.json` — `{ "provider": "api" | "piper", "voice": string }` после остановки G2

- [ ] **Step 1: Написать падающие тесты**

```ts
it("decodes wav_base64", async () => {
  const f = async () => Response.json({ wav_base64: btoa("RIFFxxxx"), sample_rate: 22050 });
  expect(new TextDecoder().decode(await apiTts("alsu", { fetch: f as never, sleep: async () => {} }).synth("сәлам"))).toBe("RIFFxxxx");
});
it("waits at least 1000 ms between requests", async () => {
  let t = 0; const slept: number[] = [];
  const tts = apiTts("almaz", { fetch: (async () => Response.json({ wav_base64: "", sample_rate: 22050 })) as never, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  await tts.synth("бер"); t += 300; await tts.synth("ике");
  expect(slept).toEqual([700]);
});
it("throws TtsError on HTTP 500 and on unspeakable text without calling fetch", async () => {
  let calls = 0;
  const tts = apiTts("alsu", { fetch: (async () => { calls++; return new Response("", { status: 500 }); }) as never, sleep: async () => {} });
  await expect(tts.synth("сәлам")).rejects.toBeInstanceOf(TtsError);
  await expect(tts.synth("🙂")).rejects.toBeInstanceOf(TtsError);
  await expect(tts.synth("а".repeat(81))).rejects.toBeInstanceOf(TtsError);
  expect(calls).toBe(1);
});
it("sendVoice returns voice.file_id", async () => {
  const f = async () => Response.json({ ok: true, result: { voice: { file_id: "AwACAg" } } });
  expect(await sendVoice({ token: "1:x", chatId: "5", ogg: new Uint8Array(1), fetch: f as never })).toBe("AwACAg");
});
```

- [ ] **Step 2:** Run `pnpm test test/scripts/tts.test.ts` → FAIL.
- [ ] **Step 3:** Реализовать `tts-api.ts`, затем `tts-local.ts` и `scripts/voice.ts` с подкомандой `sample`.

`voice.ts sample`: читает `data/voice-sample.txt`, для каждого слова и каждого из голосов `api:alsu`, `api:almaz`, `piper:female`, `piper:male` синтезирует, перекодирует, отправляет в чат `ADMIN_TG_ID` с подписью `слово · голос`. Ошибка одного голоса не останавливает остальные; в конце одно текстовое сообщение со сводкой.

`data/voice-sample.txt`: сәлам, рәхмәт, әни, әти, өй, үзем, җир, яңа, һава, кояш, вакыт, сәгать, яшь, авыл, ел, китап, дус, мәктәп, күңел, бәхет.

`voice-sample.yml`: `workflow_dispatch`; ставит ffmpeg, `pip install piper-tts gdown`; модели TatarTTS — `gdown --folder 1YmtDVYLVogEfw3SE7GUl0LHZaIojAeap`; секреты `BOT_TOKEN`, `ADMIN_TG_ID`.

- [ ] **Step 4:** Run тест → PASS; `pnpm typecheck`.
- [ ] **Step 5:** Commit, push, `gh workflow run voice-sample.yml && gh run watch --exit-status`.

Expected: владельцу пришли голосовые сообщения. Если модели Piper не скачались, в сводке сказано, что пришли только два голоса.

- [ ] **Step 6: Остановка G2** — владелец называет голос. Записать `data/voice.json`, commit.

---

## Этап B. Код бота

### Task 4: Модель данных и перенос

**Files:**
- Delete: `migrations/0001_init.sql`, `migrations/0002_reminder_schedule.sql`, `src/content/dictionary.ts`, `src/i18n/en.ts`, `data/decks/`, `scripts/{build-decks,voice-decks,csv-to-sql}.ts`, `scripts/lib/decks.ts`, `test/seed.test.ts`, `test/helpers/seedSql.ts`, `test/fixtures/dictionary-serendipity.json`
- Create: `migrations/0001_init.sql`, `src/i18n/tt.ts`
- Modify: `src/db/repo.ts` и все модули `src/**`, `test/**`, которые используют переименованные поля

**Interfaces:**
- Produces (`src/db/repo.ts`):

```ts
export type Lang = "ru" | "tt";
export type Direction = "tt_ru" | "ru_tt";
export type DirectionSetting = Direction | "both";
export interface NoteFields {
  word: string; transcription: string | null; pos: string; translation: string;
  exampleTt: string; exampleRu: string; exampleSrc: string; audioFileId: string | null; sourceUrl: string | null;
}
export interface DeckRow {
  id: number; slug: string | null; ownerId: number | null; kind: "catalog" | "ai" | "custom";
  titleRu: string; titleTt: string; levelNo: number | null; coveragePct: number | null; total: number;
}
// User.level: number — 1…20; 21 = все уровни пройдены
// insertDeck({ slug, kind, titleRu, titleTt, levelNo, coveragePct, ownerId })
```
- Produces (`test/helpers/seed.ts`):
  - `seedLevels(db: D1Database, levels: Record<number, string[]>, coverage?: Record<number, number>): Promise<Record<number, number>>` — создаёт колоды `l01…` с заметками (`translation = word + "-ru"`, `exampleTt = word + "."`), возвращает id колод по номеру уровня
  - `seedUser(db, { now, level?, words?, patch?, tgId? })` — пользователь с пройденным онбордингом, подписанный на уровень `level` (по умолчанию 1). Если колоды уровня ещё нет, создаёт её из первых `words` (по умолчанию 5) слов списка `WORDS`
- Схема (отличия от `bot-anki`, остальное дословно, включая колонки и индексы из `0002`):

```sql
users:  lang TEXT NOT NULL DEFAULT 'ru' CHECK (lang IN ('ru','tt'))
        direction TEXT NOT NULL DEFAULT 'tt_ru' CHECK (direction IN ('tt_ru','ru_tt','both'))
        level INTEGER NOT NULL DEFAULT 1
decks:  title_ru, title_tt TEXT NOT NULL; level_no INTEGER; coverage_pct INTEGER   -- без title_en, level
        CREATE UNIQUE INDEX idx_decks_level ON decks(level_no) WHERE level_no IS NOT NULL;
notes:  transcription TEXT; example_tt TEXT NOT NULL DEFAULT ''; example_src TEXT NOT NULL DEFAULT '';
        audio_tries INTEGER NOT NULL DEFAULT 0                                     -- без ipa, example_en, audio_url
cards:  direction CHECK (direction IN ('tt_ru','ru_tt'))
reports(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, note_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE (user_id, note_id))
```

- [ ] **Step 1: Написать падающие тесты схемы** в `test/db/repo.test.ts`

```ts
it("accepts only ru and tt as interface language", async () => {
  await expect(env.DB.prepare("INSERT INTO users (tg_id, chat_id, lang, created_at) VALUES (1, 1, 'en', 0)").run()).rejects.toThrow();
  await env.DB.prepare("INSERT INTO users (tg_id, chat_id, lang, created_at) VALUES (1, 1, 'tt', 0)").run();
  const u = await env.DB.prepare("SELECT direction, level FROM users").first();
  expect(u).toEqual({ direction: "tt_ru", level: 1 });
});
it("has the Tatar note columns and none of the English ones", async () => {
  const cols = (await env.DB.prepare("PRAGMA table_info(notes)").all()).results.map((r) => r.name);
  expect(cols).toEqual(expect.arrayContaining(["transcription", "example_tt", "example_src", "audio_tries"]));
  expect(cols).not.toEqual(expect.arrayContaining(["ipa"]));
  expect(cols).not.toContain("example_en"); expect(cols).not.toContain("audio_url");
});
it("allows one level deck per level number", async () => {
  await seedLevels(env.DB, { 1: ["бер"] });
  await expect(new Repo(env.DB).insertDeck({ slug: "x", kind: "catalog", titleRu: "x", titleTt: "x", levelNo: 1, coveragePct: null, ownerId: null })).rejects.toThrow();
});
```

- [ ] **Step 2:** Run `pnpm test test/db/repo.test.ts` → FAIL.
- [ ] **Step 3: Перенос.** Написать миграцию; переименовать по всему `src` и `test`: `ipa → transcription`, `exampleEn → exampleTt`, `en_ru → tt_ru`, `ru_en → ru_tt`, `titleEn → titleTt`, `"en" → "tt"`; добавить `exampleSrc`. Удалить: `DictionaryClient` и его использование в `ContentService` и `BotDeps`; `audioUrl`; `runVoiceJob` и ветку `voice` в тике; обработчик `message:document` и `importDeckCsv`; `csvToSql` из `src/content/csv.ts` (вернётся в задаче 12). `src/i18n/tt.ts` на эту задачу — `export const tt: Dict = ru;` с комментарием `// replaced in Task 6`. `hasAudio = !!audioFileId`. «Мои слова»: `titleTt: "Минем сүзләр"`. `langFromTelegram`: код `tt` → `"tt"`, всё остальное → `"ru"`.
- [ ] **Step 4: Перенести тесты.** Тестовые слова в `test/helpers/seed.ts` заменить на татарские: `["китап","книга"], ["вакыт","время"], ["авыл","деревня"], ["су","вода"], ["юл","дорога"], ["көн","день"], ["өй","дом"], ["эш","работа"], ["кеше","человек"], ["сүз","слово"], ["яңа","новый"], ["зур","большой"]`. Тесты удалённых функций (словарь, фоновая озвучка, импорт CSV, seed английских колод) удаляются; остальные адаптируются.
- [ ] **Step 5:** Run `pnpm typecheck && pnpm depcruise && pnpm test` → PASS; в выводе нет ни одного пропущенного (`skipped`) теста. В сообщении коммита перечислить удалённые тесты поимённо.
- [ ] **Step 6:** Commit `feat(db): Tatar data model, port services and tests`.

### Task 5: Транскрипция

**Files:**
- Create: `src/content/tatar.ts`, `src/content/transcribe.ts`, `src/content/transcribe-exceptions.ts`
- Test: `test/content/tatar.test.ts`, `test/content/transcribe.test.ts`, `test/content/transcribe.table.ts`

**Interfaces:**
- Produces:
  - `hasTatarLetters(s: string): boolean` — есть хотя бы одна из ә ө ү җ ң һ
  - `isTatarText(s: string): boolean` — только буквы татарской кириллицы, цифры, пробел и знаки `.,!?:;-–—«»"'()…`
  - `isBackWord(word: string): boolean` — ряд слова по первой однозначной гласной (а о у ы → задний; ә ө ү и э → передний); слова только с я/ю/е: с «ь» на конце — передний, иначе задний
  - `transcribe(text: string): string` — чистая функция, никогда не бросает
  - `EXCEPTIONS: Readonly<Record<string, string>>` — слово в нижнем регистре → готовая транскрипция

**Правила** (порядок применения):
1. Слово из `EXCEPTIONS` возвращается оттуда.
2. Текст делится на слова; не-кириллические куски и пунктуация остаются как есть; регистр → нижний.
3. к, г → `къ`, `гъ`, если гласная того же слога заднего ряда (перед а о у ы или в конце слога после них); иначе `к`, `г`. Уже написанные `къ`, `гъ` сохраняются.
4. Арабский рисунок «согласный + а + согласный + ь» в слове с передними гласными: `а → ә`, предшествующие к/г → `къ`/`гъ`, `ь` не пишется (сәгать → сәгъәт, кәгазь → кәгъәз).
5. в → `w`; у, ү после гласной → `w`.
6. я, ю, е в начале слова и после гласной, ъ или ь: `й` + гласная по ряду слова (я → а/ә, ю → у/ү, е → ы/е).
7. ь, ъ между согласной и гласной → `ʼ`; в остальных позициях не пишутся. э после гласной → `ʼ` (тәэсир → тәʼсир).
8. Ударение на последней гласной; в односложных не ставится.

- [ ] **Step 1: Таблица и падающие тесты**

`transcribe.table.ts` экспортирует `TABLE: [word: string, expected: string][]`, не меньше 80 строк. Обязательные строки:

```ts
["вакыт","wакъы́т"], ["сәгать","сәгъә́т"], ["яшь","йәш"], ["авыл","аwы́л"], ["ел","йыл"],
["китап","кита́п"], ["мәктәп","мәктә́п"], ["тау","таw"], ["дәү","дәw"], ["юл","йул"], ["юк","йукъ"],
["яңа","йаңа́"], ["яшел","йәше́л"], ["уку","укъу́"], ["кәгазь","кәгъә́з"], ["һава","һаwа́"],
["давыл","даwы́л"], ["сыер","сыйы́р"], ["дөнья","дөнйа́"], ["мәсьәлә","мәсʼәлә́"], ["тәэсир","тәʼси́р"],
["кайда","къа́йда"], ["ничек","ни́чек"], ["бүген","бү́ген"], ["әлбәттә","әлбә́ттә"], ["сәлам","сәлә́м"],
```
Остальные строки добирает исполнитель так, чтобы на каждое правило 3–8 было не меньше шести слов, и не меньше 15 строк приходилось на исключения (вопросительные слова, отрицание, заимствования с «в» как [в]). Строки, в которых исполнитель не уверен, помечаются комментарием `// verify` и попадают владельцу на остановке G3.

```ts
it.each(TABLE)("%s → %s", (word, expected) => expect(transcribe(word)).toBe(expected));
it("has at least 80 reference words", () => expect(TABLE.length).toBeGreaterThanOrEqual(80));
it("transcribes phrases word by word and keeps punctuation", () => expect(transcribe("Исәнмесез! Хәлләр ничек?")).toBe("исәнмесе́з! хәллә́р ни́чек?"));
it("never throws and leaves non-Tatar input as is", () => {
  for (const s of ["", "   ", "hello", "123", "🙂", "wifi роутер", "а".repeat(500)]) expect(() => transcribe(s)).not.toThrow();
  expect(transcribe("hello")).toBe("hello"); expect(transcribe("")).toBe("");
});
it("detects Tatar letters and look-alikes", () => {
  expect(hasTatarLetters("әни")).toBe(true); expect(hasTatarLetters("эни")).toBe(false);
  expect(isTatarText("Һава яхшы.")).toBe(true);
  expect(isTatarText("hава")).toBe(false);   // латинская h
  expect(isTatarText("əни")).toBe(false);    // латинская ə U+0259
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Реализовать три модуля.
- [ ] **Step 4:** Run `pnpm test test/content` → PASS.
- [ ] **Step 5:** Commit `feat(content): Tatar school transcription`.

### Task 6: Тексты на татарском, части речи, настройки, справка

**Files:**
- Modify: `src/i18n/ru.ts`, `src/i18n/tt.ts`, `src/i18n/index.ts`, `src/bot/screens.ts` (`renderSettings`, `deckTitle`), `src/users/service.ts` (`setSetting`), `src/bot/bot.ts` (`set:lang`, `set:dir`), `scripts/set-webhook.ts`
- Test: `test/i18n/dict.test.ts`, `test/bot/views.test.ts`

**Interfaces:**
- Consumes: `isTatarText` (задача 5).
- Produces: новые ключи `Dict`:
  - `posName(code: string): string` — ru: сущ., гл., прил., нареч., мест., числ., послелог, союз, частица, межд., фраза; tt: исем, фигыль, сыйфат, рәвеш, алмашлык, сан, бәйлек, теркәгеч, кисәкчә, ымлык, гыйбарә; неизвестный код возвращается как есть
  - `levelTitle(n: number): string` — ru «Уровень 3»; tt «3 нче дәрәҗә», суффикс `нчы` для 6, 9, 10, 16, 19, иначе `нче`
  - `setLang` — «🌐 Язык: Русский» / «🌐 Тел: Татарча»; `setDir(d)` — «татарский → русский», «русский → татарский», «оба»
  - `help` дополнен строкой источников: корпус corpus.tatar, Tatoeba (CC BY 2.0 FR), озвучка (заполняется по `data/voice.json` в задаче 15)
- Produces: `dict(lang: Lang): Dict` возвращает `ru` или `tt`; команды бота регистрируются на двух языках (`language_code: "tt"`).

- [ ] **Step 1: Падающие тесты**

```ts
it("has a Tatar text for every key, different from Russian", () => {
  const same = Object.keys(ru).filter((k) => typeof ru[k] === "string" && ru[k] === tt[k] && /[а-яё]{3}/i.test(ru[k]));
  expect(same).toEqual([]);
});
it("writes Tatar texts with Tatar letters only", () => {
  const LATIN_OK = /AI|Tatoeba|CC BY 2\.0 FR|corpus\.tatar|UTC/g;
  for (const [k, v] of Object.entries(tt)) {
    const text = typeof v === "string" ? v : (v as (...a: never[]) => string)(...(SAMPLE_ARGS[k] as never[]));
    expect(isTatarText(text.replace(/<[^>]+>|\/\w+|\p{Extended_Pictographic}|[\n·≈%№~+→↑]/gu, "").replace(LATIN_OK, "")), k).toBe(true);
  }
});
it("builds Tatar ordinals", () => {
  expect([1, 6, 9, 10, 16, 19, 20].map((n) => tt.levelTitle(n))).toEqual(
    ["1 нче дәрәҗә", "6 нчы дәрәҗә", "9 нчы дәрәҗә", "10 нчы дәрәҗә", "16 нчы дәрәҗә", "19 нчы дәрәҗә", "20 нче дәрәҗә"]);
});
it("names parts of speech in the interface language", () => {
  expect(ru.posName("n")).toBe("сущ."); expect(tt.posName("v")).toBe("фигыль"); expect(ru.posName("zzz")).toBe("zzz");
});
```
`SAMPLE_ARGS` — таблица в тесте: образцовые аргументы для каждого ключа-функции.
Тест настроек: `set:lang` переключает `ru ↔ tt`; `setSetting(repo, id, "lang", "en")` бросает; `set:dir` идёт по кругу `tt_ru → ru_tt → both`.

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Написать `tt.ts` (`export const tt: Dict = { … }`), обновить `ru.ts`: название «Кабатла», «английские слова» → «татарские слова», пример в `helpAdd` — `<code>рәхмәт</code>`, приветствие без английской строки, кнопки языка «Русский» и «Татарча».
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(i18n): Tatar interface, parts of speech, settings`.

### Task 7: Очередь новых слов

**Files:**
- Modify: `src/db/repo.ts` (`candidateCards`), `src/review/service.ts`
- Test: `test/db/repo.test.ts`, `test/review/service.test.ts`

**Interfaces:**
- Produces: `Candidates.counts.easyNewToday: number`; `export const EASY_NEW_CAP = 200` (`src/review/service.ts`).
- Изменения запроса новых слов и счётчика `new_available` (число обращений к D1 не меняется):
  - порядок: `ORDER BY (dk.kind = 'catalog'), COALESCE(dk.level_no, 0), n.id, d.value` — свои слова и AI-колоды, затем уровни по номеру;
  - слово каталога пропускается, если в колодах, принадлежащих пользователю (`decks.owner_id = user`), есть заметка с тем же `word_key`;
  - `new_done_today`: `was_new = 1 AND rating < 4 AND undone = 0`; `easy_new_today`: то же с `rating = 4`.
- `newLeft = easyNewToday >= EASY_NEW_CAP ? 0 : max(0, newPerDay − newDoneToday)`.

- [ ] **Step 1: Падающие тесты**

```ts
it("gives own and AI words before level words, levels by number", async () => {
  const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 2 });           // l01: китап, вакыт
  const l2 = (await seedLevels(env.DB, { 2: ["авыл"] }))[2]!; await repo.subscribe(user.id, l2, now);
  const own = await repo.customDeck(user.id, now);
  await repo.insertNotes(own, [note("рәхмәт")]);                                         // добавлено позже всех
  const c = await repo.candidateCards(user.id, now, { ...dayWindow(180, now), directions: ["tt_ru"] });
  expect(c.newNotes.map((n) => n.word)).toEqual(["рәхмәт", "китап", "вакыт", "авыл"]);
});
it("skips a level word the user already has among own words", async () => {
  const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 2 });
  await repo.insertNotes(await repo.customDeck(user.id, now), [note("Китап")]);
  const c = await repo.candidateCards(user.id, now, { ...dayWindow(180, now), directions: ["tt_ru"] });
  expect(c.newNotes.map((n) => n.word)).toEqual(["Китап", "вакыт"]);
  expect(c.counts.newAvailable).toBe(2);
});
it("does not spend the daily limit on a new word graded Easy", async () => {
  const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 12, patch: { newPerDay: 5 } });
  let s = await new ReviewService(repo, now).nextScreen(user);
  for (let i = 0; i < 3; i++) s = await gradeShown(repo, user, s, 4);
  expect(s.kind === "card" && s.counts.n).toBe(5);
  s = await gradeShown(repo, user, s, 3);
  expect(s.kind === "card" && s.counts.n).toBe(4);
});
it("stops new words after 200 Easy-on-first-sight grades in a day", async () => {
  const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 5 });
  await insertEasyNewLogs(env.DB, user.id, 200, now);
  const s = await new ReviewService(repo, now).nextScreen(user);
  expect(s.kind).not.toBe("card");
});
```
`note(word)`, `gradeShown`, `insertEasyNewLogs` — помощники теста в том же файле.

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Изменить запросы и расчёт `newLeft`.
- [ ] **Step 4:** Run `pnpm test test/db test/review` → PASS; тест бюджета D1 на оценку по-прежнему зелёный.
- [ ] **Step 5:** Commit `feat(review): new-word order, Easy outside the daily limit`.

### Task 8: Уровни

**Files:**
- Modify: `src/db/repo.ts`, `src/review/service.ts`, `src/stats/service.ts`, `src/bot/{bot,views,screens}.ts`, `src/i18n/{ru,tt}.ts`
- Test: `test/review/levels.test.ts`, `test/bot/levels.test.ts`, `test/stats/service.test.ts`

**Interfaces:**
- Consumes: `seedLevels`, `Candidates` (задачи 4, 7); `levelTitle` (задача 6).
- Produces (`repo.ts`):
  - `candidateCards(userId, now, opts, pre?: D1PreparedStatement[]): Promise<Candidates & { pre: D1Result[] }>` — `pre` выполняются в том же batch перед четырьмя запросами
  - `openLevelStmts(userId: number, from: number, to: number, now: number): D1PreparedStatement[]` — три выражения по порядку: подписка на колоду уровня `to` (`INSERT OR IGNORE … SELECT`, ничего не делает при `to = 21`); `UPDATE users SET level = to WHERE id = ? AND level = from AND (to = 21 OR EXISTS (SELECT 1 FROM decks WHERE level_no = to))`; `SELECT coverage_pct FROM decks WHERE level_no = from`
  - ключи `Dict`: `levelUp(from: number, to: number, pct: number | null): string`, `levelsDone(pct: number | null): string`
  - `levelsOverview(userId: number): Promise<{ levelNo: number; total: number; coveragePct: number | null; open: boolean; seen: number }[]>` — один запрос; `seen` — заметки уровня с карточкой не в состоянии `new` плюс пропущенные как дубли своих слов
  - `openSkippedLevels(userId: number, now: number): Promise<number>` — подписывает на все уровни с `level_no < users.level`, возвращает число открытых
- Produces (`review/service.ts`):
  - `export const LAST_LEVEL = 20`
  - `export interface LevelUp { from: number; to: number | null; coveragePct: number | null }`
  - варианты `card` и `done` типа `Screen` получают поле `levelUp: LevelUp | null`
- Produces (`bot`): команда `/levels` и callback `levels` (вместо `/decks`, `decks`, `sub:<id>`), callback `lv:skip`; `renderLevels(v: LevelsView, lang): Rendered`; `renderLevelUp(l: LevelUp, lang): string`; кнопка `decksBtn` → «📚 Уровни».
- Produces (`stats`): `Cumulative.level: number`, `Cumulative.coveragePct: number | null` (покрытие уровня `level − 1`).

**Алгоритм `nextScreen`.** После первого `candidateCards`: если `counts.newAvailable === 0`, `newLeft > 0` и `user.level ≤ LAST_LEVEL`, вызвать `candidateCards` ещё раз с `pre = openLevelStmts(user.id, user.level, user.level + 1, now)`. Если `UPDATE` изменил строку — `levelUp = { from: level, to: level < 20 ? level + 1 : null, coveragePct }`, дальше работа идёт с новым набором кандидатов. Если не изменил — `levelUp = null`. Сообщение об уровне ставится первой строкой текста карточки или экрана «на сейчас всё».

**Тексты (ru).** Переход: «Все 100 слов уровня 3 в работе. Открываю уровень 4. Пройденные слова покрывают ≈54% обычного текста» (последнее предложение опускается, если покрытия нет). После уровня 20: «Все 2 000 слов в работе! 🎉 Дальше — повторения по расписанию. Свои слова можно добавлять в любой момент.»

`/levels` (ru):
```
📚 <b>Уровни</b>
✅ Пройдено: 1–3
▶️ Уровень 4 · 37 из 100
🔒 Впереди: 16
📝 Мои слова · 12
🤖 Путешествия · 20
📖 Покрытие текста ≈54%
[Открыть пропущенные (1–6)]      ← только если есть неоткрытые уровни ниже текущего
```

- [ ] **Step 1: Падающие тесты** (`test/review/levels.test.ts`)

```ts
it("opens the next level exactly once when the open levels run out", async () => {
  const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 2 });
  await seedLevels(env.DB, { 2: ["авыл", "су"] }, { 1: 31 });
  let s = await new ReviewService(repo, now).nextScreen(user);
  s = await gradeShown(repo, user, s, 4); s = await gradeShown(repo, await repo.getUser(user.id), s, 4);
  expect(s.kind === "card" && s.levelUp).toEqual({ from: 1, to: 2, coveragePct: 31 });
  expect(s.kind === "card" && s.view.word).toBe("авыл");
  const again = await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!);
  expect(again.kind === "card" && again.levelUp).toBeNull();
  expect((await repo.getUser(user.id))!.level).toBe(2);
});
it("two concurrent calls announce the level once", async () => {
  /* тот же сид; оба слова уровня 1 оценены; два nextScreen через Promise.all с одним и тем же user */
  expect(screens.filter((s) => s.kind === "card" && s.levelUp).length).toBe(1);
});
it("does not open a level while the daily limit is used up", async () => { /* newPerDay 5, оценено 5 «Хорошо», новых в уровне нет → levelUp null, level остаётся 1 */ });
it("stays on the level when the next level is not in the database", async () => {
  /* есть только l01, все слова показаны */ expect(s.kind).toBe("done"); expect(user.level).toBe(1);
});
it("congratulates once after level 20", async () => {
  /* level 20 с покрытием 80, слова показаны */ expect(s.levelUp).toEqual({ from: 20, to: null, coveragePct: 80 });
  /* повторный вызов */ expect(s2.levelUp).toBeNull(); expect(user.level).toBe(21);
});
it("keeps the level open after undo and does not announce it again", async () => {
  /* открыть уровень 2 оценкой последнего слова уровня 1 → undo → снова оценить то же слово */
  expect(afterUndo.kind === "card" && afterUndo.view.word).toBe("вакыт");
  expect(regraded.kind === "card" && regraded.levelUp).toBeNull();
  expect((await repo.getUser(user.id))!.level).toBe(2);
});
it("after opening skipped levels gives their words first and opens level 8 only when they are done", async () => {
  /* старт с уровня 7, openSkippedLevels → первая новая карточка из уровня 1; users.level остаётся 7 */
});
it("spends at most 8 D1 calls on a grade that opens a level", async () => { /* countingDb через harness */ });
```
`test/bot/levels.test.ts`: `/levels` для пользователя на уровне 4 со стартом с 4 показывает строки из образца и кнопку «Открыть пропущенные (1–3)»; после `lv:skip` кнопки нет; текст карточки после перехода начинается со строки об уровне; `/decks` отвечает как неизвестная команда.
`test/stats`: `/stats` содержит «Уровень 4» и «≈54%».

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Реализовать репозиторий, сервис, экраны и тексты (ru и tt).
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck && pnpm depcruise` → PASS.
- [ ] **Step 5:** Commit `feat(levels): automatic level-up, /levels, coverage`.

### Task 9: Онбординг

**Files:**
- Modify: `src/users/placement.ts`, `src/users/service.ts`, `src/bot/screens.ts`, `src/bot/bot.ts`, `src/i18n/{ru,tt}.ts`
- Test: `test/users/service.test.ts`, `test/bot/handlers.test.ts`

**Interfaces:**
- Consumes: `seedLevels`, `ReviewService.nextScreen`.
- Produces:
  - `PLACEMENT: readonly { word: string; level: number }[]` — 10 слов, уровни по порядку `1, 1, 2, 3, 4, 6, 8, 10, 13, 16`. До задачи 14 слова временные: `бар, юк, су, өй, вакыт, авыл, сәяхәт, тәҗрибә, мөнәсәбәт, җәмгыять`; задача 14 заменяет их словами из готовых уровней
  - `placementLevel(known: number): number` — 0–2 → 1, 3–4 → 2, 5–6 → 4, 7–8 → 7, 9–10 → 10
  - `OnboardingScreen`: варианты `deck`, `deckList` удалены; `goal: { kind: "goal"; level: number; known: number }`; `finished: { kind: "finished"; remindAt: string; tzOffsetMin: number; level: number }`
  - шаги: `lang → placement → goal → remind → tz → null`. Ответ на шаге `tz` подписывает на колоду стартового уровня, пишет `users.level`, ставит `nextDailyAt`, `nextEveningAt`
  - после `finished` бот превращает сообщение с вопросом о времени в текст завершения с подсказкой «Если слово знаете, жмите „Легко“» (`editMessageText`; при ответе текстом — новое сообщение) и сразу отправляет первую карточку

- [ ] **Step 1: Падающие тесты**

```ts
it.each([[0, 1], [2, 1], [3, 2], [4, 2], [5, 4], [6, 4], [7, 7], [8, 7], [9, 10], [10, 10]])("%i known → level %i", (k, l) => expect(placementLevel(k)).toBe(l));
it("tests ten words from levels 1,1,2,3,4,6,8,10,13,16", () => expect(PLACEMENT.map((p) => p.level)).toEqual([1, 1, 2, 3, 4, 6, 8, 10, 13, 16]));
it("finishes onboarding on the time-zone step and opens only the start level", async () => {
  await seedLevels(env.DB, { 1: ["бер"], 4: ["дүрт"] });
  /* lang=tt, 5 «знаю», goal 10, 09:00, tz 180 */
  expect(screen).toEqual({ kind: "finished", remindAt: "09:00", tzOffsetMin: 180, level: 4 });
  expect(await repo.userDeckIds(user.id)).toEqual([deckIds[4]]);
  expect((await repo.getUser(user.id))!.onboardingStep).toBeNull();
});
it("sends the hint and the first card right after the last answer, within budget", async () => {
  /* через harness, интерфейс tt */
  expect(textsOfUpdate.join("\n")).toContain(tt.easyHint); expect(textsOfUpdate.at(-1)).toContain("дүрт");
  expect(telegramCalls).toBeLessThanOrEqual(3); expect(d1Calls).toBeLessThanOrEqual(8);
});
it("offers Русский and Татарча on the first step", async () => { /* кнопки ob:ru, ob:tt; ob:en отклоняется */ });
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Реализовать; ключ `easyHint` в `ru` и `tt`.
- [ ] **Step 4:** Run `pnpm test test/users test/bot` → PASS.
- [ ] **Step 5:** Commit `feat(onboarding): placement to start level, no deck step`.

### Task 10: Карточка и жалобы

**Files:**
- Modify: `src/bot/views.ts`, `src/bot/bot.ts`, `src/db/repo.ts`, `src/admin/service.ts`, `src/i18n/{ru,tt}.ts`
- Test: `test/bot/views.test.ts`, `test/bot/handlers.test.ts`, `test/admin/service.test.ts`

**Interfaces:**
- Consumes: `posName` (задача 6), `CardView` (задача 4).
- Produces:
  - `renderCard` — вторая строка `[транскрипция] · часть речи` на языке интерфейса; в направлении `ru_tt` под спойлером слово и транскрипция; третий ряд кнопок: 🔊 (если есть озвучка), «↩️ Отменить» (если есть что отменять), ⚑ (всегда)
  - callback `r:<noteId>`
  - `Repo.insertReport(userId: number, noteId: number, now: number): Promise<boolean>` — `false`, если жалоба уже была
  - `Repo.recentReports(limit: number): Promise<{ noteId: number; word: string; translation: string; count: number; lastAt: number }[]>`
  - `adminStatsText` дополнен блоком «Жалобы ⚑» из 10 последних слов
  - ключи `reportSent`, `reportAlready`

- [ ] **Step 1: Падающие тесты**

```ts
it("shows transcription in brackets and the part of speech in the interface language", () => {
  const r = renderCard(view({ word: "вакыт", transcription: "wакъы́т", pos: "n" }), counts, intervals, false, "ru");
  expect(r.text).toContain("<b>вакыт</b>\n[wакъы́т] · <i>сущ.</i>");
  expect(renderCard(view({ pos: "n" }), counts, intervals, false, "tt").text).toContain("<i>исем</i>");
});
it("hides the word and transcription under the spoiler in ru→tt", () => {
  const r = renderCard(view({ direction: "ru_tt", word: "вакыт", transcription: "wакъы́т", translation: "время" }), counts, intervals, false, "ru");
  expect(r.text).toContain("<b>время</b>\n<tg-spoiler><b>вакыт</b> [wакъы́т]</tg-spoiler>");
});
it("always has the report button; voice and undo only when available", () => {
  expect(renderCard(view({ hasAudio: false }), counts, intervals, false, "ru").keyboard[2]!.map((b) => b.callback_data)).toEqual(["r:7"]);
  expect(renderCard(view({ hasAudio: true }), counts, intervals, true, "ru").keyboard[2]!.map((b) => b.callback_data)).toEqual(["v:7", "u", "r:7"]);
});
it("stores one report per user and word and notifies the admin once", async () => {
  /* два нажатия r:<id> */ expect(adminMessages.length).toBe(1); expect(adminMessages[0].text).toContain("китап");
  expect(answers).toEqual([ru.reportSent, ru.reportAlready]);
  expect((await repo.recentReports(10))[0]).toMatchObject({ word: "китап", count: 1 });
});
it("keeps the report when the admin cannot be reached", async () => { /* sendMessage админу падает → ответ пользователю reportSent, строка в reports есть */ });
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Реализовать. Жалоба: `answerCallbackQuery` и одно `sendMessage` админу (слово, перевод, пример, id пользователя); карточка не перерисовывается.
- [ ] **Step 4:** Run `pnpm test test/bot test/admin` → PASS.
- [ ] **Step 5:** Commit `feat(bot): transcription on the card, report button`.

### Task 11: Свои слова и AI-колоды

**Files:**
- Modify: `src/content/llm.ts`, `src/content/service.ts`, `src/db/repo.ts`, `src/bot/views.ts` (`renderAddPreview`), `src/bot/screens.ts` (`renderGenPreview`), `src/i18n/{ru,tt}.ts`
- Test: `test/content/llm.test.ts`, `test/content/service.test.ts`

**Interfaces:**
- Consumes: `transcribe`, `hasTatarLetters` (задача 5); порядок очереди и пропуск дублей (задача 7).
- Produces:

```ts
// llm.ts
export const WordCardSchema: z.ZodType<{ input: string; lang: "tt" | "ru"; word: string; pos: string; translation: string; exampleTt: string; exampleRu: string }>;
// service.ts
export interface CardDraft {
  word: string; transcription: string | null; pos: string; translation: string; exampleTt: string; exampleRu: string;
  exampleSrc: string; audioFileId: string | null; sourceUrl: string | null; ai: boolean;
}
// repo.ts
findCatalogNotes(words: string[]): Promise<Map<string, NoteRow & { levelNo: number }>>   // один запрос, ключ — wordKey
```
- Правила схемы: `translation` и `exampleRu` содержат кириллицу и не содержат ә ө ү җ ң һ; `word` и `exampleTt` проходят `isTatarText`; `exampleTt ≠ exampleRu`; `pos` вне списка кодов → `""`.
- Подсказка `WORDS_SYSTEM`: для каждой строки определить язык; для русского ввода дать татарское слово; для татарского восстановить написание с ә ө ү җ ң һ; глагол привести к форме на -у/-ү; вернуть `input` дословно. `DECK_SYSTEM`: тематическая колода татарских слов для русскоязычных, те же поля.
- Порядок `prepareAdd`: дубли в колодах пользователя → `findCatalogNotes` по введённому → нейросеть для остальных → `findNotesForUser` и `findCatalogNotes` по восстановленным словам → превью. Карточка из каталога: `ai: false`, все поля и `audioFileId` из каталога. Карточка нейросети: `ai: true`, `exampleSrc: "ai"`, `transcription: transcribe(word)`. Если ввод содержит татарские буквы, а `word` от нейросети отличается от ввода — сохраняется написание пользователя.
- Превью с хотя бы одной карточкой `ai` заканчивается строкой «перевод сделан AI, проверьте» (ключ `aiNote`).
- `confirmAdd` больше не ставит задач озвучки и возвращает `{ words: string[] }`.

- [ ] **Step 1: Падающие тесты**

```ts
it("accepts a Tatar card and rejects a Russian sentence in exampleTt's place", () => {
  expect(WordCardSchema.safeParse({ input: "эни", lang: "tt", word: "әни", pos: "n", translation: "мама", exampleTt: "Әни өйдә.", exampleRu: "Мама дома." }).success).toBe(true);
  expect(WordCardSchema.safeParse({ input: "әни", lang: "tt", word: "әни", pos: "n", translation: "әни", exampleTt: "Әни өйдә.", exampleRu: "Мама дома." }).success).toBe(false);
  expect(WordCardSchema.safeParse({ input: "әни", lang: "tt", word: "əни", pos: "n", translation: "мама", exampleTt: "Әни өйдә.", exampleRu: "Мама дома." }).success).toBe(false);
});
it("takes a ready card from a level that is not open yet, without calling the AI", async () => {
  const { repo, user } = await seedUser(env.DB, { now, level: 1 }); await seedLevels(env.DB, { 5: ["бәхет"] });
  const r = await service(repo, failingLlm).prepareAdd(user, "бәхет", []);
  expect(r.kind === "preview" && r.items[0]).toMatchObject({ word: "бәхет", translation: "бәхет-ru", ai: false });
});
it("does not show the word twice when its level opens later", async () => {
  /* confirmAdd «бәхет» → подписка на уровень 5 → candidateCards */ expect(c.newNotes.filter((n) => n.word === "бәхет").length).toBe(1);
});
it("finds the catalog card after the AI restores Tatar letters", async () => {
  await seedLevels(env.DB, { 5: ["әни"] });
  const r = await service(repo, llmReturning([{ input: "эни", lang: "tt", word: "әни", pos: "n", translation: "мать", exampleTt: "Әни килде.", exampleRu: "Мама пришла." }])).prepareAdd(user, "эни", []);
  expect(r.kind === "preview" && r.items[0]).toMatchObject({ word: "әни", translation: "әни-ru", ai: false });
});
it("reports a duplicate when the restored word is already being learned", async () => { /* «өй» в открытом уровне 1, ввод «ой», нейросеть вернула «өй» → duplicates-only */ });
it("keeps the user's spelling when the input already had Tatar letters", async () => {
  /* ввод «күңел», нейросеть вернула word: «кунел» */ expect(item.word).toBe("күңел");
});
it("gives a Tatar word for Russian input and transcribes it by the rules", async () => {
  /* ввод «спасибо» → word «рәхмәт» */ expect(item).toMatchObject({ word: "рәхмәт", transcription: transcribe("рәхмәт"), ai: true, exampleSrc: "ai" });
});
it("marks an AI preview and leaves a catalog-only preview unmarked", () => { /* renderAddPreview */ });
it("asks for a manual translation when the AI is down and still transcribes the word", async () => { /* completeManual → notes.transcription = transcribe(word) */ });
it("builds an AI deck with transcriptions and no audio jobs", async () => { /* generateDeck → confirmDeck; jobs пуст */ });
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck && pnpm depcruise` → PASS.
- [ ] **Step 5:** Commit `feat(content): catalog lookup, Tatar-aware AI cards`.

---

## Этап C. Словарь и озвучка

### Task 12: Скрипты словаря

**Files:**
- Create: `scripts/lib/levels.ts`, `scripts/lib/tatar-verbs.ts`, `scripts/build-wordlist.ts`, `scripts/validate-levels.ts`, `scripts/csv-to-sql.ts`, `test/helpers/seedSql.ts`
- Modify: `src/content/csv.ts` (`csvToSql`), `.github/workflows/ci.yml` (+ `npx tsx scripts/validate-levels.ts`), `package.json` (`"validate": "tsx scripts/validate-levels.ts"`)
- Test: `test/scripts/levels.test.ts`, `test/scripts/verbs.test.ts`, `test/seed.test.ts`

**Interfaces:**
- Consumes: ветка `sources` (задача 2); `transcribe`, `isTatarText` (задача 5); `PLACEMENT` (задача 9).
- Produces:
  - `verbInfinitive(stem: string): string`
  - `CSV_HEADER`, `levelFile(n: number): string` (`l01.csv`), `readLevel(n)`, `writeLevel(n, rows)`, `readMeta(): { level: number; coveragePct: number }[]`
  - `checkLevels(levels: Row[][], opts: { attested: Set<string>; placement: typeof PLACEMENT; expectLevels: number }): string[]` — список нарушений вида `l01:5 <что не так>` (номер — строка файла, заголовок — строка 1), пустой при успехе
  - `coverage(levels: { count: number }[][], cognates: { count: number }[], total: number): number[]`
  - `csvToSql(meta: { slug: string; titleRu: string; titleTt: string; levelNo: number; coveragePct: number | null }, rows: Record<string, string>[]): string` — по одному выражению в строке; колода обновляется по `slug`, заметка по `(deck_id, word_key)` со всеми полями, кроме озвучки: `audio_file_id = COALESCE(NULLIF(excluded.audio_file_id, ''), notes.audio_file_id)`; `decks.total` пересчитывается
- Файлы данных:
  - `data/wordlist.csv`: `word, pos, translation, example_tt, example_ru, example_src, count, origin, transcription` — `origin`: `corpus` или `core`; `transcription` заполняется только когда правило ошиблось; **порядок строк = порядок изучения**
  - `data/core.csv`: `word, pos, group` — бытовое ядро, около 300 строк, из них около 60 `phr`
  - `data/attested.txt`: словоформы примеров, найденные в `wordforms.txt.gz`; `data/attested-extra.txt`: формы, одобренные вручную (имена)
  - `data/work/` (не в git): `candidates.tsv`, `cognates.json`, `review.tsv`, `tat-rus.dix`
- Подкоманды `build-wordlist`:
  - `candidates` — слить `lemmas.tsv` по частоте; убрать леммы с цифрами, латиницей, заглавной буквой, длиной 1, отсутствующие в словоформах (для глаголов проверяется форма `verbInfinitive`); глаголы привести к -у/-ү; дописать переводы Apertium; вывести первые 3 500 в `candidates.tsv`
  - `examples <слово>` — пары Tatoeba с формой слова, от коротких к длинным, не длиннее 8 слов
  - `cut` — из `wordlist.csv` собрать `l01…l20.csv` (транскрипция: колонка или `transcribe`; существующий `audio_file_id` сохраняется по слову) и `meta.json`; обновить `attested.txt`
  - `review` — `review.tsv`: перевод без общих слов с Apertium; токен примера вне `attested`; пример без формы слова
- Покрытие уровня N: (сумма `count` слов уровней 1…N + сумма `count` убранных совпадающих с русским, у которых `count` не меньше минимального в уровне N) / сумма частот корпуса, в процентах, целое.
- Правила `checkLevels`: ровно `expectLevels` файлов по 100 строк; заголовок как в Global Constraints; `pos` из списка кодов; `word`, `translation` непусты; пример обязателен для всех, кроме `phr`; `word`, `example_tt`, `transcription` проходят `isTatarText` (в транскрипции дополнительно разрешены `w`, `ʼ`, U+0301); нет дублей `wordKey` внутри и между уровнями; `example_src` — `own` или `tatoeba:<число>`; каждый токен `example_tt` есть в `attested`; пример содержит токен, начинающийся с основы слова (для `v` — слово без конечного у/ү; для остальных — первые `max(3, длина − 2)` букв); каждое слово `data/core.csv` стоит в уровнях 1–4; в уровнях 1–3 не меньше 55 строк `phr`; каждое слово `PLACEMENT` стоит в своём уровне.

- [ ] **Step 1: Падающие тесты**

```ts
it.each([["бар","бару"], ["кил","килү"], ["аша","ашау"], ["эшлә","эшләү"], ["укы","уку"], ["төзе","төзү"], ["куй","кую"], ["сөй","сөю"], ["ки","кию"]])("%s → %s", (s, inf) => expect(verbInfinitive(s)).toBe(inf));
it("reports every violation with level and row", () => {
  const bad = fixtureLevels(); bad[0]![3]!.word = "hава"; bad[1]![0]!.word = bad[0]![0]!.word; bad[0]![5]!.example_tt = "Бу — кыйшыксүз.";
  const errs = checkLevels(bad, { attested, placement: [], expectLevels: 2 });
  expect(errs).toEqual(expect.arrayContaining([expect.stringMatching(/l01:5 .*букв/), expect.stringMatching(/l02:2 .*дубль/), expect.stringMatching(/l01:7 .*кыйшыксүз/)]));
});
it("passes a clean fixture", () => expect(checkLevels(fixtureLevels(), { attested, placement: [], expectLevels: 2 })).toEqual([]));
it("computes cumulative coverage with removed cognates", () =>
  expect(coverage([[{ count: 300 }, { count: 200 }], [{ count: 100 }]], [{ count: 250 }, { count: 50 }], 2000)).toEqual([38, 43]));
```
`test/seed.test.ts` (D1):
```ts
it("reseeding fixes card fields but keeps progress and audio", async () => {
  await applySeed(env.DB, csvToSql(meta1, [{ word: "китап", translation: "книга", audio_file_id: "AUD1", /* … */ }]));
  /* пользователь оценил карточку «китап» */
  await applySeed(env.DB, csvToSql(meta1, [{ word: "китап", translation: "книга, том", audio_file_id: "", /* … */ }]));
  expect(note).toMatchObject({ translation: "книга, том", audio_file_id: "AUD1" });
  expect(await countRows("cards")).toBe(1); expect(await countRows("notes")).toBe(1);
});
it("creates level decks with level_no, coverage and both titles", async () => {
  expect(deck).toMatchObject({ slug: "l06", level_no: 6, coverage_pct: 61, title_ru: "Уровень 6", title_tt: "6 нчы дәрәҗә", total: 1 });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Реализовать библиотеки и скрипты. `validate-levels.ts` в CI: пока `data/levels/` пуст, печатает «уровней нет» и завершается успешно; число ожидаемых уровней равно числу файлов; полные 20 требует флаг `--full`.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck` → PASS. Затем `git fetch origin sources`, распаковать в `data/work/sources/`, скачать словарь Apertium (`curl -L https://raw.githubusercontent.com/apertium/apertium-tat-rus/master/apertium-tat-rus.tat-rus.dix -o data/work/tat-rus.dix`), `npx tsx scripts/build-wordlist.ts candidates` → файл из 3 500 строк; посмотреть первые 50 и убедиться, что это частотные слова в словарной форме.
- [ ] **Step 5:** Commit `feat(scripts): wordlist build, level validation, catalog seed`.

### Task 13: Уровень 1 и вычитка

**Files:**
- Create: `data/core.csv`, `data/wordlist.csv` (первые 100 строк), `data/levels/l01.csv`, `data/levels/meta.json`, `data/attested.txt`, `docs/review/level-01.md`

**Interfaces:**
- Consumes: скрипты задачи 12; число пар Tatoeba из задачи 2.
- Produces: проверенный уровень 1; правила вычитки для задачи 14, дописанные в `docs/review/README.md`.

- [ ] **Step 1: Бытовое ядро.** Составить `data/core.csv`: семья, еда, дом, числа, время, цвета, приветствия, вопросительные слова, около 60 фраз (`phr`). Около 300 строк.
- [ ] **Step 2: Список кандидатов без совпадений.** Пройти `candidates.tsv` до ранга, дающего 2 600 слов; слова, перевод которых совпадает с самим словом, записать в `data/work/cognates.json` с их `count`.
- [ ] **Step 3: Первые 100 строк `wordlist.csv`.** Самые частотные слова вперемешку с ядром: не меньше 20 фраз и не меньше 30 слов ядра. Пример для каждого слова — сначала из `build-wordlist examples`, и только если подходящей пары нет, свой (`own`): 3–7 слов, бытовая ситуация, только слова из `attested`.
- [ ] **Step 4: Сборка и автопроверки.**

Run: `npx tsx scripts/build-wordlist.ts cut && npx tsx scripts/validate-levels.ts && npx tsx scripts/build-wordlist.ts review`
Expected: `validate-levels` без нарушений; `review.tsv` разобран до нуля строк (исправлено или обосновано в `attested-extra.txt`).

- [ ] **Step 5: Второй проход.** Свежий агент-проверяющий без доступа к рассуждениям автора получает `l01.csv` и правила спеки §4–§6. Проверяет все 100 строк: перевод, естественность примера, соответствие перевода примера, транскрипцию, написание. Замечания вносятся, шаг 4 повторяется.
- [ ] **Step 6: Остановка G3.** Собрать `docs/review/level-01.md` (таблица: слово, транскрипция, перевод, пример, перевод примера) и список татарских текстов интерфейса с русскими парами; отправить владельцу оба файла и строки таблицы транскрипций с пометкой `// verify`. Правки владельца внести; повторяющиеся виды ошибок записать правилами в `docs/review/README.md`.
- [ ] **Step 7:** Commit `feat(data): level 1, everyday core`.

### Task 14: Уровни 2–20

**Files:**
- Modify: `data/wordlist.csv` (до 2 000 строк), `data/levels/l02.csv … l20.csv`, `data/levels/meta.json`, `data/attested.txt`, `src/users/placement.ts`, `src/content/transcribe-exceptions.ts`, `test/content/transcribe.table.ts`
- Create: `scripts/check_transcription.py`

**Interfaces:**
- Consumes: правила из `docs/review/README.md` (остановка G3).
- Produces: 20 файлов уровней по 100 строк; `meta.json` с покрытием; `PLACEMENT` из настоящих слов уровней.

- [ ] **Step 1: Наполнение.** По два уровня за проход: автор пишет строки по порядку частоты (ядро заканчивается не позже уровня 4), затем `cut`, `validate-levels`, `review` до нуля. После каждой пары — коммит.
- [ ] **Step 2: Второй проход.** Для каждого уровня свежий проверяющий смотрит все строки, попадавшие в `review.tsv`, и 10 случайных (`shuf -n 10`); замечания вносятся.
- [ ] **Step 3: Сверка транскрипции с espeak-ng.** `scripts/check_transcription.py` (`pip install espeakng-loader phonemizer-fork`) для всех 2 000 слов сравнивает три признака: число слогов, место ударения, `къ/гъ` против `q/ʁ` и `w` против `v`. Расхождения в `data/work/transcription-diff.tsv`. Каждое расхождение разобрано: ошибка правила → исправить правило и добавить слово в таблицу тестов; исключение → в `transcribe-exceptions.ts`; ошибка espeak → оставить.
- [ ] **Step 4: Слова теста уровня.** Заменить временные слова `PLACEMENT` словами из уровней 1, 1, 2, 3, 4, 6, 8, 10, 13, 16 — существительные или прилагательные без совпадения с русским.
- [ ] **Step 5: Проверка.**

Run: `npx tsx scripts/build-wordlist.ts cut && npx tsx scripts/validate-levels.ts --full && pnpm test`
Expected: 20 уровней по 100 строк, нарушений нет, покрытие в `meta.json` растёт от уровня к уровню, тесты зелёные.

- [ ] **Step 6:** Commit `feat(data): levels 2–20, placement words, transcription exceptions`.

### Task 15: Озвучка каталога и своих слов

**Files:**
- Modify: `scripts/voice.ts` (подкоманды `catalog`, `db`), `src/i18n/{ru,tt}.ts` (источник озвучки в `help`)
- Create: `scripts/lib/voice-queue.ts`, `.github/workflows/voice-catalog.yml`, `.github/workflows/voice-db.yml`
- Test: `test/scripts/voice-queue.test.ts`

**Interfaces:**
- Consumes: `Tts`, `TtsError`, `speakable`, `sendVoice`, `toOgg` (задача 3); `data/voice.json` (остановка G2); `readLevel`, `writeLevel` (задача 12).
- Produces:
  - `voiceBatch(items: { id: number; word: string }[], deps: { tts: Tts; toOgg(w: Uint8Array): Promise<Uint8Array>; send(ogg: Uint8Array, caption: string): Promise<string> }): Promise<{ done: { id: number; fileId: string }[]; failed: number[] }>` — ошибка одного слова не прерывает остальные; непроизносимое слово сразу в `failed`
  - `resultSql(r: { done: { id: number; fileId: string }[]; failed: number[] }): string` — `UPDATE notes SET audio_file_id = '<id>' WHERE id = <n> AND audio_file_id IS NULL;` и `UPDATE notes SET audio_tries = audio_tries + 1 WHERE id = <n>;`. `fileId` обязан соответствовать `/^[A-Za-z0-9_-]+$/`, иначе слово уходит в `failed`
- `voice.ts catalog [--level N]`: для строк уровня без `audio_file_id` — синтез, отправка в `AUDIO_CHAT_ID` (или `ADMIN_TG_ID`, если канала нет) без звука (`disable_notification`), запись `file_id` в CSV после каждого уровня.
- `voice.ts db`: `wrangler d1 execute kabatla --remote --json --command "SELECT id, word FROM notes WHERE audio_file_id IS NULL AND audio_tries < 3 ORDER BY id LIMIT 200"`; если строк нет — выход; иначе `voiceBatch` и `wrangler d1 execute --file`.
- `voice-catalog.yml`: `workflow_dispatch`; по окончании коммитит `data/levels/*.csv`. `voice-db.yml`: `schedule: "17 */6 * * *"` и `workflow_dispatch`; первым шагом запрашивает число слов и завершает задачу, если их нет, до установки ffmpeg и моделей.

- [ ] **Step 1: Падающие тесты**

```ts
it("voices what it can and reports the rest as failed", async () => {
  const tts = { synth: async (t: string) => { if (t === "сбой") throw new TtsError("500"); return new Uint8Array(1); } };
  const r = await voiceBatch([{ id: 1, word: "сәлам" }, { id: 2, word: "сбой" }, { id: 3, word: "🙂" }, { id: 4, word: "x".repeat(300) }, { id: 5, word: "рәхмәт" }],
    { tts, toOgg: async (w) => w, send: async (_o, c) => `F_${c.length}` });
  expect(r.done.map((d) => d.id)).toEqual([1, 5]); expect(r.failed).toEqual([2, 3, 4]);
});
it("builds SQL only from numeric ids and safe file ids", () => {
  const sql = resultSql({ done: [{ id: 1, fileId: "AwACAg_x-1" }, { id: 2, fileId: "a'; DROP TABLE notes;--" }], failed: [3] });
  expect(sql).toContain("UPDATE notes SET audio_file_id = 'AwACAg_x-1' WHERE id = 1 AND audio_file_id IS NULL;");
  expect(sql).not.toContain("DROP"); expect(sql).toContain("audio_tries = audio_tries + 1 WHERE id = 2;");
  expect(sql).toContain("audio_tries = audio_tries + 1 WHERE id = 3;");
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Реализовать очередь, подкоманды и оба workflow.
- [ ] **Step 4:** Run `pnpm test test/scripts && pnpm typecheck` → PASS.
- [ ] **Step 5: Озвучить каталог.** Commit, push, `gh workflow run voice-catalog.yml && gh run watch --exit-status`; затем `git pull`.

Run: `grep -c ',$' data/levels/l*.csv`
Expected: 0 строк без `audio_file_id` во всех 20 файлах; при остатке запустить workflow ещё раз (он продолжает с пропущенных).

- [ ] **Step 6:** Commit `feat(voice): catalog and own-word voicing in Actions`.

---

## Этап D. Запуск

### Task 16: Сценарный тест, покрытие, бюджеты

**Files:**
- Modify: `test/e2e/scenario.test.ts`, `vitest.config.ts`, `test/reminders/service.test.ts`
- Test: те же

**Interfaces:**
- Consumes: всё из этапа B; `seedLevels`.

- [ ] **Step 1: Сценарный тест**

```ts
it("Tatar interface: onboarding → 100 words of the level → level-up with coverage → a level 2 card", async () => {
  await seedLevels(env.DB, { 1: words100, 2: ["авыл"] }, { 1: 31 });
  /* /start → ob:tt → 10 ответов «белмим» → ob:20 → ob:09:00 → ob:180 */
  expect(lastText()).toContain(words100[0]);
  /* 100 раз нажать «Легко» (оценка 4) на показанной карточке */
  expect(lastText()).toContain(tt.levelUp(1, 2, 31)); expect(lastText()).toContain("авыл");
  expect(maxTelegramCallsPerUpdate).toBeLessThanOrEqual(3); expect(maxD1CallsPerUpdate).toBeLessThanOrEqual(8);
});
```
- [ ] **Step 2:** Run → FAIL или PASS; при FAIL чинить причину в модуле-владельце, не тест.
- [ ] **Step 3: Пороги покрытия** в `vitest.config.ts`:

```ts
coverage: { provider: "istanbul", include: ["src/**"], thresholds: {
  lines: 70, "src/srs/**": { lines: 90 }, "src/review/**": { lines: 90 }, "src/content/transcribe.ts": { lines: 90 } } }
```
- [ ] **Step 4: Тик.** Тест: в тике нет обработки задач `voice`; тик с 40 пользователями, которым пора напомнить, делает не больше 35 отправок и 10 обращений к D1.
- [ ] **Step 5:** Run `pnpm test:ci && pnpm typecheck && pnpm depcruise` → PASS, пороги выдержаны.
- [ ] **Step 6:** Commit `test: Tatar end-to-end scenario, coverage thresholds`.

### Task 17: Деплой и запуск

**Files:**
- Create: `.github/workflows/deploy.yml`, `.github/workflows/backup.yml` (копии из `bot-anki` с заменой `povtor → kabatla`), `docs/OPERATIONS.md`
- Modify: `scripts/set-webhook.ts` (команды `start, learn, levels, gen, stats, settings, undo, help` на `ru` и `tt`), `README.md`

**Interfaces:**
- Consumes: `scripts/csv-to-sql.ts`, `data/levels/*.csv`, секреты репозитория.

- [ ] **Step 1: Остановка G4.** Попросить владельца добавить секреты `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WEBHOOK_SECRET`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` (плюс уже введённые `BOT_TOKEN`, `ADMIN_TG_ID`; по желанию `AUDIO_CHAT_ID`). Если выбран голос speech.tatar — дать текст письма на dev@translate.tatar. Проверка: `gh secret list` показывает семь названий.
- [ ] **Step 2: Workflow деплоя.** Порядок шагов как в `bot-anki`: тесты → `validate-levels --full` → поддомен workers.dev → база `kabatla` → миграции → `csv-to-sql` → загрузка `seed/catalog.sql` → выкладка → секреты воркера → вебхук и команды.
- [ ] **Step 3:** Commit, push, `gh run watch --exit-status`.

Expected: деплой зелёный; в логе `getWebhookInfo` адрес воркера и `last_error_message: null`.

- [ ] **Step 4: Проверка в базе.** Последний шаг workflow деплоя печатает два числа:

Run: `wrangler d1 execute kabatla --remote --command "SELECT (SELECT COUNT(*) FROM decks WHERE level_no IS NOT NULL) AS levels, (SELECT COUNT(*) FROM notes n JOIN decks d ON d.id = n.deck_id WHERE d.kind = 'catalog' AND n.audio_file_id IS NOT NULL) AS voiced"`
Expected: `levels = 20`, `voiced = 2000`.

- [ ] **Step 5: Проверка в Telegram** (вместе с владельцем): `/start` на татарском интерфейсе → тест → первая карточка быстрее 60 секунд; на карточке транскрипция, пример, 🔊 играет; своё слово «рәхмәт» находится в каталоге; своё слово «спасибо большое» даёт превью с пометкой AI; ⚑ приходит админу; `/levels`, `/stats`, `/settings`, `/undo`, `/help` отвечают.
- [ ] **Step 6:** `docs/OPERATIONS.md`: секреты, как перевыпустить токен, как исправить слово (править CSV → push), как озвучить заново, как смотреть жалобы. Commit `docs: operations`.
