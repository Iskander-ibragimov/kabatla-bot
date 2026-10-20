# deploy report

Run: 2026-10-20T15:50:45Z
Commit: 3641bb48b7056324bc757ae005b524fc44678a83

## Steps
- install: success
- typecheck: success
- test: success
- check secrets: success
- workers.dev subdomain: success
- D1 database: success
- check catalog: success
- catalog headwords: success
- migrations: success
- load catalog: success
- deploy worker: success
- worker secrets: success
- webhook and commands: success
- self-check: success
- start voicing: success

## Missing secrets
none

## Worker
- LLM providers selected: 2
- worker host: kabatla-bot.i17ibragimov.workers.dev

## Catalog
- catalog levels in repo: 5 (check catalog step: success; load catalog step: success)
- catalog notes in the database: before 3850, after 3850; rows in the files: 3850
- voiced catalog notes: before 3850, after 3850
- notes of the old catalog the load did not find in the files: 0
- catalog headwords missing from the files: 0; renames that would make two cards one: 0

## catalog validation (first 10 of 1 lines; check catalog step: success)
```
уровней: 5, карточек: 3850, нарушений нет
```

## Telegram
- bot username: Kabatlabot
- webhook host matches worker: yes
- pending_update_count: 0
- last_error_message: (none)
- commands (default): 9: start,learn,levels,howto,gen,stats,settings,undo,help
- commands (ru): 9: start,learn,levels,howto,gen,stats,settings,undo,help
- commands (tt): 9: start,learn,levels,howto,gen,stats,settings,undo,help
- commands (en): 0: 

## webhook and commands output (last 15 lines; warnings: 0)
```
setWebhook: ok
commands default: unchanged
description default: unchanged
commands ru: unchanged
description ru: unchanged
commands tt: unchanged
description tt: unchanged
menu button: unchanged
```

## Voicing
- notes without audio: 0 (voice-db started: no)

## Self-check
- POST /tg without secret header: HTTP 401 (expected: not 2xx)
- POST /tg with secret header: HTTP 200 (expected: 200)
