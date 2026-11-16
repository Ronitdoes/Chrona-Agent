import { describe, expect, it } from "vitest";
import { asciiBackgroundRows } from "./ascii-background";

describe("ASCII background texture", () => {
  it("produces a stable, bounded ASCII grid for server and client rendering", () => {
    const rows = asciiBackgroundRows();
    expect(rows).toEqual(asciiBackgroundRows());
    expect(rows).toHaveLength(125);
    expect(rows.every(row => row.length === 240 && /^[ .,:;=+*#%@]+$/.test(row))).toBe(true);
    expect(new Set(rows.join("")).size).toBeGreaterThan(6);
  });

  it.each([0, 200, 800])("keeps the reading center quiet as waves move at frame %i", frame => {
    const rows = asciiBackgroundRows(frame);
    const coverage = (lines: string[]) => lines.join("").replace(/ /g, "").length / lines.join("").length;
    const center = rows.slice(45, 80).map(row => row.slice(80, 160));
    const edges = rows.map(row => row.slice(0, 45) + row.slice(195));
    expect(coverage(center)).toBeLessThan(coverage(edges) / 2);
  });

  it("continuously refreshes grain while the waves evolve beyond the old short cycle", () => {
    const first = asciiBackgroundRows(0);
    expect(asciiBackgroundRows(1)).not.toEqual(first);
    expect(asciiBackgroundRows(16)).not.toEqual(first);
    expect(asciiBackgroundRows(800)).not.toEqual(first);
    expect(asciiBackgroundRows(800)).toEqual(asciiBackgroundRows(800));
    // Adjacent frames change fine grain without abruptly replacing the field.
    const next = asciiBackgroundRows(1).join("");
    const changed = first.join("").split("").filter((glyph, index) => glyph !== next[index]).length;
    expect(changed).toBeGreaterThan(100);
    expect(changed).toBeLessThan(240 * 125 / 3);
  });
});
