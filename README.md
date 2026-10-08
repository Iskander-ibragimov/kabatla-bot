# Кабатла

Telegram-бот @Kabatlabot: учит русскоязычных татарским словам по интервальным повторениям: слово поднимается по лесенке из десяти интервалов, от минуты до полугода. Слова разбиты на уровни A1–C1 и темы, у каждой карточки есть транскрипция, пример и озвучка.

Стек: Cloudflare Workers, база D1, grammy. Код начат с копии бота английских слов `bot-anki@deab0ff`.

- Памятка владельца (секреты, правка слов, озвучка, резервная копия): [docs/OPERATIONS.md](docs/OPERATIONS.md)
- Спецификации: [бот](docs/superpowers/specs/2026-10-03-tatar-srs-bot-design.md), [уровни A1–C1, темы и знакомство](docs/superpowers/specs/2026-10-04-cefr-levels-topics-onboarding-design.md)
- Правила составления каталога: [docs/review/README.md](docs/review/README.md)

Команды:
- `pnpm test` — тесты
- `pnpm validate` — проверка каталога: `data/catalog/*.csv`, `data/topics.csv`, `data/renames.csv`
- `pnpm typecheck` — проверка типов
- `pnpm depcruise` — проверка границ слоёв

Каждый push в `master` запускает выкладку (`.github/workflows/deploy.yml`), кроме правок только документации (`docs/`, файлы `.md`); итог лежит в файле `deploy.md` ветки `deploy-report`.
