# Кабатла

Telegram-бот @Kabatlabot: учит русскоязычных татарским словам по интервальным повторениям (FSRS). Слова идут уровнями по 100, у каждой карточки есть транскрипция, пример и озвучка.

Стек: Cloudflare Workers, база D1, grammy, ts-fsrs. Код начат с копии бота английских слов `bot-anki@deab0ff`.

- Памятка владельца (секреты, правка слов, озвучка, резервная копия): [docs/OPERATIONS.md](docs/OPERATIONS.md)
- Спецификация: [docs/superpowers/specs/2026-10-03-tatar-srs-bot-design.md](docs/superpowers/specs/2026-10-03-tatar-srs-bot-design.md)

Команды:
- `pnpm test` — тесты
- `pnpm validate` — проверка файлов уровней `data/levels/*.csv`
- `pnpm typecheck` — проверка типов

Каждый push в `master` запускает выкладку (`.github/workflows/deploy.yml`); итог лежит в файле `deploy.md` ветки `deploy-report`.
