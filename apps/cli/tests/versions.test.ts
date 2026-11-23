import { describe, expect, test } from "vite-plus/test";
import { versionNotes } from "../src/versions";

const bump = (note: string | undefined) =>
  note?.endsWith("there") ? "workflow" : note?.includes("update this one") ? "here" : note;

describe("versionNotes", () => {
  test("the same version as the running keypin says nothing", () => {
    expect(versionNotes([{ file: "a.yml", version: "0.39.0" }], "0.39.0")).toEqual([]);
  });

  test("compares each part as a number, and a release is newer than its prerelease", () => {
    expect(bump(versionNotes([{ file: "a.yml", version: "0.10.0" }], "0.9.0")[0])).toBe("here");
    expect(bump(versionNotes([{ file: "a.yml", version: "0.9.0" }], "0.10.0")[0])).toBe("workflow");
    expect(bump(versionNotes([{ file: "a.yml", version: "1.0.0" }], "1.0.0-rc.1")[0])).toBe("here");
    expect(bump(versionNotes([{ file: "a.yml", version: "1.0.0-rc.1" }], "1.0.0")[0])).toBe(
      "workflow",
    );
  });

  test("orders numeric prerelease parts as numbers", () => {
    expect(bump(versionNotes([{ file: "a.yml", version: "1.0.0-rc.10" }], "1.0.0-rc.9")[0])).toBe(
      "here",
    );
    expect(bump(versionNotes([{ file: "a.yml", version: "1.0.0-rc.9" }], "1.0.0-rc.10")[0])).toBe(
      "workflow",
    );
  });

  test("a version Bun can't compare still gets a note, without a direction", () => {
    const huge = "1.0.18446744073709551616";
    expect(versionNotes([{ file: "a.yml", version: huge }], "0.40.0")).toEqual([
      `a.yml installs keypin ${huge}, and this is keypin 0.40.0; make them the same version`,
    ]);
  });

  test("one note per version, naming each file once", () => {
    const notes = versionNotes(
      [
        { file: "a.yml", version: "0.38.0" },
        { file: "a.yml", version: "0.38.0" },
        { file: "b.yml", version: "0.38.0" },
        { file: "b.yml", version: "0.40.0" },
      ],
      "0.39.0",
    );
    expect(notes.map((note) => note.split(" install")[0])).toEqual(["a.yml, b.yml", "b.yml"]);
  });
});
