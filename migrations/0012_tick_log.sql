-- What the reminder tick did, for the admin screen and the admin's alert (src/reminders/service.ts `tick`).
-- Additive: one new table and its index. No row of any existing table changes.
--
-- tick_log: one row per tick in which a user was selected for the daily reminder, a push was planned or a send
-- failed, and one row per tick that threw. An idle tick writes nothing. The counts: the users the daily query
-- selected, the pushes planned (daily, evening, step), the pushes sent and the sends that failed with neither 429
-- nor 403. first_error is the first failure's Telegram description or exception message, cut to 300 characters
-- and with long numbers masked: never a chat id, a name or a learner's words. alerted = 1 when the admin was told of
-- this row in Telegram (at most once an hour). Rows older than 7 days go with the tick's housekeeping.
CREATE TABLE IF NOT EXISTS tick_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  daily_selected INTEGER NOT NULL DEFAULT 0,
  daily_planned INTEGER NOT NULL DEFAULT 0,
  evening_planned INTEGER NOT NULL DEFAULT 0,
  step_planned INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  first_error TEXT,
  alerted INTEGER NOT NULL DEFAULT 0
);

-- idx_tick_log_at: serves the deletion of old rows every minute, the last rows of /admin and the look for an alert
-- within the last hour; each reads only the rows it needs.
CREATE INDEX IF NOT EXISTS idx_tick_log_at ON tick_log(at);
