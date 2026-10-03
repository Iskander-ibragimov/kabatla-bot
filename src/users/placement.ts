/** Ten words of rising difficulty for the 30-second level check; `level` is the level the word belongs to. */
export const PLACEMENT: readonly { word: string; level: number }[] = [
  { word: "бар", level: 1 }, { word: "юк", level: 1 }, { word: "су", level: 2 }, { word: "өй", level: 3 }, { word: "вакыт", level: 4 },
  { word: "авыл", level: 6 }, { word: "сәяхәт", level: 8 }, { word: "тәҗрибә", level: 10 }, { word: "мөнәсәбәт", level: 13 }, { word: "җәмгыять", level: 16 },
];

/** Start level from the number of known placement words. */
export function placementLevel(known: number): number {
  if (known <= 2) return 1;
  if (known <= 4) return 2;
  if (known <= 6) return 4;
  if (known <= 8) return 7;
  return 10;
}
