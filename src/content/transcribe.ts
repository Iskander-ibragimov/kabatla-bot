/**
 * Rule-based transcription of Tatar words into the school notation written with Tatar
 * Cyrillic letters: вакыт → wакъы́т. Pure: no I/O. The result carries no brackets.
 *
 * Order of rules:
 *  1–2. The text is cut into Cyrillic words, each is lower-cased; everything between the
 *       words stays as it is. A word listed in EXCEPTIONS is answered from there.
 *  3. к, г → къ, гъ when the vowel of their syllable is back: before а о у ы, or, with no
 *     vowel right after, when the nearest vowel to the left is back. Written къ, гъ are kept.
 *  4. к/г + а, ы or у + consonant + ь: the ь marks a front syllable after a hard consonant, so
 *     the result is къ/гъ + ә, е or ү, and the ь itself is silent (сәгать → сәгъәт,
 *     шигырь → шигъер, мәшгуль → мәшгъүл).
 *  5. в → w; у, ү right after a vowel → w.
 *  6. я, ю, е at the word start and after a vowel, ъ or ь → й + vowel: of the word's row at
 *     the start and after a vowel (я → а/ә, ю → у/ү, е → ы/е), back after ъ, ь (дөнья → дөнйа).
 *     After a consonant е is [е]; я, ю there occur only in loans and stay as written.
 *  7. ь, ъ between a consonant and а о у ы ә ө ү и э → ʼ; elsewhere they are silent.
 *     э right after a vowel → ʼ.
 *  8. Stress on the last vowel; a word with one vowel carries no mark.
 */
import { BACK_VOWELS, IOTATED_VOWELS, isBackWord, isConsonant, isSign, isVowel } from "./tatar";
import { EXCEPTIONS } from "./transcribe-exceptions";

/** Stress mark, COMBINING ACUTE ACCENT, written right after the stressed vowel. */
const STRESS = "\u0301";
/** Glottal stop, MODIFIER LETTER APOSTROPHE. */
const GLOTTAL_STOP = "\u02BC";
/** A run of letters of the Cyrillic block, U+0400–U+04FF. */
const CYRILLIC_WORD = /[\u0400-\u04FF]+/g;

/** я, ю, е as «й + vowel»: [in a back word, in a front word]. */
const IOTATION: Readonly<Record<string, readonly [back: string, front: string]>> = {
  "я": ["а", "ә"],
  "ю": ["у", "ү"],
  "е": ["ы", "е"],
};
/** Rule 4: the back letter written after къ, гъ → the front vowel it stands for. */
const FRONT_AFTER_HARD: Readonly<Record<string, string>> = { "а": "ә", "ы": "е", "у": "ү" };

/** Transcribes every Cyrillic word of the text. Never throws; text that is not Cyrillic comes back unchanged. */
export function transcribe(text: string): string {
  return text.replace(CYRILLIC_WORD, (word) => transcribeWord(word.toLowerCase()));
}

function transcribeWord(word: string): string {
  return EXCEPTIONS[word] ?? applyRules(word);
}

function applyRules(w: string): string {
  const back = isBackWord(w);
  let out = "";
  let vowels = 0;
  /** Where the stress mark goes: right after the last vowel written so far. */
  let stressAt = 0;
  /** Row of the nearest vowel to the left as it is pronounced; false while there is none. */
  let afterBackVowel = false;
  const pushVowel = (letter: string, isBack: boolean): void => {
    out += letter;
    stressAt = out.length;
    vowels += 1;
    afterBackVowel = isBack;
  };

  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    const prev = w[i - 1];
    const next = w[i + 1];

    if (c === "к" || c === "г") {
      const front = next === undefined ? undefined : FRONT_AFTER_HARD[next];
      if (front !== undefined && isConsonant(w[i + 2]) && w[i + 3] === "ь") {
        out += `${c}ъ`;
        pushVowel(front, false);
        i += 1;
      } else if (next === "ъ") {
        out += `${c}ъ`;
        i += 1;
      } else {
        const hard = isVowel(next) ? BACK_VOWELS.includes(next) : afterBackVowel;
        out += hard ? `${c}ъ` : c;
      }
    } else if (c === "в" || ((c === "у" || c === "ү") && isVowel(prev))) {
      out += "w";
    } else if (IOTATED_VOWELS.includes(c)) {
      const afterSign = isSign(prev);
      if (i === 0 || afterSign || isVowel(prev)) {
        const [backVowel, frontVowel] = IOTATION[c]!;
        const isBack = afterSign || back;
        out += "й";
        pushVowel(isBack ? backVowel : frontVowel, isBack);
      } else {
        pushVowel(c, false);
      }
    } else if (c === "э" && isVowel(prev)) {
      out += GLOTTAL_STOP;
    } else if (isSign(c)) {
      if (isConsonant(prev) && isVowel(next) && !IOTATED_VOWELS.includes(next)) out += GLOTTAL_STOP;
    } else if (isVowel(c)) {
      pushVowel(c, BACK_VOWELS.includes(c));
    } else {
      out += c;
    }
  }

  return vowels > 1 ? out.slice(0, stressAt) + STRESS + out.slice(stressAt) : out;
}
