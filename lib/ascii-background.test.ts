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

  it("keeps the center quieter than the surrounding ribbons", () => {
    const rows = asciiBackgroundRows();
    const coverage = (lines: string[]) => lines.join("").replace(/ /g, "").length / lines.join("").length;
    const center = rows.slice(45, 80).map(row => row.slice(80, 160));
    const upperEdge = rows.slice(0, 35).map(row => row.slice(130, 210));
    expect(coverage(center)).toBeLessThan(coverage(upperEdge) / 2);
  });

  it("animates the dither thresholds with a seamless, deterministic cycle", () => {
    const first = asciiBackgroundRows(0);
    expect(asciiBackgroundRows(1)).not.toEqual(first);
    expect(asciiBackgroundRows(16)).toEqual(first);
    expect(asciiBackgroundRows(-1)).toEqual(asciiBackgroundRows(15));
    // Changing thresholds should alter grain, while retaining the ribbon shape.
    const next = asciiBackgroundRows(1).join("");
    const changed = first.join("").split("").filter((glyph, index) => glyph !== next[index]).length;
    expect(changed).toBeGreaterThan(100);
    expect(changed).toBeLessThan(240 * 125 / 3);
  });
});
