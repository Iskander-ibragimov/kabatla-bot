-- The live database moves from the levels by hundreds to the scale A1–C1 (the owner's decision of 2026-10-05):
-- every learner is deleted whole and starts again with /start; the catalog stays. The cards of the old decks
-- l01, l02, … become the cards of A1 in one deck `a1`, each with its id, its text and its voice.
--
-- Every statement runs only while the deck `l01` exists, that is, while the catalog is in the old shape. On an empty
-- database and on one that is already in the new shape the file changes nothing: no learner who came after it is
-- touched. The statement that turns `l01` into `a1` is the last one, so every statement before it sees the old shape.
--
-- No statement writes `notes.audio_file_id` or `notes.audio_tries`, and no catalog note is deleted.

-- 1. Everything that belongs to learners, the rows that point to a row before that row (D1 enforces foreign keys):
--    reports, grades, cards, counters, subscriptions, sessions, previews, queued pushes; then the notes of the decks
--    that have an owner, those decks, and the learners. `usage_daily`, `meta` and `topics` are no learner's and stay.
DELETE FROM reports WHERE EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');
DELETE FROM review_log WHERE EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');
DELETE FROM cards WHERE EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');
DELETE FROM user_progress WHERE EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');
DELETE FROM user_decks WHERE EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');
DELETE FROM sessions WHERE EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');
DELETE FROM previews WHERE EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');
DELETE FROM jobs WHERE EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');
DELETE FROM notes
WHERE deck_id IN (SELECT id FROM decks WHERE owner_id IS NOT NULL)
  AND EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');
DELETE FROM decks WHERE owner_id IS NOT NULL AND EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');
DELETE FROM users WHERE EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');

-- 2. Every catalog note is a card of A1 in «Основа» (topic 0). Its place in the level is provisional and keeps the
--    order the words were taught in: the old levels in turn, each in the order of its notes. The catalog load, which
--    the deploy runs right after the migrations, gives every card of the catalog files its topic and its real place
--    (`seq`, `tseq`). Both provisional places lie behind every place the load gives — `seq` above the size of a
--    level, `tseq` above the runs of the topics 1–20 (topic × 1 000 000 + position) — so a note the files no longer
--    have stays at the end of A1 in either order and never comes before the words of the files.
UPDATE notes
SET level = 1,
    topic_no = 0,
    seq = (SELECT d.level_no FROM decks d WHERE d.id = notes.deck_id) * 100000 + id,
    tseq = 21000000 + (SELECT d.level_no FROM decks d WHERE d.id = notes.deck_id) * 100000 + id
WHERE deck_id IN (SELECT id FROM decks WHERE kind = 'catalog')
  AND EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');

-- 3. One deck holds them: `l01` takes the largest coverage of the old decks and their notes, and the emptied decks go.
UPDATE decks
SET coverage_pct = (SELECT MAX(coverage_pct) FROM decks WHERE kind = 'catalog')
WHERE slug = 'l01';
UPDATE notes
SET deck_id = (SELECT id FROM decks WHERE slug = 'l01')
WHERE deck_id IN (SELECT id FROM decks WHERE kind = 'catalog' AND slug IS NOT 'l01')
  AND EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');
DELETE FROM decks
WHERE kind = 'catalog' AND slug IS NOT 'l01'
  AND EXISTS (SELECT 1 FROM decks WHERE slug = 'l01');

-- 4. The cards of the catalog by level and topic, counted from the notes (the catalog load counts them again).
INSERT INTO catalog_groups (level, topic_no, total)
SELECT n.level, n.topic_no, COUNT(*)
FROM notes n
WHERE n.level IS NOT NULL AND EXISTS (SELECT 1 FROM decks WHERE slug = 'l01')
GROUP BY n.level, n.topic_no
ON CONFLICT (level, topic_no) DO UPDATE SET total = excluded.total;

-- 5. Last: `l01` becomes `a1`, the deck of level 1 of the scale, with its cards counted.
UPDATE decks
SET slug = 'a1',
    level_no = 1,
    title_ru = 'A1',
    title_tt = 'A1',
    total = (SELECT COUNT(*) FROM notes WHERE deck_id = decks.id)
WHERE slug = 'l01';
