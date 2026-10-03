import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "../../src/content/csv";

describe("csv", () => {
  it("parses quoted fields with commas, quotes and newlines", () => {
    const rows = parseCsv('word,translation\n"it\'s up to you","решать тебе, «как хочешь»"\n"say ""hi""","сказать ""привет"""\n');
    expect(rows).toEqual([
      { word: "it's up to you", translation: "решать тебе, «как хочешь»" },
      { word: 'say "hi"', translation: 'сказать "привет"' },
    ]);
  });

  it("writes fields with commas, quotes and newlines so that they parse back", () => {
    const header = ["word", "translation", "audio_file_id"];
    const rows = [
      { word: "зур рәхмәт", translation: "большое спасибо, «спасибо»", audio_file_id: null },
      { word: 'әйт "сәлам"', translation: "скажи\nпривет", audio_file_id: "AwACAg" },
    ];
    const csv = toCsv(header, rows);
    expect(csv.split("\n")[0]).toBe("word,translation,audio_file_id");
    expect(parseCsv(csv)).toEqual([
      { word: "зур рәхмәт", translation: "большое спасибо, «спасибо»", audio_file_id: "" },
      { word: 'әйт "сәлам"', translation: "скажи\nпривет", audio_file_id: "AwACAg" },
    ]);
  });
});
