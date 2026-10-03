CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL UNIQUE,
  chat_id INTEGER NOT NULL,
  lang TEXT NOT NULL DEFAULT 'ru' CHECK (lang IN ('ru','tt')),
  tz_offset_min INTEGER NOT NULL DEFAULT 180,
  remind_at TEXT NOT NULL DEFAULT '09:00',
  new_per_day INTEGER NOT NULL DEFAULT 10,
  retention REAL NOT NULL DEFAULT 0.9,
  direction TEXT NOT NULL DEFAULT 'tt_ru' CHECK (direction IN ('tt_ru','ru_tt','both')),
  autoplay INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  streak INTEGER NOT NULL DEFAULT 0,
  last_study_day TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  onboarding_step TEXT DEFAULT 'lang',
  onboarding_data TEXT,
  gens_day TEXT,
  gens_count INTEGER NOT NULL DEFAULT 0,
  pending_url TEXT,
  pending_url_at INTEGER,
  pending_edit TEXT,
  last_daily_push_day TEXT,
  last_evening_push_day TEXT,
  last_step_ping_at INTEGER,
  last_review_at INTEGER,
  mix_counter INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  next_daily_at INTEGER,
  next_evening_at INTEGER
);
CREATE INDEX idx_users_next_daily ON users(next_daily_at);
CREATE INDEX idx_users_next_evening ON users(next_evening_at);
CREATE INDEX idx_users_last_review ON users(last_review_at);

CREATE TABLE decks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE,
  owner_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('catalog','ai','custom')),
  title_ru TEXT NOT NULL,
  title_tt TEXT NOT NULL,
  level_no INTEGER,
  coverage_pct INTEGER,
  total INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_decks_level ON decks(level_no) WHERE level_no IS NOT NULL;

CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_id INTEGER NOT NULL REFERENCES decks(id),
  word TEXT NOT NULL,
  word_key TEXT NOT NULL,
  transcription TEXT,
  pos TEXT NOT NULL DEFAULT '',
  translation TEXT NOT NULL,
  example_tt TEXT NOT NULL DEFAULT '',
  example_ru TEXT NOT NULL DEFAULT '',
  example_src TEXT NOT NULL DEFAULT '',
  audio_file_id TEXT,
  audio_tries INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,
  UNIQUE (deck_id, word_key)
);
CREATE INDEX idx_notes_word_key ON notes(word_key);

CREATE TABLE user_decks (
  user_id INTEGER NOT NULL REFERENCES users(id),
  deck_id INTEGER NOT NULL REFERENCES decks(id),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, deck_id)
);

CREATE TABLE cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  note_id INTEGER NOT NULL REFERENCES notes(id),
  direction TEXT NOT NULL CHECK (direction IN ('tt_ru','ru_tt')),
  state TEXT NOT NULL CHECK (state IN ('new','learning','review','relearning')),
  step INTEGER,
  stability REAL,
  difficulty REAL,
  due INTEGER NOT NULL,
  last_review INTEGER,
  scheduled_days INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  buried_day TEXT,
  UNIQUE (user_id, note_id, direction)
);
CREATE INDEX idx_cards_user_state_due ON cards(user_id, state, due);

CREATE TABLE review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  state_before TEXT NOT NULL,
  interval_before_days INTEGER NOT NULL,
  interval_after_ms INTEGER NOT NULL,
  reviewed_at INTEGER NOT NULL,
  was_new INTEGER NOT NULL DEFAULT 0,
  learned_now INTEGER NOT NULL DEFAULT 0,
  streak_before INTEGER NOT NULL DEFAULT 0,
  last_study_day_before TEXT,
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_log_user_time ON review_log(user_id, reviewed_at);

CREATE TABLE sessions (
  user_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  card_id INTEGER,
  stale INTEGER NOT NULL DEFAULT 0,
  last_voice_message_id INTEGER
);

CREATE TABLE previews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('add','gen')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_at INTEGER,
  done_at INTEGER,
  error TEXT,
  dedup_key TEXT
);
CREATE INDEX idx_jobs_pending ON jobs(done_at, run_at);
CREATE UNIQUE INDEX idx_jobs_dedup ON jobs(dedup_key) WHERE done_at IS NULL AND dedup_key IS NOT NULL;

CREATE TABLE usage_daily (
  day TEXT PRIMARY KEY,
  reviews INTEGER NOT NULL DEFAULT 0,
  rows_written_est INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  warned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  note_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, note_id)
);
