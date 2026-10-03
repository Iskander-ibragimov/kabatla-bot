-- One-off data fix (ruling T16c). Before the start-level rule (commit 8137d5a) a learner placed above the published
-- levels finished onboarding with users.level pointing at a level that had no deck and with nothing open.
-- A learner is stranded when onboarding is finished, the level is 1..20 and no deck of that level is open for them.
-- Each of them gets the start level of the onboarding rule: the highest level the catalog has that is not above
-- their level, else the lowest level the catalog has. With no level decks in the catalog nothing changes.
-- Untouched: learners in onboarding, learners at level 21, learners whose level is open, and every card,
-- review, own word and other subscription.
-- Order: the deck is opened first, computed from the old level, and only then the level is moved. Both statements
-- use the same expression for the start level. A learner whose own level has a deck that was never opened gets that
-- deck in the first statement and is then no longer stranded, so the second statement leaves the level as it is.
-- Running the file again changes nothing: after it nobody matches the condition.
INSERT OR IGNORE INTO user_decks (user_id, deck_id, added_at)
SELECT u.id, d.id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM users u
JOIN decks d ON d.level_no = COALESCE(
  (SELECT MAX(level_no) FROM decks WHERE level_no <= u.level),
  (SELECT MIN(level_no) FROM decks))
WHERE u.onboarding_step IS NULL
  AND u.level BETWEEN 1 AND 20
  AND NOT EXISTS (
    SELECT 1 FROM user_decks ud JOIN decks cur ON cur.id = ud.deck_id
    WHERE ud.user_id = u.id AND cur.level_no = u.level);

UPDATE users
SET level = COALESCE(
  (SELECT MAX(level_no) FROM decks WHERE level_no <= users.level),
  (SELECT MIN(level_no) FROM decks))
WHERE onboarding_step IS NULL
  AND level BETWEEN 1 AND 20
  AND EXISTS (SELECT 1 FROM decks WHERE level_no IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM user_decks ud JOIN decks cur ON cur.id = ud.deck_id
    WHERE ud.user_id = users.id AND cur.level_no = users.level);
