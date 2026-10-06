/**
 * Word forms in a Tatar sentence: its tokens, whether the corpus knows a token, and where a form of a headword stands.
 * Pure: no I/O, so the same code runs in the scripts and in the Workers test runtime.
 */
import { verbStems } from "./tatar-verbs";

/** The words of a text, lower-cased; a hyphen between letters stays inside the word, digits and punctuation are dropped. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/\p{L}+(?:-\p{L}+)*/gu) ?? [];
}

/** True if the corpus knows the token; a hyphenated token also passes when every part of it does. */
export function isAttested(token: string, attested: ReadonlySet<string>): boolean {
  return attested.has(token) || (token.includes("-") && token.split("-").every((part) => attested.has(part)));
}

/**
 * What a form of the word may begin with. Verbs: the stems of the infinitive. Other words: the first
 * max(3, length − 2) letters, or the whole word when `strict`; a whole word in -к, -п also matches voiced (аяк → аягым).
 */
function stemsOf(word: string, pos: string, strict: boolean): string[] {
  if (pos === "v") return verbStems(word);
  const stem = strict ? word : word.slice(0, Math.max(3, word.length - 2));
  const voiced = stem === word && /[кп]$/.test(word) ? [word.slice(0, -1) + (word.endsWith("к") ? "г" : "б")] : [];
  return [stem, ...voiced];
}

/**
 * The form of `word` found in the example, lower-cased, or null. A word of several words (ярдәм итү, зур рәхмәт)
 * must stand in neighbouring tokens: the first words as they are, the last one as a form.
 * `strict` narrows the match for words other than verbs to tokens that begin with the whole word.
 */
export function wordForm(example: string, word: string, pos: string, strict = false): string | null {
  const parts = tokenize(word);
  const last = parts.pop();
  if (last === undefined) return null;
  const stems = stemsOf(last, pos, strict);
  const tokens = tokenize(example);
  for (let i = 0; i + parts.length < tokens.length; i++) {
    const tail = tokens[i + parts.length]!;
    if (parts.every((part, k) => tokens[i + k] === part) && stems.some((stem) => tail.startsWith(stem))) {
      return tokens.slice(i, i + parts.length + 1).join(" ");
    }
  }
  return null;
}
