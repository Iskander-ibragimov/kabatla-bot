import type { Lang } from "./ladder";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;

type Unit = "min" | "hour" | "day" | "month" | "year";

/** Russian: [1, 2, 5] forms, e.g. минута / минуты / минут. */
const RU: Record<Unit, [string, string, string]> = {
  min: ["минута", "минуты", "минут"],
  hour: ["час", "часа", "часов"],
  day: ["день", "дня", "дней"],
  month: ["месяц", "месяца", "месяцев"],
  year: ["год", "года", "лет"],
};
const TT: Record<Unit, string> = { min: "минут", hour: "сәгать", day: "көн", month: "ай", year: "ел" };

function ruForm(n: number, forms: [string, string, string]): string {
  // A number with a fraction takes the form of 2.
  if (!Number.isInteger(n)) return forms[1];
  const last = n % 10;
  const last2 = n % 100;
  if (last === 1 && last2 !== 11) return forms[0];
  if (last >= 2 && last <= 4 && (last2 < 12 || last2 > 14)) return forms[1];
  return forms[2];
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * An interval in words. "after" is for «через …»: only the accusative of «минута» changes.
 * Unit boundaries: under a minute; minutes under 60; hours under a day; days under 30; months under 365 days; years.
 */
export function formatInterval(ms: number, lang: Lang, form: "plain" | "after" = "plain"): string {
  const out = (n: number, unit: Unit): string => {
    const text = n.toString().replace(".", ",");
    if (lang === "tt") return `${text} ${TT[unit]}`;
    const word = unit === "min" && form === "after" && Number.isInteger(n) && n % 10 === 1 && n % 100 !== 11 ? "минуту" : ruForm(n, RU[unit]);
    return `${text} ${word}`;
  };
  if (ms < MIN) return lang === "tt" ? "минуттан кимрәк" : "меньше минуты";
  const m = Math.round(ms / MIN);
  if (m < 60) return out(m, "min");
  if (ms < DAY) return out(Math.round(ms / H), "hour");
  const d = Math.round(ms / DAY);
  if (d < 30) return out(d, "day");
  if (d < 365) return out(round1(d / 30), "month");
  return out(round1(d / 365), "year");
}
