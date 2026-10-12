/**
 * Words the transcription rules cannot derive: lower-case word → finished transcription.
 * Plain data, no brackets; the stress is U+0301 after the stressed vowel. Only the exact
 * form is matched, so an inflected form needs its own line. Grows during proofreading.
 */
export const EXCEPTIONS: Readonly<Record<string, string>> = {
  // Question words: stress on the first syllable.
  "кайда": "къа́йда",
  "кайчан": "къа́йчан",
  "кайдан": "къа́йдан",
  "кая": "къа́йа",
  "кайсы": "къа́йсы",
  "ничек": "ни́чек",
  "нинди": "ни́нди",
  "ничә": "ни́чә",
  "нигә": "ни́гә",
  "нәрсә": "нә́рсә",

  // Negation: stress on the syllable before -ма/-мә; negative pronouns stress the first syllable.
  "барма": "ба́рма",
  "килмә": "ки́лмә",
  "бармый": "ба́рмый",
  "белмим": "бе́лмим",
  "беркем": "бе́ркем",
  "һичкем": "һи́чкем",
  "бернәрсә": "бе́рнәрсә",
  "беркайда": "бе́ркъайда",
  "беркая": "бе́ркъайа",
  "беркайчан": "бе́ркъайчан",
  "бернинди": "бе́рнинди",

  // Other words with the stress off the last syllable.
  "бүген": "бү́ген",
  "әлбәттә": "әлбә́ттә",
  "ләкин": "лә́кин",
  "әмма": "ә́мма",
  "чөнки": "чө́нки",
  "хәзер": "хә́зер",
  "яки": "йә́ки",
  "ягъни": "йә́гъни",
  "бәлки": "бә́лки",
  "һаман": "һа́ман",
  "быел": "бы́йыл",

  // The demonstrative particles: stress on the first syllable.
  "менә": "ме́нә",
  "әнә": "ә́нә",

  // The numerals 11–19: stress on «ун».
  "унбер": "у́нбер",
  "унике": "у́нике",
  "унөч": "у́нөч",
  "ундүрт": "у́ндүрт",
  "унбиш": "у́нбиш",
  "уналты": "у́налты",
  "унҗиде": "у́нҗиде",
  "унсигез": "у́нсигез",
  "унтугыз": "у́нтугъыз",

  // The question particle -мы/-ме is unstressed: the stress stays before it. Kept as words, not as a
  // rule: the spelling cannot tell the particle from a stem or an ending (егерме, исеме, кеме).
  "исәнме": "исә́нме",
  "исәнмесез": "исә́нмесез",

  // A glide [w] between у, ү and the next vowel that the spelling does not show.
  // юеш is also a front word spelled with ю, е alone, which the row rule reads as back.
  "юеш": "йүwе́ш",
  "суык": "суwы́къ",
  "куу": "къуwу́",
  "юу": "йуwу́",
  "суыткыч": "суwыткъы́ч",

  // Arabic loans where а (я) after [къ], [гъ] or in a front word is read [ә] ([йә]) and the spelling does not show it.
  "сәлам": "сәлә́м",
  "кадәр": "къәдә́р",
  "гаилә": "гъәилә́",
  "гадәт": "гъәдә́т",
  "гадәттә": "гъәдәттә́",
  "гадел": "гъәде́л",
  "гади": "гъәди́",
  "гадәти": "гъәдәти́",
  "галим": "гъәли́м",
  "каләм": "къәлә́м",
  "кадер": "къәде́р",
  "канәгать": "къәнәгъә́т",
  "сәламәт": "сәләмә́т",
  "сәламәтлек": "сәләмәтле́к",
  "каһвә": "къәһwә́",
  "гаять": "гъәйә́т",
  "җинаять": "җинәйә́т",
  "кыяфәт": "къыйәфә́т",

  // Arabic loans where ый after [къ], [гъ] is read [и].
  "тәнкыйть": "тәнкъи́т",
  "мөстәкыйль": "мөстәкъи́л",
  "кыйммәт": "къиммә́т",
  "гыйлем": "гъиле́м",
  "гыйнвар": "гъинwа́р",
  "шагыйрь": "шагъи́р",

  // Arabic loans where о after [гъ] is read [ө].
  "гомер": "гъөме́р",
  "гореф": "гъөре́ф",

  // A compound whose second part keeps its own (back) vowel row: тимер + аяк.
  "тимераяк": "тимерайа́къ",

  // Russian loans: в is [в], к and г stay plain before back vowels, stress as in Russian.
  "вагон": "ваго́н",
  "диван": "дива́н",
  "витамин": "витами́н",
  "трамвай": "трамва́й",
  "вилка": "ви́лка",
  "ванна": "ва́нна",
  "совет": "сове́т",
  "телевизор": "телеви́зор",
  "врач": "врач",
  "магазин": "магази́н",
  "машина": "маши́на",

  // A2 portion 3, second pass: Arabic loans read with front vowels or [и] where the spelling does not show it.
  "кадерле": "къәдерле́",
  "сәламләү": "сәләмлә́w",
  "гаҗәпләндерү": "гъәҗәпләндерү́",
  "гомумән": "гъөмүмә́н",
  "вакыйга": "wакъигъа́",
  "кагыйдә": "къагъидә́",
  "мәкалә": "мәкъәлә́",
};
