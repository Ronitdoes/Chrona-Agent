import { z } from "zod";
import { dateFrom } from "./clock";

const day = z.iso.date();

/** Convert the supported, unambiguous chart period labels to UTC positions. */
export function chartPeriod(label: string): number | undefined {
  let iso = label.trim().replace(/^Q([1-4]) (\d{4})$/i, "$2 Q$1");
  const quarter = /^(\d{4}) Q([1-4])$/i.exec(iso);
  if (quarter) {
    const [, year, value] = quarter;
    iso = `${year}-${String(Number(value) * 3 - 2).padStart(2, "0")}-01`;
  } else if (/^\d{4}$/.test(iso)) iso += "-01-01";
  else if (/^\d{4}-\d{2}$/.test(iso)) iso += "-01";
  return day.safeParse(iso).success ? dateFrom(`${iso}T00:00:00Z`).getTime() : undefined;
}
