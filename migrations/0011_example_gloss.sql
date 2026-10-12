-- The word-by-word breakdown of a catalog example (spec Part B, docs/superpowers/specs/2026-10-12-hard-words-and-breakdown-design.md).
-- The catalog seed (seed/catalog.sql, built by scripts/csv-to-sql.ts from data/gloss/<level>.tsv) writes it as compact
-- JSON: a list of [form, lemma, gloss, level] — the word as the example has it, its initial form, its translation in
-- this example, and the catalog level (A1 … C1) of the initial form, null for the card's own word and for a word
-- outside the catalog. NULL for a learner's own notes, AI notes and a level that has no breakdown yet: such a card
-- shows no «🔎 Разбор» button. Nothing but the column is added: no row of any table changes.
ALTER TABLE notes ADD COLUMN example_gloss TEXT;
