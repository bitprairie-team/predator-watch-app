// Parsers for official update sources. Every item keeps the agency's title,
// date and link. Numbers are copied only when a strict pattern matches;
// otherwise the fact is omitted. Nothing is invented.

import type { UpdateKind, UpdateSource } from "../config/updates";

export interface UpdateItem {
  id: string;
  source_id: string;
  agency: string;
  credit_short: string;
  date: string;
  title: string;
  url: string;
  kind: UpdateKind;
}

export interface OfficialFact {
  id: string;
  source_id: string;
  label: string;
  value: string;
  year: number;
  agency: string;
  credit_short: string;
  date: string;
  url: string;
  attribution: string;
}

export interface ParseResult {
  items: UpdateItem[];
  facts: OfficialFact[];
}

const WOLF_TITLE = /\b(gray wolf|grey wolf|mexican wolf|canis lupus|wolves|wolf)\b/i;
const FR_SKIP =
  /information collection activities|recovery permit applications|foreign endangered species|wolf creek/i;

export function cleanText(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2014;|&#8212;|\u2014|\u2013/g, " - ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** ISO date (YYYY-MM-DD) from official titles or timestamps, or null. */
export function dateFromText(s: string): string | null {
  const t = cleanText(s);
  const iso = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const mdY = t.match(/\b([A-Za-z]+)\s+(\d{1,2}),\s*(20\d{2})\b/);
  if (mdY) {
    const mo = MONTHS[mdY[1]!.toLowerCase()];
    if (mo) return `${mdY[3]}-${String(mo).padStart(2, "0")}-${String(Number(mdY[2])).padStart(2, "0")}`;
  }
  const monthYear = t.match(/\b([A-Za-z]+)\s+(20\d{2})\b/);
  if (monthYear) {
    const mo = MONTHS[monthYear[1]!.toLowerCase()];
    if (mo) return `${monthYear[2]}-${String(mo).padStart(2, "0")}-01`;
  }
  const year = t.match(/\b(20\d{2})\b/);
  if (year) return `${year[1]}-01-01`;
  return null;
}

function kindFromTitle(title: string, fallback: UpdateKind): UpdateKind {
  if (/\b(monthly|annual|quarterly|monitoring|population survey|wolf report)\b/i.test(title)) return "report";
  if (/\b(federal register|final rule|proposed rule|status review|experimental population|listing)\b/i.test(title)) {
    return "status-notice";
  }
  if (/\bcount\b/i.test(title)) return "count";
  return fallback;
}

function item(src: UpdateSource, parts: { slug: string; title: string; url: string; date: string; kind?: UpdateKind }): UpdateItem {
  return {
    id: `${src.id}:${parts.slug}`.slice(0, 180),
    source_id: src.id,
    agency: src.agency,
    credit_short: src.creditShort,
    date: parts.date,
    title: cleanText(parts.title),
    url: parts.url,
    kind: parts.kind ?? kindFromTitle(parts.title, "news"),
  };
}

export function parseFederalRegister(src: UpdateSource, body: string): ParseResult {
  const data = JSON.parse(body) as {
    results?: { title?: string; publication_date?: string; type?: string; html_url?: string; abstract?: string }[];
  };
  const items: UpdateItem[] = [];
  for (const r of data.results ?? []) {
    const title = cleanText(r.title ?? "");
    const url = r.html_url ?? "";
    if (!title || !url) continue;
    if (!WOLF_TITLE.test(title)) continue;
    if (FR_SKIP.test(title)) continue;
    const date = r.publication_date && /^\d{4}-\d{2}-\d{2}$/.test(r.publication_date) ? r.publication_date : dateFromText(title);
    if (!date) continue;
    const slug = url.split("/").filter(Boolean).slice(-2).join("-");
    items.push(item(src, { slug, title, url, date, kind: "status-notice" }));
  }
  return { items, facts: [] };
}

function absUrl(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

export function parseHtmlLinks(src: Extract<UpdateSource, { type: "html-links" }>, body: string): ParseResult {
  const hrefRe = new RegExp(src.hrefRe, "i");
  const titleRe = src.titleRe ? new RegExp(src.titleRe, "i") : null;
  const max = src.maxItems ?? 20;
  const items: UpdateItem[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) && items.length < max) {
    const href = m[1] ?? "";
    const hm = href.match(hrefRe);
    if (!hm) continue;
    const title = cleanText(m[2] ?? "");
    if (!title || title.length < 8) continue;
    if (titleRe && !titleRe.test(title)) continue;
    const url = absUrl(href.replace(/&amp;/g, "&"), src.url);
    if (seen.has(url)) continue;
    seen.add(url);
    const slug = (hm[1] || url.split("/").filter(Boolean).pop() || title).replace(/\s+/g, "-");
    const date = dateFromText(title) ?? dateFromText(href) ?? "1970-01-01";
    items.push(item(src, { slug, title, url, date }));
  }
  return { items, facts: [] };
}

function fact(src: UpdateSource, id: string, label: string, count: number, year: number, extra: string, url: string): OfficialFact {
  const date = extra || String(year);
  const value = `${count} wolves`;
  return {
    id,
    source_id: src.id,
    label,
    value,
    year,
    agency: src.agency,
    credit_short: src.creditShort,
    date,
    url,
    attribution: `as reported by ${src.agency}, ${date}`,
  };
}

export function parseHtmlCount(src: Extract<UpdateSource, { type: "html-count" }>, body: string): ParseResult {
  const text = cleanText(body);
  const re = new RegExp(src.factRe, "gi");
  let best: { year: number; count: number; month?: string; packs?: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const year = Number(m.groups?.year ?? m[1]);
    const count = Number(m.groups?.count ?? m[2]);
    if (!Number.isInteger(year) || year < 1990 || year > 2100) continue;
    if (!Number.isInteger(count) || count <= 0 || count > 20000) continue;
    if (!best || year > best.year) {
      best = { year, count, month: m.groups?.month, packs: m.groups?.packs };
    }
  }
  if (!best) return { items: [], facts: [] };
  const date = best.month ? `${best.month} ${best.year}` : String(best.year);
  const f = fact(src, src.factId, src.factLabel, best.count, best.year, date, src.url);
  if (best.packs) f.value = `${best.count} wolves in ${best.packs} packs`;
  const title = `${src.factLabel}, ${date}`;
  return {
    facts: [f],
    items: [item(src, { slug: `${src.factId}-${best.year}`, title, url: src.url, date: dateFromText(date) ?? `${best.year}-01-01`, kind: "count" })],
  };
}

export function parseCsvCount(src: Extract<UpdateSource, { type: "csv-count" }>, body: string): ParseResult {
  const lines = body.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (lines.length < 2) return { items: [], facts: [] };
  const headers = lines[0]!.split(",").map((h) => h.trim());
  const yi = headers.indexOf(src.yearField);
  const ci = headers.indexOf(src.countField);
  if (yi < 0 || ci < 0) return { items: [], facts: [] };
  let best: { year: number; count: number } | null = null;
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const year = Number((cols[yi] ?? "").trim());
    const raw = (cols[ci] ?? "").trim();
    if (src.skipEmpty && (!raw || /^n\/?a$/i.test(raw))) continue;
    const count = Number(raw);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) continue;
    if (!Number.isInteger(count) || count <= 0 || count > 20000) continue;
    if (!best || year > best.year) best = { year, count };
  }
  if (!best) return { items: [], facts: [] };
  const f = fact(src, src.factId, src.factLabel, best.count, best.year, String(best.year), src.url);
  return {
    facts: [f],
    items: [
      item(src, {
        slug: `${src.factId}-${best.year}`,
        title: `${src.factLabel}, ${best.year}`,
        url: src.url,
        date: `${best.year}-01-01`,
        kind: "count",
      }),
    ],
  };
}

export function parseUpdateSource(src: UpdateSource, body: string): ParseResult {
  switch (src.type) {
    case "federal-register":
      return parseFederalRegister(src, body);
    case "html-links":
      return parseHtmlLinks(src, body);
    case "html-count":
      return parseHtmlCount(src, body);
    case "csv-count":
      return parseCsvCount(src, body);
  }
}
