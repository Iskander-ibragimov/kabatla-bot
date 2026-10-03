/**
 * Tatar Cyrillic alphabet helpers. Pure: no I/O, no imports.
 * The character classes are spelled as escapes, so that no look-alike can hide in the source.
 */

/** Ә ә Ө ө Ү ү Җ җ Ң ң Һ һ: the six letters Tatar adds to the Russian alphabet, in both cases. */
const TATAR_ONLY = "\u04D8\u04D9\u04E8\u04E9\u04AE\u04AF\u0496\u0497\u04A2\u04A3\u04BA\u04BB";
/** А–я (U+0410–U+044F), Ё, ё and the six Tatar letters: the whole Tatar Cyrillic alphabet. */
const TATAR_LETTERS = `\u0410-\u044F\u0401\u0451${TATAR_ONLY}`;
/** Punctuation allowed next to Tatar words: . , ! ? : ; - – (U+2013) — (U+2014) « » " ' ( ) … (U+2026) */
const PUNCTUATION = `.,!?:;\\-\u2013\u2014\u00AB\u00BB"'()\u2026`;

const HAS_TATAR_LETTER = new RegExp(`[${TATAR_ONLY}]`);
const TATAR_TEXT = new RegExp(`^[${TATAR_LETTERS}0-9 ${PUNCTUATION}]*$`);

/** True if the text has at least one of ә ө ү җ ң һ, in either case. */
export function hasTatarLetters(s: string): boolean {
  return HAS_TATAR_LETTER.test(s);
}

/**
 * True if the text consists only of Tatar Cyrillic letters, digits, the space and the punctuation above.
 * Latin and foreign Cyrillic look-alikes (h, ə, қ, ғ, і …) fail, and so do line breaks. The empty string passes.
 */
export function isTatarText(s: string): boolean {
  return TATAR_TEXT.test(s);
}

/** Vowel letters that always stand for a back vowel. */
export const BACK_VOWELS = "аоуы";
/** Vowel letters that always stand for a front vowel. */
export const FRONT_VOWELS = "әөүиэ";
/** Vowel letters whose row depends on the word and that may carry a [й]. */
export const IOTATED_VOWELS = "яюе";
const VOWELS = `${BACK_VOWELS}${FRONT_VOWELS}${IOTATED_VOWELS}ё`;
const CONSONANTS = "бвгджҗзйклмнңпрстфхһцчшщ";

const oneOf = (letters: string) => (c: string | undefined): c is string => c !== undefined && c !== "" && letters.includes(c);

/** The three predicates take one lower-case letter, or `undefined` for a position outside the word. */
export const isVowel = oneOf(VOWELS);
export const isConsonant = oneOf(CONSONANTS);
export const isSign = oneOf("ьъ");

/**
 * Row of a word. The first unambiguous vowel decides: а о у ы are back, ә ө ү и э are front,
 * and so is е after a consonant (яшел). A word with nothing but я, ю and word-initial or
 * post-vocalic е is front if it ends in ь (яшь) and back otherwise (ел, юл).
 */
export function isBackWord(word: string): boolean {
  const w = word.toLowerCase();
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    if (BACK_VOWELS.includes(c)) return true;
    if (FRONT_VOWELS.includes(c)) return false;
    if (c === "е" && isConsonant(w[i - 1])) return false;
  }
  return !w.endsWith("ь");
}
