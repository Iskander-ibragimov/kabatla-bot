-- notes.word_key no longer carries typographic quotes “ ” „ ‘ ’ at its edges, next to the punctuation that
-- migration 0002 removed: a phrase copied from a chat as “Рәхмәт!” is found by «рәхмәт».
-- The characters are those of KEY_EDGES in src/db/repo.ts, which builds the keys of new notes the same way. The whole
-- set is trimmed again, not the quotes alone: under a quote there may be punctuation that 0002 could not reach.
-- OR IGNORE: a note whose new key is already taken in its deck keeps the old key, and the migration does not fail on it.
-- A key that is nothing but quotes and punctuation is left as it is. Only word_key changes; `word` is shown as typed.
UPDATE OR IGNORE notes
SET word_key = trim(word_key, ' .,!?…:;«»"''()-–—“”„‘’')
WHERE word_key <> trim(word_key, ' .,!?…:;«»"''()-–—“”„‘’')
  AND trim(word_key, ' .,!?…:;«»"''()-–—“”„‘’') <> '';
