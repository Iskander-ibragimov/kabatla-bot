-- notes.word_key no longer carries spaces and punctuation at its edges: the phrase «Рәхмәт!» is found by «рәхмәт».
-- The characters are those of KEY_EDGES in src/db/repo.ts, which builds the keys of new notes the same way.
-- OR IGNORE: a note whose new key is already taken in its deck keeps the old key, and the migration does not fail on it.
-- A key that is nothing but punctuation is left as it is.
UPDATE OR IGNORE notes
SET word_key = trim(word_key, ' .,!?…:;«»"''()-–—')
WHERE word_key <> trim(word_key, ' .,!?…:;«»"''()-–—')
  AND trim(word_key, ' .,!?…:;«»"''()-–—') <> '';
