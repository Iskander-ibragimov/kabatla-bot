-- One index for the rule «enough for today» (spec A3, docs/superpowers/specs/2026-10-12-hard-words-and-breakdown-design.md):
-- from the third answer of a card in one day on, «Снова» and «Трудно» send it to tomorrow. Nothing but the index is
-- created: no row of any table changes.
--
-- idx_log_card_time: the answers of one card by time. The queue reads the count of today's answers for every learning
-- card it gives, and a grade reads it for its card:
--   (SELECT COUNT(*) FROM review_log l WHERE l.card_id = ? AND l.reviewed_at >= <start of the learner's day> AND l.undone = 0)
-- With this index that is a look at the rows of that card today, instead of a walk through the learner's whole day
-- (idx_log_user_time) for every card.
CREATE INDEX IF NOT EXISTS idx_log_card_time ON review_log(card_id, reviewed_at);
