/**
 * Tatar verb forms for the dictionary scripts. Pure: no I/O.
 * The corpus lists verbs as bare stems (бар, эшлә, укы); the catalog shows the name of action in -у/-ү (бару, эшләү, уку).
 */
import { BACK_VOWELS, FRONT_VOWELS, isConsonant, isVowel } from "../../src/content/tatar";

/**
 * Row of the last syllable of a stem: it picks -у or -ү. я, ю and a е that stands for [йы]/[йе] have no row of
 * their own, so the vowel before them decides; a stem with nothing else (ерт, ю) is back.
 */
function endsBack(stem: string): boolean {
  for (let i = stem.length - 1; i >= 0; i--) {
    const c = stem[i]!;
    if (BACK_VOWELS.includes(c)) return true;
    if (FRONT_VOWELS.includes(c)) return false;
    if (c === "е" && isConsonant(stem[i - 1])) return false;
  }
  return true;
}

function infinitiveOf(stem: string): string {
  const last = stem.at(-1);
  const before = stem.at(-2);
  const cut = stem.slice(0, -1);
  const u = endsBack(stem) ? "у" : "ү";
  if (last === "й") return `${cut}ю`; // куй → кую, сөй → сөю
  if (last === "и") return `${stem}ю`; // ки → кию
  if (last === "ы" || last === "е") return cut.endsWith("и") ? `${cut}ю` : cut + u; // укы → уку, төзе → төзү, бие → бию
  if ((last === "у" || last === "ү") && isVowel(before)) return `${cut}в${last}`; // яу → яву
  if ((last === "к" || last === "п") && isVowel(before)) return cut + (last === "к" ? "г" : "б") + u; // чык → чыгу, тап → табу
  return stem + u; // бар → бару, аша → ашау, эшлә → эшләү, ту → туу
}

/** Bare verb stem → the name of action in -у/-ү. In a compound verb (ярдәм ит) only the last word changes. */
export function verbInfinitive(stem: string): string {
  const words = stem.split(" ");
  const last = words.pop() ?? "";
  return [...words, last === "" ? last : infinitiveOf(last)].join(" ");
}

/** The form a word is listed under: the infinitive for a verb (`pos` is the project code `v`), the lemma itself otherwise. */
export function dictionaryForm(lemma: string, pos: string): string {
  return pos === "v" ? verbInfinitive(lemma) : lemma;
}

/**
 * The beginnings an inflected form of the verb may have, for the last word of the infinitive: the infinitive without
 * its final у, ү or ю (бар-, ук-, ку-), the same stem as it sounds before a consonant (чыг- → чык-, таб- → тап-,
 * яв- → яу-), and the present tense of a stem in -а, -ә (аша- → ашый, эшлә- → эшли).
 */
export function verbStems(infinitive: string): string[] {
  const word = infinitive.split(" ").pop() ?? "";
  const base = /[уүю]$/.test(word) ? word.slice(0, -1) : word;
  const cut = base.slice(0, -1);
  switch (base.at(-1)) {
    case "г": return [base, `${cut}к`];
    case "б": return [base, `${cut}п`];
    case "в": return [base, cut + (word.endsWith("ү") ? "ү" : "у")];
    case "а": return [base, `${cut}ый`];
    case "ә": return [base, `${cut}и`];
    default: return [base];
  }
}
