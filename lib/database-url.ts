import { z } from "zod";

export const databaseUrlSchema = z.string().trim().min(1, "A PostgreSQL connection URL is required").refine(value => {
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) && Boolean(url.hostname) && url.pathname.length > 1;
  } catch { return false; }
}, "Expected a postgres:// or postgresql:// URL with a host and database name");
