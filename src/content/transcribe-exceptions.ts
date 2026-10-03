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

  // Arabic loans where а (я) after [къ], [гъ] or in a front word is read [ә] ([йә]) and the spelling does not show it.
  "сәлам": "сәлә́м",
  "кадәр": "къәдә́р",
  "гаилә": "гъәилә́",
  "гадәт": "гъәдә́т",
  "галим": "гъәли́м",
  "каләм": "къәлә́м",
  "кадер": "къәде́р",
  "канәгать": "къәнәгъә́т",
  "сәламәт": "сәләмә́т",
  "гаять": "гъәйә́т",
  "җинаять": "җинәйә́т",
  "кыяфәт": "къыйәфә́т",

  // Arabic loans where ый after [къ], [гъ] is read [и].
  "тәнкыйть": "тәнкъи́т",
  "мөстәкыйль": "мөстәкъи́л",
  "кыйммәт": "къиммә́т",
  "гыйлем": "гъиле́м",

  // Arabic loans where о after [гъ] is read [ө].
  "гомер": "гъөме́р",

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
};
