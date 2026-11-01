// Text folding shared by the input classifier, the data sanitizer, and the
// offline model mock. Undoes the cheap tricks used to hide words from keyword
// rules: Unicode compatibility forms (fullwidth, ligatures), zero-width and
// bidi control characters, combining marks (strike-through, accents), and
// look-alike letters from other scripts.

// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\u3164\ufeff\uffa0]/g;

/** Cyrillic and Greek letters that look like Latin ones. */
const CONFUSABLES: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s", і: "i", ї: "i", ј: "j", ԁ: "d", ɡ: "g", һ: "h", ӏ: "l", ԛ: "q", ԝ: "w",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X", Ѕ: "S", І: "I", Ј: "J",
  α: "a", ο: "o", ρ: "p", ε: "e", ι: "i", κ: "k", ν: "v", τ: "t", υ: "u", χ: "x", Α: "A", Β: "B", Ε: "E", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Χ: "X", Υ: "Y", Ζ: "Z",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");

/** Strip invisible characters only (keeps accents and case). */
export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, "");
}

/**
 * Fold text for matching: NFKC, invisible characters removed, look-alike
 * letters mapped to Latin, and combining marks removed (so "é" becomes "e").
 * Case is kept; callers lowercase as needed.
 */
export function foldText(s: string): string {
  return stripInvisible(s.normalize("NFKC"))
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC");
}

/** Decode base64 runs that hold readable text. Returns the decoded strings. */
export function decodeBase64Runs(s: string, minLength = 16): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
    const run = m[0];
    if (run.length < minLength || run.length % 4 === 1) continue;
    // Plain words and ids are not base64 of text.
    if (/^[a-z]+$/i.test(run) || /^[a-z0-9_-]+$/.test(run) && !/[A-Z]/.test(run)) continue;
    try {
      const bin = atob(run.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(run.length / 4) * 4, "="));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      const printable = [...text].filter((c) => /[\p{L}\p{N}\p{P}\s]/u.test(c)).length / Math.max(1, [...text].length);
      if (printable > 0.95 && /[a-z]{3,}/i.test(text) && /\s/.test(text)) out.push(text);
    } catch {
      /* not base64 text */
    }
  }
  return out;
}

/** Decode runs of hex byte pairs that hold readable text. */
export function decodeHexRuns(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/(?:\b|0x)((?:[0-9a-f]{2}[\s:]?){8,})/gi)) {
    const digits = m[1]!.replace(/[\s:]/g, "");
    if (digits.length % 2) continue;
    const bytes = new Uint8Array(digits.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      if (/^[\p{L}\p{N}\p{P}\s]+$/u.test(text) && /[a-z]{3,}/i.test(text)) out.push(text);
    } catch {
      /* not text */
    }
  }
  return out;
}

export function rot13(s: string): string {
  return s.replace(/[a-z]/gi, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}
