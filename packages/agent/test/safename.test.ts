import { describe, expect, it } from "vitest";
import { safeName } from "../src/message.js";

describe("safeName", () => {
  it("keeps a name as it was written", () => {
    expect(safeName("报告 v2（终稿）.txt")).toBe("报告 v2（终稿）.txt");
    expect(safeName("résumé.pdf")).toBe("résumé.pdf");
    expect(safeName("notes.md")).toBe("notes.md");
  });

  it("never climbs out of the folder", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("..\\..\\Windows\\win.ini")).toBe("win.ini");
    expect(safeName("/abs/path/x.txt")).toBe("x.txt");
    expect(safeName("..")).toBe("file");
    expect(safeName("")).toBe("file");
    expect(safeName("dir/")).toBe("dir");
  });

  it("drops what a file name cannot hold or a terminal would act on", () => {
    expect(safeName("a\u001b[2Jb.txt")).toBe("a_[2Jb.txt");
    expect(safeName("evil‮txt.exe")).toBe("evil_txt.exe");
    expect(safeName('a<b>c:d"e|f?g*h.txt')).toBe("a_b_c_d_e_f_g_h.txt");
    expect(safeName("line\nbreak.txt")).toBe("line_break.txt");
  });

  it("stays clear of names Windows refuses and of overlong names", () => {
    expect(safeName("CON.txt")).toBe("_CON.txt");
    expect(safeName("nul")).toBe("_nul");
    expect(safeName("trailing. ")).toBe("trailing");
    expect(Buffer.byteLength(safeName("字".repeat(300)))).toBeLessThanOrEqual(200);
  });
});
