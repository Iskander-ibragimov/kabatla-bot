import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/lib/args";

describe("parseArgs", () => {
  const spec = { values: ["level", "min"], flags: ["check"] };

  it("tells the words of a command line from its options, wherever the options stand", () => {
    expect(parseArgs(["китап", "--min", "3", "n"], spec)).toEqual({ words: ["китап", "n"], values: { min: "3" }, flags: new Set() });
    expect(parseArgs(["--level", "a1", "--check"], spec)).toEqual({ words: [], values: { level: "a1" }, flags: new Set(["check"]) });
    expect(parseArgs([], spec)).toEqual({ words: [], values: {}, flags: new Set() });
    expect(parseArgs(["Хәлләр ничек?", "phr"])).toEqual({ words: ["Хәлләр ничек?", "phr"], values: {}, flags: new Set() });
  });

  it("refuses an option it does not know", () => {
    expect(() => parseArgs(["--base", "master"], spec)).toThrow(/--base/);
    expect(() => parseArgs(["--check"])).toThrow(/--check/);
  });

  it("refuses an option without its value: at the end, or before another option", () => {
    expect(() => parseArgs(["--level"], spec)).toThrow(/--level/);
    expect(() => parseArgs(["--level", "--check"], spec)).toThrow(/--level/);
  });

  it("refuses an option given twice", () => {
    expect(() => parseArgs(["--min", "3", "--min", "4"], spec)).toThrow(/--min/);
    expect(() => parseArgs(["--check", "--check"], spec)).toThrow(/--check/);
  });

  it("skips the bare -- a package manager may put before the options", () => {
    expect(parseArgs(["--", "--level", "a1"], spec)).toEqual({ words: [], values: { level: "a1" }, flags: new Set() });
  });

  it("takes a lone dash or a word with a dash inside for a word", () => {
    expect(parseArgs(["әти-әни", "-"], spec).words).toEqual(["әти-әни", "-"]);
  });
});
