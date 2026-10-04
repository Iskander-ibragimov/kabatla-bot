-- Two indexes for the budget of D1 rows read (ruling F4). Nothing but the indexes is created: no row of any table changes.
--
-- idx_notes_deck: the notes of one deck in the order of their ids (an index on deck_id keeps the rowid as its second
-- column). Serves the session queue (`Repo.candidateCards`), /levels (`Repo.levelsOverview`) and the daily reminder
-- (src/reminders/service.ts): each of them asks for the last or the first note of a deck — `WHERE deck_id = ? ORDER BY
-- id DESC LIMIT 1` — to learn from one note whether the deck still has unseen words, and reads the notes of the one
-- level in work in the order they are shown. Without it that question costs the whole deck, because the only index
-- that starts with deck_id is the UNIQUE (deck_id, word_key), ordered by the key.
CREATE INDEX IF NOT EXISTS idx_notes_deck ON notes(deck_id);

-- idx_decks_owner: the decks of one user — `WHERE owner_id = ?` in `Repo.ownDecks` (/levels) and `Repo.customDeck`
-- (every added word). Without it both read every deck of every user.
CREATE INDEX IF NOT EXISTS idx_decks_owner ON decks(owner_id);
