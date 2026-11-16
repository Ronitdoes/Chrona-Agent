const GLYPHS = " .,:;=+*#%@";
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function grain(column: number, row: number, frame: number): number {
  let hash = Math.imul(column + 1, 374761393) ^ Math.imul(row + 1, 668265263) ^ Math.imul(frame + 1, 1442695041);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

// Ten frames per second. Seeded grain and continuous flow keep hydration stable
// while the wave field evolves without a short, visibly repeating frame loop.
export function asciiBackgroundRows(frame = 0): string[] {
  const tick = Number.isFinite(frame) ? Math.trunc(frame) : 0;
  const time = tick / 10;
  const driftX = 0.18 * Math.sin(time * 0.11) + 0.1 * Math.sin(time * 0.043 + 1.2);
  const driftY = 0.16 * Math.cos(time * 0.09 + 1.1) + 0.09 * Math.sin(time * 0.067);
  const angleA = 0.55 + 0.48 * Math.sin(time * 0.053) + 0.22 * Math.sin(time * 0.093 + 2);
  const angleB = -0.9 + 0.46 * Math.cos(time * 0.047 + 1);
  const directionA = { x: Math.cos(angleA), y: Math.sin(angleA) };
  const directionB = { x: Math.cos(angleB), y: Math.sin(angleB) };

  return Array.from({ length: 125 }, (_, row) => {
    const y = row / 124;
    return Array.from({ length: 240 }, (_, column) => {
      const x = column / 239;
      const u = (x - 0.5) * 1.44 + driftX;
      const v = y - 0.5 + driftY;
      const warp = 0.12 * Math.sin(u * 3.4 + v * 4.1 + time * 0.14)
        + 0.055 * Math.cos(u * 7.2 - v * 3.5 - time * 0.11);
      const phaseA = (u * directionA.x + v * directionA.y + warp) * 18 - time * 0.24;
      const phaseB = (u * directionB.x + v * directionB.y - warp * 0.7) * 13 + time * 0.19 + 1.7;
      const crestA = Math.exp(-(Math.sin(phaseA) ** 2) * 8);
      const crestB = Math.exp(-(Math.sin(phaseB) ** 2) * 10);
      const swell = 0.7 + 0.3 * Math.sin(u * 3 - v * 4 + time * 0.1);
      const quietCenter = 1 - 0.9 * Math.exp(-(((x - 0.5) / 0.32) ** 4) - ((y - 0.53) / 0.3) ** 4);
      const density = Math.min(1, (crestA * 0.65 + crestB * 0.32) * swell * quietCenter);
      const ordered = (BAYER[(row % 4) * 4 + column % 4] / 16 - 0.5) * 0.07;
      const dither = ordered + (grain(column, row, tick) - 0.5) * 0.17;
      const index = Math.max(0, Math.min(GLYPHS.length - 1, Math.floor((density + dither) * (GLYPHS.length - 1))));
      return GLYPHS[index];
    }).join("");
  });
}
