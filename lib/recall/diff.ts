export type Verdict = "changed" | "unchanged" | "unknown";
type Period = "hour" | "day" | "week" | "month" | "year";

export type Parsed =
  | { kind: "money"; currency: string; amount: string; unit: string | null; period: Period | null; billing: Period | null }
  | { kind: "quantity"; amount: string; unit: string; period: Period | null }
  | { kind: "version"; version: string }
  | { kind: "boolean"; value: boolean };

export type ClaimDiff = { verdict: Verdict; oldParsed?: Parsed; newParsed?: Parsed };
type Match = { parsed: Parsed; start: number; end: number };

const numberPattern = String.raw`\d+(?:(?:[.,]\d+)|(?:[ \u00a0\u202f]\d{3}(?!\d)))*`;
const currencyPattern = String.raw`(?:US\$|CA?\$|AU?\$|USD|EUR|GBP|INR|CAD|AUD|JPY|[$€£₹¥])`;
const currencies: Record<string, string> = {
  "$": "USD", "US$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY",
  "C$": "CAD", "CA$": "CAD", "A$": "AUD", "AU$": "AUD",
};
const units: Record<string, string> = {
  user: "seat", users: "seat", seat: "seat", seats: "seat",
  account: "seat", accounts: "seat", request: "request", requests: "request",
  token: "token", tokens: "token", project: "project", projects: "project",
  company: "company", companies: "company",
};
const periods: Record<string, Period> = {
  hour: "hour", hours: "hour", hr: "hour", hrs: "hour", hourly: "hour",
  day: "day", days: "day", daily: "day", week: "week", weeks: "week", wk: "week", weekly: "week",
  month: "month", months: "month", mo: "month", mos: "month", mth: "month", monthly: "month",
  year: "year", years: "year", yr: "year", yrs: "year", annual: "year", annually: "year", yearly: "year",
};

/** Exact decimal canonicalization, without Number rounding or currency conversion. */
function decimal(raw: string): string | undefined {
  let value = raw.replace(/\s/g, "");
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const separator = comma > dot ? "," : ".";
    const grouping = separator === "," ? "." : ",";
    value = value.split(grouping).join("").replace(separator, ".");
  } else if (comma >= 0) {
    value = /^\d{1,3}(?:,\d{3})+$/.test(value) ? value.replace(/,/g, "") : value.replace(",", ".");
  } else if ((value.match(/\./g)?.length ?? 0) > 1) {
    if (!/^\d{1,3}(?:\.\d{3})+$/.test(value)) return;
    value = value.replace(/\./g, "");
  }
  if (!/^\d+(?:\.\d+)?$/.test(value)) return;
  const [integer, fraction = ""] = value.split(".");
  const whole = integer.replace(/^0+(?=\d)/, "");
  const tail = fraction.replace(/0+$/, "");
  return tail ? `${whole}.${tail}` : whole;
}

function rate(text: string): { unit: string | null; period: Period | null; length: number } {
  let rest = text;
  let unit: string | null = null;
  let period: Period | null = null;
  for (let i = 0; i < 3; i++) {
    const match = /^\s*(?:(?:\/|per\b)\s*([a-z]+)\b|(hourly|daily|weekly|monthly|annually|annual|yearly)\b)/i.exec(rest);
    if (!match) break;
    const token = (match[1] ?? match[2]).toLowerCase();
    if (Object.hasOwn(periods, token) && !period) period = periods[token];
    else if (!Object.hasOwn(periods, token) && !unit) unit = Object.hasOwn(units, token) ? units[token] : token;
    else break;
    rest = rest.slice(match[0].length);
  }
  return { unit, period, length: text.length - rest.length };
}

function money(text: string): Match[] {
  const pattern = new RegExp(`(${currencyPattern})\\s*(${numberPattern})|(${numberPattern})\\s*(${currencyPattern})(?![a-z])`, "gi");
  const results: Match[] = [];
  for (const match of text.matchAll(pattern)) {
    const amount = decimal(match[2] ?? match[3]);
    if (amount === undefined) continue;
    const symbol = (match[1] ?? match[4]).toUpperCase();
    const suffix = rate(text.slice(match.index + match[0].length));
    const billingText = text.slice(match.index + match[0].length + suffix.length);
    const billingMatch = /^\s*[,;(]?\s*(?:billed|billing|paid|payable)\s+(monthly|annually|yearly|weekly|daily|hourly)\b/i.exec(billingText);
    results.push({
      start: match.index, end: match.index + match[0].length + suffix.length,
      parsed: {
        kind: "money", currency: currencies[symbol] ?? symbol, amount,
        unit: suffix.unit, period: suffix.period,
        billing: billingMatch ? periods[billingMatch[1].toLowerCase()] : null,
      },
    });
  }
  return results;
}

const byteFactors: Record<string, bigint> = {
  byte: BigInt(1), bytes: BigInt(1),
  kb: BigInt(1000), mb: BigInt(1000) ** BigInt(2), gb: BigInt(1000) ** BigInt(3), tb: BigInt(1000) ** BigInt(4),
  kib: BigInt(1024), mib: BigInt(1024) ** BigInt(2), gib: BigInt(1024) ** BigInt(3), tib: BigInt(1024) ** BigInt(4),
};

function multiply(amount: string, factor: bigint): string {
  const places = amount.split(".")[1]?.length ?? 0;
  const scaled = (BigInt(amount.replace(".", "")) * factor).toString().padStart(places + 1, "0");
  return decimal(places ? `${scaled.slice(0, -places)}.${scaled.slice(-places)}` : scaled)!;
}

function quantities(text: string): Match[] {
  const pattern = new RegExp(`(${numberPattern})\\s*(bytes?|[kmgt]i?b|users?|seats?|accounts?|requests?|tokens?|projects?|%)(?![a-z])`, "gi");
  const results: Match[] = [];
  for (const match of text.matchAll(pattern)) {
    const parsedAmount = decimal(match[1]);
    if (parsedAmount === undefined) continue;
    const token = match[2].toLowerCase();
    const factor = byteFactors[token];
    const suffix = rate(text.slice(match.index + match[0].length));
    results.push({
      start: match.index, end: match.index + match[0].length + suffix.length,
      parsed: {
        kind: "quantity", amount: factor ? multiply(parsedAmount, factor) : parsedAmount,
        unit: factor ? "byte" : units[token] ?? token, period: suffix.period,
      },
    });
  }
  return results;
}

function versions(text: string): Match[] {
  const excluded = [...money(text), ...quantities(text)];
  const pattern = /(?:\b(?:version\s+|v))?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([a-z0-9.-]+))?(?:\+([a-z0-9.-]+))?/gi;
  const results: Match[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!match[2] && !/^v/i.test(match[0])) continue;
    if (/[\w.]/.test(text[start - 1] ?? "") || /[\w.]/.test(text[end] ?? "")) continue;
    if (excluded.some((item) => start < item.end && end > item.start)) continue;
    const core = [match[1], match[2] ?? "0", match[3] ?? "0"].map((part) => part.replace(/^0+(?=\d)/, "")).join(".");
    const prerelease = match[4]?.replace(/\.+$/, "");
    results.push({ start, end, parsed: { kind: "version", version: `${core}${prerelease ? `-${prerelease}` : ""}` } });
  }
  return results;
}

function booleans(text: string): Match[] {
  const pattern = /\b((?:(?:not|never)|\w+n['’]t)\s+(?:(?:currently|yet|now)\s+)?|no\s+longer\s+)?(true|false|yes|no|enabled|disabled|supported|unsupported)\b/gi;
  const results: Match[] = [];
  for (const match of text.matchAll(pattern)) {
    const token = match[2].toLowerCase();
    if (/^(true|false|yes|no)$/.test(token) && !/^\s*(?:true|false|yes|no)[.!]?\s*$/i.test(text) &&
      !/(?:\bis\b|:)\s*$/i.test(text.slice(0, match.index))) continue;
    const positive = /^(true|yes|enabled|supported)$/.test(token);
    results.push({ start: match.index, end: match.index + match[0].length,
      parsed: { kind: "boolean", value: match[1] ? !positive : positive } });
  }
  return results;
}

const extract = { money, quantity: quantities, version: versions, boolean: booleans };

function unique(matches: Match[]): Parsed[] {
  return [...new Map(matches.map((match) => [JSON.stringify(match.parsed), match.parsed])).values()];
}

function comparable(old: Parsed, fresh: Parsed): boolean {
  if (old.kind !== fresh.kind) return false;
  if (old.kind === "money" && fresh.kind === "money") {
    return old.currency === fresh.currency && old.unit === fresh.unit &&
      Boolean(old.period) === Boolean(fresh.period) && Boolean(old.billing) === Boolean(fresh.billing);
  }
  if (old.kind === "quantity" && fresh.kind === "quantity") {
    return old.unit === fresh.unit && Boolean(old.period) === Boolean(fresh.period);
  }
  return true;
}

/** Compares values only. Use revalidateClaim for a dated, source-backed verdict. */
export function diffClaim(oldValue: string, evidenceText: string): ClaimDiff {
  let baseline: Parsed[] = [];
  for (const parser of [money, quantities, versions, booleans]) {
    baseline = unique(parser(oldValue));
    if (baseline.length) break;
  }
  if (baseline.length !== 1) return { verdict: "unknown" };
  const oldParsed = baseline[0];
  const candidates = unique(extract[oldParsed.kind](evidenceText));
  const matches = candidates.filter((candidate) => comparable(oldParsed, candidate));
  if (matches.length !== 1) {
    return { verdict: "unknown", oldParsed, ...(candidates.length === 1 ? { newParsed: candidates[0] } : {}) };
  }
  const newParsed = matches[0];
  return { verdict: JSON.stringify(oldParsed) === JSON.stringify(newParsed) ? "unchanged" : "changed", oldParsed, newParsed };
}

/** No source date, older/conflicting evidence, or future evidence cannot verify a claim. */
export function revalidateClaim(
  claim: { value: string; asOf: Date },
  evidence: { text: string; publishedAt: Date | null },
  nowInstant: Date,
): ClaimDiff {
  const comparison = diffClaim(claim.value, evidence.text);
  const dates = [claim.asOf.getTime(), evidence.publishedAt?.getTime() ?? NaN, nowInstant.getTime()];
  if (!dates.every(Number.isFinite) || !(dates[0] < dates[1] && dates[1] <= dates[2])) {
    return { ...comparison, verdict: "unknown" };
  }
  return comparison;
}
