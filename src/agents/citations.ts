// The citations-required rule. A final answer must cite at least one source
// returned by a tool this turn, using markers like [S1]. Markers that do not
// match a returned source are removed. An answer with no valid citation is
// replaced with "I don't know", unless it already says that.
import type { SourceRef } from "./types";

export interface Citation extends SourceRef {
  /** Marker used in the answer text, for example "S1". */
  cite: string;
}

export const IDK = "I don't know.";

export const FALLBACK_ANSWER =
  "I don't know. I could not find a sourced answer to that in the data I can read, so I won't guess.";

export interface CheckedAnswer {
  text: string;
  citations: Citation[];
  /** True if the model's answer was replaced because it had no valid citation. */
  replaced: boolean;
}

const MARKER = /\[(S\d{1,3})\]/g;

export function isIdk(text: string): boolean {
  return /^\s*i\s+don['’]t\s+know\b/i.test(text);
}

export function enforceCitations(text: string, catalog: Citation[]): CheckedAnswer {
  const byCite = new Map(catalog.map((c) => [c.cite, c]));
  const used: Citation[] = [];
  const cleaned = text
    .replace(MARKER, (m, id: string) => {
      const c = byCite.get(id);
      if (!c) return "";
      if (!used.includes(c)) used.push(c);
      return m;
    })
    .replace(/[ \t]+([.,;:])/g, "$1")
    .trim();
  if (used.length > 0) return { text: cleaned, citations: used, replaced: false };
  if (isIdk(cleaned)) return { text: cleaned, citations: [], replaced: false };
  return { text: FALLBACK_ANSWER, citations: [], replaced: true };
}

export function sourcesFooter(citations: Citation[]): string {
  if (!citations.length) return "";
  const lines = citations.map((c) => {
    const obs = c.observed_at ? `observed ${c.observed_at}` : "observed time not published";
    const rec = c.received_at ? `received ${c.received_at}` : "received time unknown";
    return `[${c.cite}] ${c.title}, ${c.publisher} (${obs}; ${rec})${c.url ? ` ${c.url}` : ""}`;
  });
  return `\n\nSources:\n${lines.join("\n")}`;
}
