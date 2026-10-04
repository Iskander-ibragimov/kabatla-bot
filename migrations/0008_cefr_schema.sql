-- CEFR levels, topics, progress counters. Additive: no data is moved, no card, review-log row or note is touched.
-- Catalog notes get level/topic_no/seq/tseq; own and AI notes keep them NULL.
ALTER TABLE notes ADD COLUMN level INTEGER;
ALTER TABLE notes ADD COLUMN topic_no INTEGER;
ALTER TABLE notes ADD COLUMN seq INTEGER;
ALTER TABLE notes ADD COLUMN tseq INTEGER;

CREATE UNIQUE INDEX idx_notes_catalog_key ON notes(word_key) WHERE level IS NOT NULL;
CREATE INDEX idx_notes_level_seq ON notes(level, seq) WHERE level IS NOT NULL;
CREATE INDEX idx_notes_level_tseq ON notes(level, tseq) WHERE level IS NOT NULL;

CREATE TABLE topics (
  no INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title_ru TEXT NOT NULL,
  title_tt TEXT NOT NULL
);

CREATE TABLE catalog_groups (
  level INTEGER NOT NULL,
  topic_no INTEGER NOT NULL,
  total INTEGER NOT NULL,
  PRIMARY KEY (level, topic_no)
);

CREATE TABLE user_progress (
  user_id INTEGER NOT NULL,
  level INTEGER NOT NULL,
  topic_no INTEGER NOT NULL,
  started INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, level, topic_no)
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('catalog_version', '0'), ('catalog_hash', '');

ALTER TABLE users ADD COLUMN levels INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN pos_groups INTEGER NOT NULL DEFAULT 255;
ALTER TABLE users ADD COLUMN new_mode TEXT NOT NULL DEFAULT 'guided' CHECK (new_mode IN ('guided', 'topic', 'freq'));
ALTER TABLE users ADD COLUMN topic_no INTEGER;
ALTER TABLE users ADD COLUMN hints_seen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN new_cursors TEXT;
