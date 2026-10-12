import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_HEADER } from "../../scripts/lib/catalog";
import { FILES, GLOSS_DIR, levelCandidatesPath, readCatalog, readCatalogMeta, readGloss, readKfuTexts, readLines, readText, strayCatalogFiles, strayGlossFiles, writeText } from "../../scripts/lib/files";

/** The test runtime has a file system of its own under /tmp: nothing here touches the repository. */
const dir = (name: string): string => {
  const path = `/tmp/files-test/${name}`;
  mkdirSync(path, { recursive: true });
  return path;
};

describe("readText, writeText, readLines", () => {
  it("writes a file with the folders it needs and reads it back", () => {
    const path = `${dir("text")}/a/b/c.txt`;
    writeText(path, "бер\n");
    expect(readText(path)).toBe("бер\n");
  });

  it("names the file that is not there, with the hint how to get it", () => {
    expect(() => readText("/tmp/files-test/none.txt")).toThrow("нет файла /tmp/files-test/none.txt");
    expect(() => readText("/tmp/files-test/none.txt", "скачайте его")).toThrow("нет файла /tmp/files-test/none.txt — скачайте его");
  });

  it("reads the lines of a file trimmed and without the empty ones; an absent file has none", () => {
    const path = `${dir("lines")}/forms.txt`;
    writeText(path, " бер \n\n\tике\r\n   \nөч");
    expect(readLines(path)).toEqual(["бер", "ике", "өч"]);
    expect(readLines("/tmp/files-test/none.txt")).toEqual([]);
  });
});

describe("the catalog files", () => {
  const level = (words: string[]) => [CATALOG_HEADER.join(","), ...words.map((w) => `${w},${w},n,слово,Бу ${w}.,Это слово.,own,core,`)].join("\n") + "\n";

  it("reads the level files that exist, A1 first, and nothing else", () => {
    const catalog = dir("catalog");
    writeFileSync(`${catalog}/b1.csv`, level(["су"]));
    writeFileSync(`${catalog}/a1.csv`, level(["өй", "юл"]));
    writeFileSync(`${catalog}/a3.csv`, level(["ял"]));
    writeFileSync(`${catalog}/A2.CSV`, level(["көн"]));
    writeFileSync(`${catalog}/meta.json`, "[]");
    expect(readCatalog(catalog).map((l) => [l.level, l.header.join(","), l.rows.map((r) => r.word)])).toEqual([
      [1, CATALOG_HEADER.join(","), ["өй", "юл"]], [3, CATALOG_HEADER.join(","), ["су"]],
    ]);
    expect(strayCatalogFiles(catalog)).toEqual(["A2.CSV", "a3.csv"]);
  });

  it("has no levels and no stray files where there is no catalog", () => {
    expect(readCatalog("/tmp/files-test/no-catalog")).toEqual([]);
    expect(strayCatalogFiles("/tmp/files-test/no-catalog")).toEqual([]);
    expect(readCatalog(dir("empty-catalog"))).toEqual([]);
  });

  it("reads meta.json as it is, for the check to judge; an absent file is an empty list", () => {
    const path = `${dir("meta")}/meta.json`;
    writeFileSync(path, '[{"level":1,"coveragePct":"45"}]\n');
    expect(readCatalogMeta(path)).toEqual([{ level: 1, coveragePct: "45" }]);
    writeFileSync(path, '{"level":1}');
    expect(readCatalogMeta(path)).toEqual({ level: 1 });
    expect(readCatalogMeta("/tmp/files-test/none.json")).toEqual([]);
  });

  it("names meta.json when it is not JSON", () => {
    const path = `${dir("meta-broken")}/meta.json`;
    writeFileSync(path, "[{level:1}]");
    expect(() => readCatalogMeta(path)).toThrow(/^meta\.json: не JSON/);
  });
});

describe("the breakdown files", () => {
  const file = (word: string) => `word\tn\tform\tlemma\tgloss\n${word}\t1\tБу\tбу\tэто\n`;

  it("reads the level files that exist, A1 first, and names the others", () => {
    const gloss = dir("gloss");
    writeFileSync(`${gloss}/b1.tsv`, file("су"));
    writeFileSync(`${gloss}/a1.tsv`, file("өй"));
    writeFileSync(`${gloss}/a3.tsv`, file("ял"));
    writeFileSync(`${gloss}/A2.TSV`, file("көн"));
    writeFileSync(`${gloss}/notes.txt`, "");
    expect(readGloss(gloss).map((g) => [g.level, g.lines[0]!.fields[0]])).toEqual([[1, "өй"], [3, "су"]]);
    expect(strayGlossFiles(gloss)).toEqual(["A2.TSV", "a3.tsv"]);
  });

  it("has none where there is no folder", () => {
    expect(readGloss("/tmp/files-test/no-gloss")).toEqual([]);
    expect(strayGlossFiles("/tmp/files-test/no-gloss")).toEqual([]);
    expect(GLOSS_DIR).toBe("data/gloss");
  });
});

describe("the working files", () => {
  it("reads the texts of the five specifications that keep the layout, A1 first", () => {
    const kfu = dir("kfu");
    for (const code of ["A1", "A2", "B1", "B2", "C1"]) {
      writeFileSync(`${kfu}/s_${code}.layout.txt`, `текст ${code}`);
      writeFileSync(`${kfu}/s_${code}.txt`, "другой текст");
    }
    expect(readKfuTexts(kfu)).toEqual([
      { level: "a1", text: "текст A1" }, { level: "a2", text: "текст A2" }, { level: "b1", text: "текст B1" }, { level: "b2", text: "текст B2" }, { level: "c1", text: "текст C1" },
    ]);
  });

  it("names the specification that is not there", () => {
    const kfu = dir("kfu-part");
    writeFileSync(`${kfu}/s_A1.layout.txt`, "текст");
    expect(() => readKfuTexts(kfu)).toThrow(`нет файла ${kfu}/s_A2.layout.txt`);
  });

  it("keeps the generated lists under data/work, which git ignores", () => {
    expect(levelCandidatesPath("a1")).toBe("data/work/candidates-a1.tsv");
    for (const path of [FILES.kfuLists, FILES.kfuPool, FILES.candidates, levelCandidatesPath("c1")]) expect(path.startsWith("data/work/")).toBe(true);
  });
});
