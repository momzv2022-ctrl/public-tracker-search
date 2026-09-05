/**
 * Turn the published file into one with a key in it.
 *
 * The setup page inlines this file and calls `generate()`; the tests import it
 * and call the same function. So it is written to run unchanged in a browser
 * and in Node: no imports, no Node globals, nothing but `crypto` for the key.
 *
 * It is one exact line, `const API_KEY = "";`, rewritten with a JavaScript
 * literal of a key minted here. A line that is not found is an error, never a
 * silent skip — a Worker deployed with no key refuses every request, on
 * purpose, and the person pasting it would have no idea why.
 */

/** The line the page rewrites, anchored to its exact committed text. */
export const BLANKS = {
  API_KEY: 'const API_KEY = "";',
};

/** True when *source* carries the line above, exactly once. */
export function sourceUsable(source) {
  return Object.values(BLANKS).every((line) => source.split(line).length === 2);
}

/*
 * A key of 24 letters and digits from an alphabet with no look-alikes — no 0/o,
 * 1/l/i — in groups of four, because this is a value people copy by hand more
 * often than they expect to. Bytes at or above 248 are thrown away rather than
 * folded, so every letter is exactly as likely as every other. Twenty-four
 * letters from thirty-one is about 119 bits; the Worker insists on sixteen
 * characters at the least.
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CEILING = 256 - (256 % ALPHABET.length);

export function mintKey() {
  let out = "";
  let letters = 0;
  const scratch = new Uint8Array(32);
  while (letters < 24) {
    crypto.getRandomValues(scratch);
    for (let i = 0; i < scratch.length && letters < 24; i += 1) {
      if (scratch[i] >= CEILING) continue;
      if (letters && letters % 4 === 0) out += "-";
      out += ALPHABET[scratch[i] % ALPHABET.length];
      letters += 1;
    }
  }
  return out;
}

/**
 * A JavaScript string literal, so a value with a quote or a backslash in it
 * cannot end the string and become code.
 */
export function literal(value) {
  return JSON.stringify(String(value));
}

/**
 * The file, with a key written into it. Returns `{ code, key }`.
 *
 * Throws when the source has drifted from the line this expects, so a caller
 * cannot produce a file that would deploy without a key.
 */
export function generate(source, options = {}) {
  if (!sourceUsable(source)) {
    throw new Error("This page could not find the API_KEY line in the file. Do not use it, and please report this.");
  }
  const key = options.key || mintKey();
  if (key.length < 16) throw new Error("The key must be at least 16 characters.");
  // The replacement is a function, never a string: a string replacement reads
  // `$$`, `$&` and `$'` as patterns.
  const code = source.replace(BLANKS.API_KEY, () => `const API_KEY = ${literal(key)};`);
  return { code, key };
}
