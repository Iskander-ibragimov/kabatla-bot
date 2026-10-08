import { describe, expect, it } from "vitest";
import { formatInterval } from "../../src/srs/interval";
import { RUNGS } from "../../src/srs/ladder";

const S = 1000, MIN = 60_000, H = 3_600_000, D = 86_400_000;

describe("formatInterval ru, plain", () => {
  it.each([
    [30 * S, "меньше минуты"],
    [1 * MIN, "1 минута"], [2 * MIN, "2 минуты"], [5 * MIN, "5 минут"], [10 * MIN, "10 минут"],
    [11 * MIN, "11 минут"], [12 * MIN, "12 минут"], [13 * MIN, "13 минут"], [21 * MIN, "21 минута"], [22 * MIN, "22 минуты"], [25 * MIN, "25 минут"],
    [1 * H, "1 час"], [3 * H, "3 часа"], [5 * H, "5 часов"], [21 * H, "21 час"],
    [1 * D, "1 день"], [3 * D, "3 дня"], [7 * D, "7 дней"], [14 * D, "14 дней"], [21 * D, "21 день"],
    [30 * D, "1 месяц"], [60 * D, "2 месяца"], [120 * D, "4 месяца"], [180 * D, "6 месяцев"], [69 * D, "2,3 месяца"],
    [365 * D, "1 год"], [730 * D, "2 года"], [1825 * D, "5 лет"], [548 * D, "1,5 года"],
    [59.6 * MIN, "1 час"], [29.6 * D, "1 месяц"],
  ])("%i ms -> %s", (ms, text) => {
    expect(formatInterval(ms, "ru")).toBe(text);
  });
});

describe("formatInterval ru, after «через»", () => {
  it.each([
    [1 * MIN, "1 минуту"], [21 * MIN, "21 минуту"], [2 * MIN, "2 минуты"], [5 * MIN, "5 минут"], [11 * MIN, "11 минут"], [31 * MIN, "31 минуту"],
    [1 * D, "1 день"], [1 * H, "1 час"], [30 * S, "меньше минуты"],
  ])("%i ms -> %s", (ms, text) => {
    expect(formatInterval(ms, "ru", "after")).toBe(text);
  });
});

describe("formatInterval tt", () => {
  it.each([
    [30 * S, "минуттан кимрәк"], [5 * MIN, "5 минут"], [3 * H, "3 сәгать"], [14 * D, "14 көн"], [60 * D, "2 ай"], [548 * D, "1,5 ел"],
  ])("%i ms -> %s", (ms, text) => {
    expect(formatInterval(ms, "tt")).toBe(text);
    expect(formatInterval(ms, "tt", "after")).toBe(text);
  });
});

describe("button width", () => {
  // «Хорошо · 10 минут»: name + " · " + interval must fit 18 characters.
  it.each([["Хорошо", "ru"], ["Трудно", "ru"], ["Яңадан", "tt"]] as const)("%s fits with every rung and 5 minutes", (name, lang) => {
    for (const ms of [...RUNGS, 5 * MIN]) expect(name.length + 3 + formatInterval(ms, lang).length).toBeLessThanOrEqual(18);
  });
});
