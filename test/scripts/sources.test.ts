import { describe, expect, it } from "vitest";
import { pairSentences, parseLemmaLine, parseLinks, parseSentences, parseWordformLine } from "../../scripts/lib/sources";

describe("sources", () => {
  it("parses a corpus line and skips garbage", () => {
    expect(parseLemmaLine("12345 вакыт\tN", "n")).toEqual({ count: 12345, lemma: "вакыт", pos: "n" });
    expect(parseLemmaLine("", "n")).toBeNull();
    expect(parseLemmaLine("abc вакыт", "n")).toBeNull();
  });

  it("parses the real list layout: leading spaces and an angle-bracket tag", () => {
    expect(parseLemmaLine(" 834267 ел\t<n>", "n")).toEqual({ count: 834267, lemma: "ел", pos: "n" });
    expect(parseLemmaLine("1503129 килә\t<v>\r", "v")).toEqual({ count: 1503129, lemma: "килә", pos: "v" });
    expect(parseLemmaLine("12345", "n")).toBeNull();
  });

  it("parses word-form lines and keeps only frequent ones", () => {
    expect(parseWordformLine("һәм\t\t1630726", 3)).toBe("һәм");
    expect(parseWordformLine("сирәк\t\t2", 3)).toBeNull();
    expect(parseWordformLine("сирәк\t\t3", 3)).toBe("сирәк");
    expect(parseWordformLine("", 3)).toBeNull();
    expect(parseWordformLine("сүз", 3)).toBeNull();
    // full list layout: rank, form, count; non-words are dropped
    expect(parseWordformLine("5001\tвакыт\t291672", 3)).toBe("вакыт");
    expect(parseWordformLine("1\t!\t357485", 3)).toBeNull();
    expect(parseWordformLine("77\t2014\t900", 3)).toBeNull();
    expect(parseWordformLine("78\tсүз\t2", 3)).toBeNull();
  });

  it("pairs Tatar sentences with Russian translations", () => {
    const tat = new Map([[1, "Вакыт бик тиз уза."], [2, "Сәлам!"]]);
    const rus = new Map([[10, "Время проходит очень быстро."]]);
    expect(pairSentences(tat, rus, [[1, 10], [2, 99]])).toEqual([{ tatId: 1, tat: "Вакыт бик тиз уза.", rusId: 10, rus: "Время проходит очень быстро." }]);
  });

  it("parses Tatoeba sentence and link exports", () => {
    const sentences = parseSentences("1\ttat\tСәлам!\n2\ttat\t\nx\ttat\tbad\n3\ttat\tA\tB\n");
    expect([...sentences]).toEqual([[1, "Сәлам!"], [3, "A\tB"]]);
    expect(parseLinks("1\t10\r\nbad\n2\t\n3\t30\n")).toEqual([[1, 10], [3, 30]]);
  });
});
