-- The daily limit of messages with words (ruling F2) and the cleaning of old previews.
-- Additive: two new columns of users with defaults, and one index. No existing value of any row changes.
--
-- users.adds_day, users.adds_count: how many messages with words the user has sent on the local day `adds_day`
-- (the same shape as gens_day / gens_count for /gen). A user who has never sent one keeps NULL and 0.
ALTER TABLE users ADD COLUMN adds_day TEXT;
ALTER TABLE users ADD COLUMN adds_count INTEGER NOT NULL DEFAULT 0;

-- idx_previews_created: serves `DELETE FROM previews WHERE created_at < ?`, which the tick runs every minute
-- (src/reminders/service.ts). With the index the statement reads only the rows it deletes; without it, every preview.
CREATE INDEX IF NOT EXISTS idx_previews_created ON previews(created_at);
