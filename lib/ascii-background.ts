const GLYPHS = " .,:;=+*#%@";
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// Fixed coordinates keep the decorative texture identical during hydration.
export function asciiBackgroundRows(frame = 0): string[] {
  const phase = ((Math.trunc(frame) % 16) + 16) % 16;
  return Array.from({ length: 125 }, (_, row) => {
    const y = row / 124;
    return Array.from({ length: 240 }, (_, column) => {
      const x = column / 239;
      const ribbon = Math.exp(-Math.pow((x - (0.64 + 0.22 * Math.sin(y * 6.2 - 0.8))) / 0.105, 2));
      const arc = Math.exp(-Math.pow((Math.hypot((x - 0.12) * 1.3, y - 0.74) - 0.37) / 0.045, 2));
      const folds = 0.58 + 0.42 * Math.sin(x * 19 - y * 12);
      // Leave the reading area quiet, with the ribbons strongest at the edges.
      const quietCenter = 1 - 0.88 * Math.exp(-Math.pow((x - 0.5) / 0.3, 4) - Math.pow((y - 0.53) / 0.24, 4));
      const density = Math.min(1, (ribbon * folds + arc * 0.55) * quietCenter);
      // Cycle the ordered thresholds so individual glyphs evolve in place.
      const threshold = (BAYER[(row % 4) * 4 + column % 4] + phase) % 16;
      const dither = (threshold / 16 - 0.5) * 0.2;
      const index = Math.max(0, Math.min(GLYPHS.length - 1, Math.floor((density + dither) * (GLYPHS.length - 1))));
      return GLYPHS[index];
    }).join("");
  });
}
