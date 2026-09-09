/**
 * The Worker as a link: a Cloudflare Playground URL with the whole file in it.
 *
 * The third way to deploy. Pasting needs no account but Cloudflare's; the
 * Deploy button needs a GitHub account as well; this needs neither a paste nor
 * a GitHub account. The Playground carries a Worker in the URL's *fragment* —
 * the part after `#`, which browsers never send to a server — so the link is
 * made here, in the browser, and opening it hands Cloudflare's editor the file
 * with the key already in it. Its Deploy button does the rest.
 *
 * The format is Cloudflare's, and it is not documented anywhere. It was read
 * off the live Playground on 2026-09-09: an ordinary `multipart/form-data`
 * body — one part per file, plus a `metadata` part naming the entry module —
 * prefixed with its own Content-Type and a colon, and then compressed with
 * lz-string into the fragment. A round trip through the real thing confirmed
 * it: the editor opened on this file and its preview served this Worker's own
 * front page. It can stop working the day Cloudflare changes it, which is why
 * it is offered third and why the other two routes stay.
 *
 * Written as an ES module so the tests can import it, with no imports and no
 * Node APIs, so the setup page can inline it as a plain script — the same deal
 * as `generator.js`.
 */

/** Any string that cannot occur in the parts. The Playground's own is like this. */
const BOUNDARY = "----WebKitFormBoundaryPublicTrackerSearch";

/** Where the link goes. The Playground, not the dashboard's deploy route: it
 *  shows the file before it deploys it, which is the habit this project would
 *  rather encourage, and it is the one that was tested. */
const PLAYGROUND = "https://workers.cloudflare.com/playground#";

/**
 * Safari refuses a URL longer than about 80,000 characters, and every browser
 * on iOS is Safari underneath. Chrome's ceiling is 2 MB and Firefox's is not
 * really a ceiling. This file is far too big to fit under Safari's, and the
 * only way to shrink it would be to strip the comments — which would mean
 * deploying something other than the file people were invited to read. So the
 * limit is stated rather than worked around.
 */
export const SAFARI_URL_LIMIT = 80000;

/** The multipart body the Playground expects, with its Content-Type in front. */
export function playgroundPayload(source, options = {}) {
  const compatibilityDate = options.compatibilityDate || "2025-01-01";
  const metadata = JSON.stringify({ compatibility_date: compatibilityDate, main_module: "index.js" });
  const part = (name, type, content) =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${name === "metadata" ? "blob" : name}"\r\n` +
    `Content-Type: ${type}\r\n\r\n${content}\r\n`;
  const body =
    part("index.js", "application/javascript+module", source) +
    part("metadata", "application/json", metadata) +
    `--${BOUNDARY}--\r\n`;
  return `multipart/form-data; boundary=${BOUNDARY}:${body}`;
}

/**
 * lz-string's `compressToEncodedURIComponent` (pieroxy, MIT), written out.
 *
 * LZW over a growing dictionary, packed six bits to a character from an
 * alphabet that needs no percent-encoding. It is here rather than imported
 * because this project has no dependencies and because a page that asks to be
 * read should not send anyone to npm to find out what it does.
 *
 * The bit order is the part to be careful with, and it is not uniform: a
 * dictionary index is written low bit first, but the two markers that
 * introduce a new entry are written as a run of zeros, or a one followed by
 * zeros. Faithful is the only thing that matters here — a decoder on the far
 * side has no way to tell you that you were nearly right.
 */
// Named for its job, not just "the alphabet": `generator.js` has one too,
// and the page inlines both files into a single script.
const LZ_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";
const BITS_PER_CHAR = 6;

export function compressToEncodedURIComponent(input) {
  if (input == null) return "";

  const out = [];
  let word = 0;
  let filled = 0;

  /** One bit into the current character; flush the character when it is full. */
  const bit = (value) => {
    word = (word << 1) | value;
    if (filled === BITS_PER_CHAR - 1) {
      out.push(LZ_ALPHABET.charAt(word));
      word = 0;
      filled = 0;
    } else {
      filled += 1;
    }
  };
  /** A number, low bit first — how indexes and character codes are written. */
  const lowFirst = (value, count) => {
    let rest = value;
    for (let i = 0; i < count; i += 1) {
      bit(rest & 1);
      rest >>= 1;
    }
  };
  /** `count` zeros: the marker for a new entry whose character fits in a byte. */
  const zeros = (count) => {
    for (let i = 0; i < count; i += 1) bit(0);
  };
  /** A one and then zeros: the marker for a new entry that needs two bytes. */
  const oneThenZeros = (count) => {
    bit(1);
    for (let i = 1; i < count; i += 1) bit(0);
  };

  const dictionary = new Map();
  const fresh = new Set();
  let dictSize = 3;
  let enlargeIn = 2;
  let numBits = 2;
  let w = "";

  /** One step of the countdown to the next dictionary index width. */
  const countDown = () => {
    enlargeIn -= 1;
    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits += 1;
    }
  };

  /**
   * Emit `w`: either its index, or the entry itself the first time it is seen.
   *
   * Spelling out a new entry costs the countdown twice, not once — lz-string
   * decrements inside that branch as well as after it, and the decoder counts
   * the same way. Getting this wrong still produces a plausible-looking string;
   * it just decodes to something else.
   */
  const emit = () => {
    if (fresh.has(w)) {
      const code = w.charCodeAt(0);
      if (code < 256) {
        zeros(numBits);
        lowFirst(code, 8);
      } else {
        oneThenZeros(numBits);
        lowFirst(code, 16);
      }
      fresh.delete(w);
      countDown();
    } else {
      lowFirst(dictionary.get(w), numBits);
    }
    countDown();
  };

  for (const c of splitToChars(input)) {
    if (!dictionary.has(c)) {
      dictionary.set(c, dictSize);
      dictSize += 1;
      fresh.add(c);
    }
    const wc = w + c;
    if (dictionary.has(wc)) {
      w = wc;
      continue;
    }
    emit();
    dictionary.set(wc, dictSize);
    dictSize += 1;
    w = c;
  }
  if (w !== "") emit();

  // The end marker, and then pad until the last character is complete.
  lowFirst(2, numBits);
  for (;;) {
    word = word << 1;
    if (filled === BITS_PER_CHAR - 1) {
      out.push(LZ_ALPHABET.charAt(word));
      break;
    }
    filled += 1;
  }
  return out.join("");
}

/**
 * Code units, not code points. lz-string works on UTF-16 units and writes a
 * lone unit above 255 with its 16-bit marker, so a surrogate pair has to stay
 * two units or the far side reassembles a different string.
 */
function splitToChars(input) {
  const chars = [];
  for (let i = 0; i < input.length; i += 1) chars.push(input.charAt(i));
  return chars;
}

/** The whole thing: a link that opens this file in Cloudflare's editor. */
export function playgroundUrl(source, options = {}) {
  return PLAYGROUND + compressToEncodedURIComponent(playgroundPayload(source, options));
}
