/**
 * The Worker's tests: offline, against recorded answers.
 *
 * Every public index is a fixture in `worker/tests/fixtures/` — the real body a
 * site sent once — and the network is a table. Nothing here touches a site.
 * Whether a site still talks to *your* Worker is a different question, and
 * `/api/v1/engines?probe=1` is how it is asked.
 *
 * Inherited from the Unified Torrent Search Interface, which this Worker is a
 * fork of; the protocol tests are unchanged on purpose, because the API is.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { __testing } from "../src/worker.js";

const {
  BROWSE_TERMS,
  ENGINES,
  ENGINE_BREADTH,
  FEED,
  KNOWN_ENGINES,
  LIVENESS,
  MIN_KEY_LENGTH,
  RESOLUTION_SPELLINGS,
  SEED_DESCRIPTORS,
  TSP_CATEGORIES,
  UPDATE_MEMO,
  VERSION,
  applyFilters,
  coerceValue,
  compileSelector,
  descriptorProblem,
  htmlRows,
  infohashFromText,
  intOrNone,
  readFeed,
  refreshFeed,
  resetFeed,
  selectorProblem,
  tryDescriptor,
  resolvePath,
  browseQuery,
  classifyName,
  handle,
  htmlUnescape,
  humanSize,
  landingPage,
  magnetFor,
  matchesTerms,
  merge,
  normalizeInfohash,
  normalizeQuery,
  originsFor,
  parseName,
  parseTorrent,
  parseTorznab,
  probe,
  queryTerms,
  pubDate,
  readQuery,
  readSettings,
  render,
  search,
  toTorrent,
} = __testing;

/** Every descriptor engine's address book, best address first, as the seed ships it. */
const ENGINE_ORIGINS = Object.fromEntries(SEED_DESCRIPTORS.map((d) => [d.name, d.origins]));

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const SOURCE = join(HERE, "..", "src", "worker.js");

const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");
const KEY = "k".repeat(32);

const UPSTREAM_BASE = "https://index.test";
const UPSTREAM = UPSTREAM_BASE + "/api/v1/search";
const KNABEN = "https://api.knaben.org/v1";
const PIRATEBAY = "https://apibay.org/q.php";
const TORRENTSCSV = "https://torrents-csv.com/service/search";
const YTS = ENGINE_ORIGINS.yts[0] + "/api/v2/list_movies.json";
const BITSEARCH = "https://bitsearch.eu/api/v1/search";
const TORRENTDOWNLOAD = "https://www.torrentdownload.info/search";
const TORRENTDOWNLOADS = "https://www.torrentdownloads.pro/rss.xml";
const RUTOR = "https://rutor.info/search/";
const TORRENTKITTY = "https://www.torrentkitty.tv/search/";
const SUKEBEI = "https://sukebei.nyaa.si/?page=rss";
const DMHY = "https://share.dmhy.org/topics/rss/rss.xml";
const ARCHIVE = "https://archive.org/advancedsearch.php";
const NYAA = "https://nyaa.si/?page=rss";
const ANIMETOSHO = "https://feed.animetosho.org/json";
const EZTVX = "https://eztvx.to/api/get-torrents";

/**
 * Answers from a URL-prefix table. A value may be a fixture name, a `[status,
 * body]` pair, an Error to throw, or a literal string.
 */
function stub(routes) {
  const client = {
    calls: [],
    async text(url, options = {}) {
      client.calls.push({ url, ...options });
      for (const [prefix, route] of Object.entries(routes)) {
        if (!url.startsWith(prefix)) continue;
        if (route instanceof Error) throw route;
        if (Array.isArray(route)) return route;
        if (typeof route === "object") return [200, JSON.stringify(route)];
        return [200, String(route)];
      }
      return [404, ""];
    },
    async bytes(url, options = {}) {
      client.calls.push({ url, ...options });
      for (const [prefix, route] of Object.entries(routes)) {
        if (url.startsWith(prefix)) return [200, route];
      }
      return [404, new Uint8Array()];
    },
    asked(prefix) {
      const matching = client.calls.filter((call) => call.url.startsWith(prefix));
      assert.equal(matching.length, 1, `expected exactly one call to ${prefix}`);
      return matching[0];
    },
  };
  return client;
}

function settings(overrides = {}) {
  return {
    ...readSettings({ UTSI_API_KEY: KEY, UTSI_UPSTREAM_URL: UPSTREAM_BASE }),
    ...overrides,
  };
}

function ask(overrides = {}) {
  return {
    q: "bunny",
    cat: "",
    year: "",
    res: "",
    minSeeders: 0,
    sort: "",
    limit: 50,
    offset: 0,
    terms: "",
    ...overrides,
  };
}

/** The query as an engine receives it: `terms` already normalised. */
const engineQuery = (terms, extra = {}) => ask({ q: terms, terms, ...extra });

const authed = () => new Headers({ "x-api-key": KEY });
const run = (method, url, headers, http, config) =>
  handle(method, url, headers instanceof Headers ? headers : new Headers(headers), http, config);

// ───────────────────────────────────────────────────────────────────────────
// The artifact
// ───────────────────────────────────────────────────────────────────────────

test("the artifact is one file, dependency-free, and nowhere near the size limit", () => {
  const source = readFileSync(SOURCE, "utf8");

  // No third-party code in the Worker. Same rule as the repository's "no plugin
  // code lives here" — and here it is also forced, since a Worker has no
  // sandbox to run someone else's code in.
  const imports = [...source.matchAll(/^\s*import\s.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, [], "the Worker must import nothing");
  assert.ok(!/\brequire\s*\(/.test(source), "the Worker must not require() anything");

  // The free plan allows 3 MB. Being orders of magnitude under it is the point:
  // this is a file a person can read before pasting it.
  assert.ok(Buffer.byteLength(source) < 3 * 1024 * 1024);
  // UTSI held this at 182 KB. The HTML engine — a selector parser and a
  // streaming HTML scanner, the machinery that turns a search page into rows —
  // and eight more indexes took it to where it is. Raise it again only for an
  // engine or a fix to what the Worker answers, never to make room for prose:
  // if it binds because a comment grew, the comment is what gives.
  assert.ok(Buffer.byteLength(source) < 240 * 1024, "it should stay readable, not just legal");

  // Readable means unminified. A blob is exactly what a cautious reader refuses.
  const lines = source.split("\n");
  const longest = Math.max(...lines.map((line) => line.length));
  assert.ok(longest < 200, `line of ${longest} characters — is this still hand-written?`);
});

test("no key ships with the artifact", () => {
  const source = readFileSync(SOURCE, "utf8");
  assert.match(source, /^const API_KEY = "";$/m, "the committed artifact must fail closed");
});

test("an unconfigured worker refuses everything", async () => {
  const bare = settings({ apiKey: "", allowAnonymous: false });
  const refusal = await run("GET", "https://w.dev/api/v1/search?q=x", authed(), stub({}), bare);
  assert.equal(refusal.status, 503);
  assert.equal(refusal.body.error, "not_configured");

  const health = await run("GET", "https://w.dev/healthz", {}, stub({}), bare);
  assert.equal(health.body.status, "not_configured");
  assert.equal(health.body.api_key, "missing");
});

test("a short key says it is short rather than absent", async () => {
  // "This Worker has no API key" is actively misleading when the key is there
  // and merely short: it sends you looking for a value you already set.
  const short = settings({ apiKey: "mykey123" });
  const refusal = await run(
    "GET",
    "https://w.dev/api/v1/search?q=x",
    { "x-api-key": "mykey123" },
    stub({}),
    short,
  );
  assert.equal(refusal.status, 503);
  assert.equal(refusal.body.error, "api_key_too_short");
  assert.match(refusal.body.detail, /8 characters/);
  assert.match(refusal.body.detail, /at least 16/);
  assert.match(refusal.body.detail, /Edit code/);
});

test("a key of exactly the minimum is accepted", async () => {
  const key = "a".repeat(MIN_KEY_LENGTH);
  const config = settings({ apiKey: key, engines: ["torrentscsv"] });
  const http = stub({ [TORRENTSCSV]: fixture("torrentscsv.json") });
  const reply = await run("GET", "https://w.dev/api/v1/search?q=bunny", { "x-api-key": key }, http, config);
  assert.equal(reply.status, 200);
});

// ───────────────────────────────────────────────────────────────────────────
// Engines
// ───────────────────────────────────────────────────────────────────────────

test("upstream passes TSP rows straight through, keeping their provenance", async () => {
  const http = stub({ [UPSTREAM]: fixture("upstream.json") });
  const rows = await ENGINES.upstream(http, engineQuery("big buck bunny"), settings());

  assert.equal(rows.length, 3);
  assert.equal(rows[0].infohash, "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c");
  assert.equal(rows[0].sizeBytes, 1073741824);
  assert.equal(rows[0].files, 4);
  assert.equal(rows[0].seeders, 512);
  assert.equal(rows[0].category, "video");
  assert.equal(rows[0].firstSeen, "2018-12-31T00:00:00Z");
  // Which plugins upstream found it with, kept distinct from our own ids.
  assert.deepEqual(rows[0].sources, ["upstream/1337x", "upstream/piratebay"]);
});

test("upstream sends its key, forwards the filters, and keeps sort and paging local", async () => {
  const http = stub({ [UPSTREAM]: fixture("upstream.json") });
  const query = engineQuery("bunny", { cat: "video", year: "2008", res: "1080p", minSeeders: 5, sort: "size", offset: 50 });
  await ENGINES.upstream(http, query, settings({ maxRowsPerEngine: 75, upstreamApikey: "u".repeat(40) }));

  const call = http.asked(UPSTREAM);
  const sent = new URL(call.url).searchParams;
  assert.equal(call.headers["X-API-Key"], "u".repeat(40));
  assert.equal(sent.get("q"), "bunny");
  assert.equal(sent.get("cat"), "video");
  assert.equal(sent.get("year"), "2008");
  assert.equal(sent.get("res"), "1080p");
  assert.equal(sent.get("min_seeders"), "5");
  // Filtering upstream is why the row cap buys relevant rows rather than a
  // hundred mixed ones that mostly get thrown away here.
  assert.equal(sent.get("limit"), "75");
  assert.equal(sent.get("sort"), null);
  assert.equal(sent.get("offset"), null);
});

test("upstream reuses the metadata it already parsed", async () => {
  // The far side ran the same parser, so seeding its answer skips the most
  // expensive step in the pipeline for every row that reaches the page.
  const http = stub({ [UPSTREAM]: fixture("upstream.json") });
  const rows = await ENGINES.upstream(http, engineQuery("bunny"), settings());
  assert.deepEqual(rows[0].meta, { year: "2008", resolution: "1080p", codec: "x264", source: "bluray" });
  assert.equal(rows[1].meta.season, "01");
  assert.equal(rows[1].meta.episode, "02");
  // The third row carries none, so it must fall back to a local parse rather
  // than being pinned to an empty object.
  assert.equal(rows[2].meta, null);
});

test("upstream tells the three auth failures apart", async () => {
  // A bare status leaves "key not set", "key wrong" and "header lost in
  // transit" looking identical, and they are fixed in three different places.
  await assert.rejects(
    () => ENGINES.upstream(stub({ [UPSTREAM]: [403, ""] }), engineQuery("x"), settings()),
    /does not match/,
  );
  await assert.rejects(
    () =>
      ENGINES.upstream(stub({ [UPSTREAM]: [401, ""] }), engineQuery("x"), settings({ upstreamApikey: "" })),
    /UTSI_UPSTREAM_APIKEY is not set/,
  );
  await assert.rejects(
    () =>
      ENGINES.upstream(
        stub({ [UPSTREAM]: [401, ""] }),
        engineQuery("x"),
        settings({ upstreamApikey: "u".repeat(40) }),
      ),
    /saw none/,
  );
});

test("upstream still reports other statuses plainly, and needs a base URL", async () => {
  await assert.rejects(
    () => ENGINES.upstream(stub({ [UPSTREAM]: [502, ""] }), engineQuery("x"), settings()),
    /HTTP 502/,
  );
  await assert.rejects(
    () => ENGINES.upstream(stub({ [UPSTREAM]: "<html>" }), engineQuery("x"), settings()),
    /not JSON/,
  );
  await assert.rejects(
    () => ENGINES.upstream(stub({}), engineQuery("x"), settings({ upstreamUrl: "" })),
    /UTSI_UPSTREAM_URL/,
  );
});

test("upstream drops rows it cannot hand to a client, and recovers a hash from a magnet", async () => {
  const withMagnet = { torrents: [{ magnet: "magnet:?xt=urn:btih:" + "9".repeat(40), name: "No infohash field" }] };
  const rows = await ENGINES.upstream(stub({ [UPSTREAM]: withMagnet }), engineQuery("x"), settings());
  assert.deepEqual(rows.map((row) => row.infohash), ["9".repeat(40)]);

  const junk = { torrents: [{ name: "no magnet, no hash" }, { magnet: "not-a-magnet", name: "junk" }] };
  assert.deepEqual(await ENGINES.upstream(stub({ [UPSTREAM]: junk }), engineQuery("x"), settings()), []);
});

test("knaben reads hits, keeps the tracker as provenance, and asks with a POST", async () => {
  const http = stub({ [KNABEN]: fixture("knaben.json") });
  const rows = await ENGINES.knaben(http, engineQuery("big buck bunny"), settings({ maxRowsPerEngine: 75 }));

  assert.equal(rows.length, 2, "the titleless third hit is dropped");
  assert.equal(rows[0].infohash, "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c", "lowercased");
  assert.equal(rows[0].seeders, 340);
  assert.equal(rows[0].leechers, 12);
  assert.equal(rows[0].firstSeen, "2019-01-01T00:00:00+00:00");
  assert.deepEqual(rows[0].sources, ["knaben/1337x"]);
  // No hash field: the infohash comes out of the magnet, and their habit of
  // sending numbers as strings is survived.
  assert.equal(rows[1].infohash, "a".repeat(40));
  assert.equal(rows[1].sizeBytes, 2147483648);
  assert.equal(rows[1].name, "Sintel 2010 4K Remaster & Extras", "unescaped");
  // Category is deliberately absent — their scheme is not TSP's — so the local
  // name classifier must have something to work with.
  assert.ok(rows.every((row) => row.category === null));

  const call = http.asked(KNABEN);
  assert.equal(call.method, "POST");
  assert.equal(call.headers["Content-Type"], "application/json");
  const body = JSON.parse(call.body);
  assert.equal(body.query, "big buck bunny");
  assert.equal(body.size, 75);
  assert.equal(body.hide_unsafe, true);
  // Exact matching, never `score`: fuzzy matching plus a seeders sort throws the
  // score away and answers with the whole index.
  assert.equal(body.search_type, "100%");
});

test("knaben rejects answers that are not its API", async () => {
  await assert.rejects(() => ENGINES.knaben(stub({ [KNABEN]: [503, ""] }), engineQuery("x"), settings()), /HTTP 503/);
  await assert.rejects(() => ENGINES.knaben(stub({ [KNABEN]: "<html>" }), engineQuery("x"), settings()), /not JSON/);
  await assert.rejects(
    () => ENGINES.knaben(stub({ [KNABEN]: { unexpected: [] } }), engineQuery("x"), settings()),
    /hits/,
  );
});

test("piratebay reads the array, unescapes names and maps only the safe categories", async () => {
  const http = stub({ [PIRATEBAY]: fixture("piratebay.json") });
  const rows = await ENGINES.piratebay(http, engineQuery("big buck bunny"), settings());

  assert.equal(rows.length, 3, "the nameless fourth row is dropped");
  assert.equal(rows[0].infohash, "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c", "lowercased");
  // Everything arrives as a string, sizes and swarm counts alike.
  assert.equal(rows[0].sizeBytes, 1073741824);
  assert.equal(rows[0].seeders, 340);
  assert.equal(rows[0].leechers, 12);
  assert.equal(rows[0].files, 3);
  assert.equal(rows[0].firstSeen, "2019-01-01T00:00:00Z");
  assert.equal(rows[0].category, "video", "201 is in the 200s");
  assert.equal(rows[0].descriptionUrl, "https://thepiratebay.org/description.php?id=12345678");
  assert.deepEqual(rows[0].sources, ["piratebay"]);

  assert.equal(rows[1].name, "Sintel 2010 4K Remaster & Extras", "unescaped");
  // The 600s are a grab bag — 601 is ebooks, 603 is images — so the decade is
  // not mapped and the name classifier gets its turn instead.
  assert.equal(rows[1].category, null, "601 is left for the name classifier");
  assert.equal(rows[2].category, "audio", "104 is in the 100s");
  // A size of zero is them saying nothing useful, not a zero-byte torrent.
  assert.equal(rows[2].sizeBytes, null);
  assert.equal(rows[2].firstSeen, null, "an `added` of 0 is not a date");

  assert.match(http.asked(PIRATEBAY).url, /q=big\+buck\+bunny/);
});

test("piratebay treats their one-row 'no results' answer as no results", async () => {
  // Taken at face value it is a torrent, and it would be merged, counted and
  // handed to a client as a magnet link pointing at nothing.
  const http = stub({ [PIRATEBAY]: fixture("piratebay-empty.json") });
  assert.deepEqual(await ENGINES.piratebay(http, engineQuery("nothing at all"), settings()), []);
});

test("piratebay honours the row cap and rejects answers that are not its API", async () => {
  const http = stub({ [PIRATEBAY]: fixture("piratebay.json") });
  const rows = await ENGINES.piratebay(http, engineQuery("x"), settings({ maxRowsPerEngine: 2 }));
  assert.equal(rows.length, 2);

  await assert.rejects(
    () => ENGINES.piratebay(stub({ [PIRATEBAY]: [503, ""] }), engineQuery("x"), settings()),
    /HTTP 503/,
  );
  await assert.rejects(
    () => ENGINES.piratebay(stub({ [PIRATEBAY]: "<html>" }), engineQuery("x"), settings()),
    /not JSON/,
  );
  // Their API answers with an array. An object is somebody else's API, or a
  // captive portal, and guessing at it would invent torrents.
  await assert.rejects(
    () => ENGINES.piratebay(stub({ [PIRATEBAY]: { hits: [] } }), engineQuery("x"), settings()),
    /array/,
  );
});

test("a bot challenge is not an empty feed", async () => {
  // Every engine here shares this. A challenge is an HTTP 200 carrying a page
  // of HTML, so without a shape check the scanner just finds no <item> and the
  // engine reports "answered with no rows" — indistinguishable from a query
  // nobody seeds. One of those is worth acting on and the other is not. A
  // recognisable challenge page reads as the address being down, so the next
  // address is tried; any other HTML where a feed should be is "not a feed".
  const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>';
  await assert.rejects(() => ENGINES.nyaa(stub({ [NYAA]: challenge }), engineQuery("x"), settings()), /bot challenge/);
  const somePage = '<!DOCTYPE html><html><head><title>Nyaa</title></head><body>maintenance</body></html>';
  await assert.rejects(() => ENGINES.nyaa(stub({ [NYAA]: somePage }), engineQuery("x"), settings()), /not a feed/);
  // And a real feed with nothing in it still reads as nothing found.
  const empty = '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>';
  assert.deepEqual(await ENGINES.nyaa(stub({ [NYAA]: empty }), engineQuery("x"), settings()), []);
});

test("an RSS engine rejects answers that are not a feed", async () => {
  await assert.rejects(
    () => ENGINES.nyaa(stub({ [NYAA]: "<html>Just a moment...</html>" }), engineQuery("x"), settings()),
    /not XML/,
  );
  await assert.rejects(
    () => ENGINES.nyaa(stub({ [NYAA]: [403, ""] }), engineQuery("x"), settings()),
    /HTTP 403/,
  );
});

test("torrentscsv reads rows and asks for exactly the cap", async () => {
  const http = stub({ [TORRENTSCSV]: fixture("torrentscsv.json") });
  const rows = await ENGINES.torrentscsv(http, engineQuery("big buck bunny"), settings({ maxRowsPerEngine: 40 }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].infohash, "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c");
  assert.equal(rows[0].firstSeen, "2018-12-31T23:58:20Z");
  assert.equal(rows[0].category, null, "no category in the source; the name decides later");
  assert.match(http.asked(TORRENTSCSV).url, /size=40/);
});

test("yts flattens one film into its torrents", async () => {
  const rows = await ENGINES.yts(stub({ [YTS]: fixture("yts.json") }), engineQuery("sintel"), settings());
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.category === "video"));
  assert.equal(parseName(rows[0].name).resolution, "1080p");
  assert.equal(parseName(rows[0].name).year, "2010");
  assert.equal(parseName(rows[0].name).source, "bluray");

  // It omits `movies` entirely when nothing matched, rather than sending [].
  const empty = { status: "ok", data: { movie_count: 0, limit: 20 } };
  assert.deepEqual(await ENGINES.yts(stub({ [YTS]: empty }), engineQuery("nothing"), settings()), []);
});

test("nyaa reads its own RSS namespace, sizes and all", async () => {
  const rows = await ENGINES.nyaa(stub({ [NYAA]: fixture("nyaa.xml") }), engineQuery("some show"), settings());
  assert.equal(rows.length, 3, "the hashless third item is kept: it has a .torrent link for the resolver");
  assert.equal(rows[2].infohash, null);
  assert.match(rows[2].torrentUrl, /^https:\/\/nyaa\.si\/download\//);
  assert.equal(rows[0].infohash, "c".repeat(40));
  assert.equal(rows[0].seeders, 210);
  assert.equal(rows[0].leechers, 9);
  assert.equal(rows[0].sizeBytes, Math.trunc(1.4 * 1024 ** 3));
  assert.equal(rows[0].category, "video", "1_2 is animation");
  assert.equal(rows[1].category, "audio", "2_1 is lossless");
  assert.equal(rows[0].torrentUrl, "https://nyaa.si/download/1837000.torrent");
  assert.equal(rows[0].descriptionUrl, "https://nyaa.si/view/1837000");
  assert.equal(rows[0].firstSeen, "2024-05-01T12:00:00Z");
  assert.equal(rows[1].infohash, "d".repeat(40), "lowercased");
});

test("nyaa finds its namespace whatever prefix the feed binds it to", async () => {
  // The prefix is the feed's choice, not a constant. Resolving it from the
  // document is the difference between parsing a renamed feed and silently
  // returning nothing from one.
  const renamed = fixture("nyaa.xml")
    .replace(/xmlns:nyaa=/, "xmlns:ny=")
    .replace(/<(\/?)nyaa:/g, "<$1ny:");
  const rows = await ENGINES.nyaa(stub({ [NYAA]: renamed }), engineQuery("some show"), settings());
  assert.equal(rows.length, 3);
  assert.equal(rows[0].infohash, "c".repeat(40));
});

test("nyaa rejects something that is not XML", async () => {
  await assert.rejects(() => ENGINES.nyaa(stub({ [NYAA]: "{}" }), engineQuery("x"), settings()), /not XML/);
});

test("torznab reads magnets, infohashes and the leftovers", () => {
  const rows = parseTorznab(fixture("torznab.xml"), 100);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].infohash, "5".repeat(40));
  assert.equal(rows[0].leechers, 5, "peers 60 minus seeders 55");
  assert.equal(rows[0].files, 2);
  assert.equal(rows[0].firstSeen, "2019-01-01T00:00:00Z");
  assert.equal(rows[1].infohash, "6".repeat(40));
  assert.equal(rows[1].leechers, 2, "an explicit attr wins over peers");
  // No magnet and no infohash: kept with its .torrent URL for resolution.
  assert.equal(rows[2].infohash, null);
  assert.equal(rows[2].torrentUrl, "https://indexer.test/download/3.torrent");

  assert.throws(() => parseTorznab("{}", 10), /not XML/);
});

test("torznab needs a base URL and is never given a guessed one", async () => {
  await assert.rejects(() => ENGINES.torznab(stub({}), engineQuery("x"), settings({ torznabUrl: "" })), /UTSI_TORZNAB_URL/);
  // It is your address, and a fallback list for it would mean sending your
  // queries and your key somewhere you did not name.
  assert.equal(ENGINE_ORIGINS.torznab, undefined);
  assert.equal(ENGINE_ORIGINS.upstream, undefined);
  assert.equal(ENGINE_ORIGINS.fallback, undefined);
});

test("public engines are never sent a credential", async () => {
  // The one rule with no exceptions. `upstream`, `fallback` and `torznab` point
  // at a server the deployer runs; everything else is somebody else's site.
  // Every public engine, taken from the roster rather than written down, so that
  // adding a tenth adapter cannot quietly escape this rule — which is exactly how
  // a `Cookie` or an `Authorization` header reaches somebody else's site.
  const publicEngines = KNOWN_ENGINES.filter(
    (id) => !["upstream", "fallback", "torznab"].includes(id),
  );
  const config = settings({
    engines: publicEngines,
    upstreamApikey: "SECRET-UPSTREAM",
    torznabApikey: "SECRET-TORZNAB",
    apiKey: "SECRET-OWN-KEY-0123456789",
  });
  const http = stub({
    [KNABEN]: fixture("knaben.json"),
    [TORRENTSCSV]: fixture("torrentscsv.json"),
    [YTS]: fixture("yts.json"),
    [NYAA]: fixture("nyaa.xml"),
    [ANIMETOSHO]: fixture("animetosho.json"),
    [EZTVX]: fixture("eztvx.json"),
  });
  await search(ask(), http, config);

  assert.ok(http.calls.length >= publicEngines.length, "every public engine was asked");
  for (const call of http.calls) {
    const sent = JSON.stringify({ url: call.url, headers: call.headers || {}, body: call.body || "" });
    for (const secret of ["SECRET-UPSTREAM", "SECRET-TORZNAB", "SECRET-OWN-KEY"]) {
      assert.ok(!sent.includes(secret), `${secret} leaked to ${call.url}`);
    }
    for (const header of Object.keys(call.headers || {})) {
      assert.ok(
        !/^(authorization|x-api-key|cookie)$/i.test(header),
        `${header} sent to ${call.url}`,
      );
    }
  }
});

test("animetosho rows carry the magnet the listing already had", async () => {
  const rows = await ENGINES.animetosho(
    stub({ [ANIMETOSHO]: fixture("animetosho.json") }),
    engineQuery("public domain animation"),
    settings(),
  );

  assert.equal(rows.length, 2, "the row with no magnet is dropped, not emitted without one");
  assert.equal(rows[0].infohash, "aa11bb22cc33dd44ee55ff6677889900aabbccdd");
  assert.equal(rows[0].sizeBytes, 1503238553);
  assert.equal(rows[0].seeders, 412);
  assert.equal(rows[0].leechers, 37);
  assert.equal(rows[0].firstSeen, "2024-05-01T12:00:00Z");
  assert.equal(rows[0].category, null, "their categories are not TSP's; the name decides");
  assert.deepEqual(rows[0].sources, ["animetosho"]);
});

test("eztvx prefers the hash field and falls back to the magnet", async () => {
  const rows = await ENGINES.eztvx(
    stub({ [EZTVX]: fixture("eztvx.json") }),
    engineQuery("public domain show"),
    settings(),
  );

  assert.equal(rows.length, 2);
  // Sent uppercase; TSP wants it lowercase, and the magnet must agree with it.
  assert.equal(rows[0].infohash, "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c");
  assert.equal(rows[0].sizeBytes, 1610612736, "their sizes arrive as strings");
  assert.equal(rows[0].category, "video", "every row is an episode");
  // An empty `hash` must fall through to the magnet rather than dropping the row.
  assert.equal(rows[1].infohash, "99887766554433221100ffeeddccbbaa99887766");
  assert.equal(rows[1].sizeBytes, null, "a size of zero is 'not recorded', not a zero-byte torrent");
});

test("the Keywords path is used, so no third-party key is ever needed", async () => {
  // The imdb_id path would need an OMDb key to turn a title into an id. This file
  // sends no third-party credentials and asks the deployer for none.
  const http = stub({ [EZTVX]: fixture("eztvx.json") });
  await ENGINES.eztvx(http, engineQuery("public domain show"), settings());

  const asked = http.calls[0].url;
  assert.match(asked, /[?&]Keywords=public\+domain\+show(&|$)/);
  assert.ok(!/imdb/i.test(asked), "the imdb path needs a key this project will not ask for");
});

test("a private index's address never appears in an answer, even when it fails", async () => {
  // UTSI_UPSTREAM_URL and UTSI_FALLBACK_URL are the address of somebody's own
  // server, and are secrets for that reason. A transport failure is not raised by
  // this file — the runtime raises it, and Workers spells it "Fetch API cannot
  // load: <the whole URL>", which lands in `engine_errors` and, worse, in
  // LIVENESS and therefore in `/healthz`, which needs no key at all.
  const SECRET = "https://my-private-indexer.example.net";
  const config = settings({
    engines: ["knaben"],
    fallback: true,
    fallbackUrl: SECRET,
    fallbackApikey: "fallback-secret-key",
  });

  const http = {
    async text(url) {
      if (url.startsWith(SECRET)) throw new TypeError(`Fetch API cannot load: ${url}`);
      return [200, JSON.stringify({ hits: [] })]; // everything else finds nothing
    },
    async bytes() { return [404, new Uint8Array()]; },
  };

  LIVENESS.engines.clear();
  const reply = await search(ask({ q: "ubuntu" }), http, config);
  assert.ok(reply.body.engine_errors.fallback, "the failure is still reported");
  assert.ok(
    !JSON.stringify(reply.body).includes("my-private-indexer"),
    "the private address reached a client holding the API key",
  );

  // The one that matters most: /healthz is deliberately unauthenticated.
  const health = await handle("GET", "https://w.dev/healthz", new Headers(), http, config);
  assert.ok(
    !JSON.stringify(health.body).includes("my-private-indexer"),
    "the private address reached an unauthenticated caller through /healthz",
  );
  assert.ok(!JSON.stringify(health.body).includes("fallback-secret-key"));
});

// ───────────────────────────────────────────────────────────────────────────
// Multiple addresses per engine
// ───────────────────────────────────────────────────────────────────────────

test("an engine that moved domain is found at its next address", async () => {
  // The cheap fix for the biggest real-world breakage. yts.mx → yts.bz already
  // happened once, and a pasted copy of this file never picks up a fix upstream.
  LIVENESS.engines.clear();
  const second = ENGINE_ORIGINS.yts[1];
  const http = stub({ [second + "/api/v2/list_movies.json"]: fixture("yts.json") });
  const rows = await ENGINES.yts(http, engineQuery("sintel"), settings());

  assert.equal(rows.length, 2);
  assert.equal(http.calls.length, 2, "the first address was tried, then the second");
  assert.ok(http.calls[0].url.startsWith(ENGINE_ORIGINS.yts[0]));
  assert.equal(LIVENESS.engines.get("yts").origin, second);
  assert.equal(LIVENESS.engines.get("yts").origin_from, "built-in");
});

test("an address that is gone, not merely unhappy, still falls through to the next", async () => {
  // The case this list was actually written for. yts.mx's registration was
  // deleted, and a name that no longer resolves does not answer with a status —
  // `fetch` rejects, with a bare TypeError that is none of this file's errors.
  // Until that was translated it was re-thrown past the retry, so the second
  // address went unasked in precisely the scenario the first address dying is
  // supposed to survive. A timeout is the same shape and was equally affected.
  for (const gone of [
    Object.assign(new TypeError("fetch failed"), { name: "TypeError" }),
    Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }),
  ]) {
    LIVENESS.engines.clear();
    const second = ENGINE_ORIGINS.yts[1];
    const http = stub({
      [ENGINE_ORIGINS.yts[0]]: gone,
      [second + "/api/v2/list_movies.json"]: fixture("yts.json"),
    });
    const rows = await ENGINES.yts(http, engineQuery("sintel"), settings());

    assert.equal(rows.length, 2, `${gone.name}: the second address should have answered`);
    assert.equal(http.calls.length, 2, `${gone.name}: both addresses should have been tried`);
    assert.equal(LIVENESS.engines.get("yts").origin, second);
  }
});

test("when every address fails, the first one's complaint is the one reported", async () => {
  // It is the address the project recommends or the operator chose, so its "HTTP
  // 403" is the fact worth acting on; that three mirrors also declined is a
  // detail, and it is said in three words rather than three messages.
  // Counted from the list rather than written down, so that curating the
  // addresses — which happens whenever one of these sites moves — does not
  // register as this rule breaking.
  const tried = ENGINE_ORIGINS.yts.length;
  assert.ok(tried >= 2, "this test needs an engine with more than one address");
  const http = stub({ [ENGINE_ORIGINS.yts[0]]: [403, ""] });
  await assert.rejects(
    () => ENGINES.yts(http, engineQuery("sintel"), settings()),
    new RegExp(`^EngineError: HTTP 403 \\(${tried} addresses tried\\)$`),
  );
});

test("an address that answers with nonsense is not retried elsewhere", async () => {
  // The site is alive and the adapter is wrong. Asking a mirror the same
  // question would only be wrong twice, and slower.
  const http = stub({ [ENGINE_ORIGINS.yts[0]]: "<html>" });
  await assert.rejects(() => ENGINES.yts(http, engineQuery("sintel"), settings()), /not JSON/);
  assert.equal(http.calls.length, 1);
});

test("UTSI_ENGINE_URLS replaces the list rather than joining it", async () => {
  const moved = "https://yts.example.test";
  const config = settings({ engineUrls: { yts: moved } });
  assert.deepEqual(originsFor("yts", config), [{ url: moved, from: "UTSI_ENGINE_URLS" }]);

  const http = stub({ [moved + "/api/v2/list_movies.json"]: fixture("yts.json") });
  const rows = await ENGINES.yts(http, engineQuery("sintel"), config);
  assert.equal(rows.length, 2);
  assert.equal(http.calls.length, 1, "a repair that tried three dead addresses first is a slower repair");
});

/**
 * Engines allowed to ship one address, and why.
 *
 * The rule is two or more, because these sites move. The exception is narrow on
 * purpose: an engine belongs here only when the project has no *second* address
 * it is willing to send a real query to, and one address plus the documented
 * UTSI_ENGINE_URLS repair — and, now, the feed — is the honest answer.
 *
 * - `piratebay`: no second address this project has measured answering, and
 *   inventing a proxy would mean sending queries to an unverified host.
 * - `torrentscsv`: the old `.ml` fallback lapsed and is now a parking page that
 *   answers HTTP 200, which is worse than having no fallback at all.
 * - `nyaa`, `sukebei`: their unofficial mirrors have served malware by Nyaa's
 *   own account. A dead engine beats an automatic fallback onto one.
 * - `animetosho`: the JSON lives on one API host.
 * - `eztvx`: the site has moved several times and its older domains now
 *   redirect here, so listing them would be this host by a longer route.
 * - `torrentdownload`, `torrentdownloads`, `torrentkitty`, `dmhy`, `archive`:
 *   one address each is what has been measured answering. A second one is a
 *   feed edit away the day it is needed.
 *
 * Each of those is a decision recorded next to the descriptor in `worker.js`.
 * Adding a name here without one is how this test stops meaning anything.
 */
const ONE_ADDRESS_ON_PURPOSE = new Set([
  "piratebay", "torrentscsv", "nyaa", "sukebei", "animetosho", "eztvx",
  "torrentdownload", "torrentdownloads", "torrentkitty", "dmhy", "archive",
]);

test("every engine carries its address book, and the seed is valid against the feed's schema", () => {
  const source = readFileSync(SOURCE, "utf8");
  for (const descriptor of SEED_DESCRIPTORS) {
    const engineId = descriptor.name;
    // Every seed descriptor is valid against the same schema the feed is held
    // to — the compiled-in configuration must never be the one thing the
    // validator would reject.
    assert.equal(descriptorProblem(descriptor), "", engineId);
    if (!ONE_ADDRESS_ON_PURPOSE.has(engineId)) {
      assert.ok(descriptor.origins.length >= 2, `${engineId} has no fallback address`);
    }
    assert.ok(descriptor.origins.length >= 1, `${engineId} has no address at all`);
    for (const url of descriptor.origins) {
      assert.match(url, /^https:\/\/[a-z0-9.-]+$/, `${url} is not a bare https origin`);
    }
    // The address list that runs is the descriptor's own — `originsFor` reads
    // it — so there is no second copy to drift from.
    assert.deepEqual(
      originsFor(engineId, settings()).map((origin) => origin.url),
      descriptor.origins,
      `${engineId} runs its own address list`,
    );
  }
  // yts is the one hand-written adapter; it names askOrigins directly and takes
  // its addresses from the seed like everything else.
  assert.match(source, /askOrigins\("yts"/);
  // And the default roster is exactly the seed, behind upstream: an engine
  // cannot be shipped and forgotten.
  const seeded = SEED_DESCRIPTORS.filter((d) => d.enabled !== false).map((d) => d.name).sort();
  const defaults = readSettings({ UTSI_API_KEY: KEY }).engines.slice().sort();
  assert.deepEqual(defaults, seeded);
});

// ───────────────────────────────────────────────────────────────────────────
// Merge, filter, order
// ───────────────────────────────────────────────────────────────────────────

const both = () => stub({ [UPSTREAM]: fixture("upstream.json"), [KNABEN]: fixture("knaben.json") });

test("the same release from two engines becomes one row", async () => {
  const reply = await search(ask({ q: "big buck bunny" }), both(), settings({ engines: ["upstream", "knaben"] }));
  const shared = reply.body.torrents.filter((t) => t.infohash === "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c");
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0].sources, ["knaben/1337x", "upstream/1337x", "upstream/piratebay"]);
  assert.equal(shared[0].seeders, 512, "max() across engines, not the first seen");
});

test("the first engine listed wins the fields it shares", async () => {
  // This is what "set it first" buys, and the only place order is visible.
  const first = await search(ask(), both(), settings({ engines: ["upstream", "knaben"] }));
  const a = first.body.torrents.find((t) => t.infohash === "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c");
  assert.equal(a.description_url, "https://1337x.to/torrent/1/");

  const second = await search(ask(), both(), settings({ engines: ["knaben", "upstream"] }));
  const b = second.body.torrents.find((t) => t.infohash === "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c");
  assert.equal(b.description_url, "https://knaben.org/torrent/5555555");
});

test("collection order does not depend on who answers first", async () => {
  // Collecting in completion order would let the fastest site decide which
  // metadata survives — differently each run.
  const slow = both();
  const inner = slow.text.bind(slow);
  slow.text = async (url, options) => {
    if (url.startsWith(UPSTREAM)) await new Promise((resolve) => setTimeout(resolve, 40));
    return inner(url, options);
  };
  const reply = await search(ask(), slow, settings({ engines: ["upstream", "knaben"] }));
  const row = reply.body.torrents.find((t) => t.infohash === "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c");
  assert.equal(row.description_url, "https://1337x.to/torrent/1/", "listed first, answered last, still wins");
});

// ───────────────────────────────────────────────────────────────────────────
// The query gate
// ───────────────────────────────────────────────────────────────────────────

test("a row that answers none of the query is not a result", async () => {
  // The bug this exists for. eztvx.to answers a `Keywords` it cannot match with
  // the newest episodes on the site rather than with nothing, and a fan-out has
  // no way to tell that apart from a search that went well — so a search for
  // "micheal jackson" came back full of this week's television, `count` and all.
  const http = stub({ [EZTVX]: fixture("eztvx-latest.json") });
  const reply = await search(ask({ q: "micheal jackson" }), http, settings({ engines: ["eztvx"] }));

  assert.deepEqual(reply.body.torrents, []);
  assert.equal(reply.body.count, 0, "count must describe the rows, not the fan-out");
  assert.ok(reply.body.engines.includes("eztvx"), "the engine answered; it just did not match");
});

test("the gate narrows an ignored answer rather than emptying it", async () => {
  const http = stub({ [EZTVX]: fixture("eztvx-latest.json") });
  const reply = await search(ask({ q: "spiderman" }), http, settings({ engines: ["eztvx"] }));
  assert.deepEqual(
    reply.body.torrents.map((t) => t.name),
    ["Spider-Man Chronicles S02E01 1080p WEB-DL x264-LAZY"],
    "the one row that answers survives, hyphens and all",
  );
});

test("every term has to appear, in either spelling a release name uses", () => {
  const yes = [
    ["michael jackson", "Michael.Jackson.Moonwalker.1988.1080p.BluRay.x264"],
    ["big buck bunny", "Big.Buck.Bunny.2008.1080p.BluRay.x264-UPSTREAM"],
    ["spiderman", "Spider-Man.No.Way.Home.2021.1080p"],
    ["spider man", "Spiderman.2002.720p"],
    ["bluray", "Sintel.2010.Blu-Ray.x264"],
    ["amelie", "Amélie.2001.1080p.BluRay"],
    ["oceans eleven", "Ocean's.Eleven.2001.1080p"],
    ["s01e01", "Some Show S01 E01 720p"],
    // Word order is irrelevant to TSP, and a query may be typed with the
    // separators TSP names rather than with spaces.
    ["bunny buck big", "Big.Buck.Bunny.2008"],
    ["巨人", "進撃の巨人 S01E01 [1080p]"],
  ];
  for (const [query, name] of yes) {
    assert.ok(matchesTerms(name, queryTerms(query)), `${query} should find ${name}`);
  }

  const no = [
    ["micheal jackson", "Miraculous Tales of Ladybug and Cat Noir S06E18 Heartfixer"],
    ["big buck bunny", "Bunny.Chronicles.S01E02.720p"],
    ["sintel 2010", "Sintel 2011 Remaster"],
  ];
  for (const [query, name] of no) {
    assert.ok(!matchesTerms(name, queryTerms(query)), `${query} should not find ${name}`);
  }
});

test("one keystroke is forgiven, and never in a token where it is the meaning", () => {
  // The gate cannot be stricter than the engines it polices. An index forgiving
  // enough to answer `micheal jackson` with the real thing would have that
  // answer deleted here, which is this filter hiding a correct row.
  const forgiven = [
    ["micheal jackson", "Michael Jackson - Thriller (1982) [24bit FLAC]", "transposed pair"],
    ["thriler", "Michael Jackson Thriller 1982 FLAC", "dropped letter"],
    ["sintell", "Sintel 2010 1080p", "doubled letter"],
  ];
  for (const [query, name, why] of forgiven) {
    assert.ok(matchesTerms(name, queryTerms(query)), `${why}: ${query} should find ${name}`);
  }

  // But a digit means a technical token, where the character is the whole
  // meaning. Forgiving one there answers a question nobody asked.
  const refused = [
    ["sintel 2010", "Sintel 2011 Remaster", "a year"],
    ["sintel x264", "Sintel.2010.x265.HDR", "a codec"],
    ["show s01e01", "Some Show S01E02 720p", "an episode"],
    ["sintel 1080p", "Sintel 1081p", "a resolution"],
    // And below five characters one edit is most of the word.
    ["bunny", "Buggy Software 2020", "too short to forgive"],
    // Two whole terms missing is not a typo, whatever the third one does.
    ["micheal jackson", "Miraculous Tales of Ladybug and Cat Noir S06E18", "not a near miss"],
  ];
  for (const [query, name, why] of refused) {
    assert.ok(!matchesTerms(name, queryTerms(query)), `${why}: ${query} must not find ${name}`);
  }
});

test("a word the release name dropped is not grounds to drop the row", () => {
  // `The Matrix` is on disk as `Matrix.1999.BluRay`. Wanting every term without
  // this would delete the row that was asked for — the failure this whole
  // section exists to prevent, arriving from the other direction.
  assert.ok(matchesTerms("Matrix.1999.1080p.BluRay.x264-AMIABLE", queryTerms("the matrix")));
  assert.ok(matchesTerms("Tom.and.Jerry.2021.1080p", queryTerms("tom & jerry")));
  // But only while something else still has to match.
  assert.ok(!matchesTerms("Matrix.1999.1080p", queryTerms("the")));
});

test("a row with no name to read is kept, not judged", () => {
  // The same rule the category filter follows for a name it cannot classify:
  // "no idea" is not "no", and treating it as "no" makes a filter delete
  // correct answers rather than narrow the list.
  assert.ok(matchesTerms("", queryTerms("anything at all")));
  assert.ok(matchesTerms("...", queryTerms("anything at all")), "nothing comparable in it");
});

test("browsing is not held to the term that stood in for the query", async () => {
  // An empty `q` means "browse the whole index". The generic query is this
  // Worker's invention, so filtering a client's browse against a word it never
  // typed would hide rows rather than narrow them.
  const config = settings({ engines: ["eztvx"], browseQueries: ["1080p"] });
  const http = stub({ [EZTVX]: fixture("eztvx-latest.json") });
  const reply = await search(ask({ q: "  " }), http, config);

  assert.equal(reply.body.browse_query, "1080p");
  assert.ok(
    reply.body.torrents.some((t) => t.name.includes("720p")),
    "a 720p row survives a browse for 1080p, because nobody asked for 1080p",
  );
});

test("the gate can be turned off for an index that matches better than this", async () => {
  // The escape hatch: in front of an `upstream` doing its own fuzzy, stemmed or
  // synonym matching, a literal gate here would delete the answers it found.
  const http = stub({ [EZTVX]: fixture("eztvx-latest.json") });
  const config = settings({ engines: ["eztvx"], queryMatch: "off" });
  const reply = await search(ask({ q: "micheal jackson" }), http, config);
  assert.equal(reply.body.count, 3);

  assert.equal(readSettings({ UTSI_API_KEY: KEY }).queryMatch, "terms", "on unless asked");
  assert.equal(
    readSettings({ UTSI_API_KEY: KEY, UTSI_QUERY_MATCH: "OFF" }).queryMatch, "off",
  );
  assert.equal(
    readSettings({ UTSI_API_KEY: KEY, UTSI_QUERY_MATCH: "nonsense" }).queryMatch,
    "terms",
    "an unreadable setting fails towards answering the question that was asked",
  );
});

test("a category filter never hides a row nothing contradicts", async () => {
  // A filter is meant to narrow a result set, not delete correct answers from
  // it. `classifyName` only reads technical markers, so a bare title comes back
  // as "no idea", and "no idea" is not "no".
  const config = settings({ engines: ["upstream"] });
  const names = async (query) =>
    new Set(
      (await search(ask(query), stub({ [UPSTREAM]: fixture("upstream.json") }), config)).body.torrents.map(
        (t) => t.name,
      ),
    );

  const unfiltered = await names({});
  const unreadable = [...unfiltered].filter((name) => classifyName(name) === null);
  assert.ok(unreadable.length, "the fixture must contain a row the classifier cannot read");
  for (const category of TSP_CATEGORIES) {
    const kept = await names({ cat: category });
    for (const name of unreadable) assert.ok(kept.has(name), `${category} hid a row it could not read`);
  }
});

test("a category filter still drops what it can read", async () => {
  const config = settings({ engines: ["nyaa"] });
  // A query the fixture's rows actually answer, so this is a test of the
  // category filter rather than of the query gate standing in front of it.
  const reply = await search(ask({ q: "some show", cat: "audio" }), stub({ [NYAA]: fixture("nyaa.xml") }), config);
  const names = reply.body.torrents.map((t) => t.name);
  assert.ok(names.some((name) => name.includes("FLAC")), "the lossless row belongs here");
  assert.ok(!names.some((name) => name.includes("1080p")), "a row read as video is still dropped");
});

test("the cheap resolution pre-filter never drops a row the real parse would keep", () => {
  const samples = {
    "2160p": ["Movie 2160p x265", "Movie 4K HDR", "Movie UHD BluRay", "Movie 3840x2160"],
    "1080p": ["Movie 1080p x264", "Movie 1080i HDTV", "Movie FHD", "Movie 1920x1080"],
    "720p": ["Movie 720p WEB", "Movie 1280x720"],
    "480p": ["Movie 480p DVD", "Movie 480i", "Movie SD rip", "Movie 640x480"],
  };
  for (const [resolution, names] of Object.entries(samples)) {
    for (const name of names) {
      assert.equal(parseName(name).resolution, resolution, name);
      const row = { name, engineId: "x", infohash: null, sizeBytes: null, seeders: null, category: null, meta: null };
      assert.ok(applyFilters([row], { resolution }).length, `pre-filter dropped ${name}`);
    }
  }
  assert.deepEqual(Object.keys(RESOLUTION_SPELLINGS).sort(), ["1080p", "2160p", "480p", "720p"]);
});

test("paging is stable across offsets", async () => {
  const config = settings({ engines: ["upstream", "knaben"] });
  const first = await search(ask({ limit: 2, offset: 0 }), both(), config);
  const second = await search(ask({ limit: 2, offset: 2 }), both(), config);
  assert.equal(first.body.torrents.length, 2);
  assert.equal(first.body.count, second.body.count);
  const seen = new Set(first.body.torrents.map((t) => t.infohash));
  assert.ok(!second.body.torrents.some((t) => seen.has(t.infohash)));
});

test("every row carries a magnet built from its own infohash", async () => {
  const reply = await search(ask(), both(), settings({ engines: ["upstream", "knaben"] }));
  assert.ok(reply.body.torrents.length);
  for (const torrent of reply.body.torrents) {
    assert.ok(torrent.magnet.startsWith(`magnet:?xt=urn:btih:${torrent.infohash}`));
  }
});

test("merging keeps the longest name and the earliest sighting", () => {
  const row = (overrides) => ({
    name: "A",
    engineId: "one",
    infohash: "f".repeat(40),
    torrentUrl: null,
    sizeBytes: null,
    files: null,
    seeders: null,
    leechers: null,
    category: null,
    firstSeen: null,
    descriptionUrl: null,
    sources: ["one"],
    meta: null,
    ...overrides,
  });
  const merged = merge([
    row({ name: "Short", seeders: 5, firstSeen: "2024-01-01T00:00:00Z" }),
    row({ name: "A much longer release name", seeders: 50, sizeBytes: 10, firstSeen: "2020-01-01T00:00:00Z", sources: ["two"] }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, "A much longer release name");
  assert.equal(merged[0].seeders, 50);
  assert.equal(merged[0].sizeBytes, 10);
  assert.equal(merged[0].firstSeen, "2020-01-01T00:00:00Z");
  assert.deepEqual(toTorrent(merged[0], "T").sources, ["one", "two"]);
});

// ───────────────────────────────────────────────────────────────────────────
// Fan-out behaviour
// ───────────────────────────────────────────────────────────────────────────

test("the worker still answers when your own index is down, and says why", async () => {
  // The whole point of putting a Worker in front of a machine at home.
  const http = stub({ [UPSTREAM]: [502, ""], [TORRENTSCSV]: fixture("torrentscsv.json") });
  const reply = await search(ask(), http, settings({ engines: ["upstream", "torrentscsv"] }));
  assert.deepEqual(reply.body.engines, ["torrentscsv"]);
  assert.ok(reply.body.torrents.length);
  // With observability off there is no log to read, so the reason travels with
  // the answer.
  assert.deepEqual(reply.body.engine_errors, { upstream: "HTTP 502" });
});

test("a clean search reports no engine errors", async () => {
  const reply = await search(ask(), stub({ [TORRENTSCSV]: fixture("torrentscsv.json") }), settings({ engines: ["torrentscsv"] }));
  assert.ok(!("engine_errors" in reply.body));
});

test("a slow engine is left behind", async () => {
  const http = stub({ [TORRENTSCSV]: fixture("torrentscsv.json") });
  const inner = http.text.bind(http);
  http.text = async (url, options) => {
    if (url.startsWith(UPSTREAM)) await new Promise((resolve) => setTimeout(resolve, 5000)).then(() => {});
    return inner(url, options);
  };
  const config = settings({
    engines: ["upstream", "torrentscsv"],
    engineTimeoutS: 0.05,
    upstreamTimeoutS: 0.05,
    requestDeadlineS: 0.5,
  });
  const reply = await search(ask(), http, config);
  assert.deepEqual(reply.body.engines, ["torrentscsv"]);
  assert.ok(reply.body.torrents.length);
  assert.match(reply.body.engine_errors.upstream, /timeout/);
});

test("an adapter that throws is reported, not fatal", async () => {
  const http = stub({ [TORRENTSCSV]: fixture("torrentscsv.json"), [UPSTREAM]: new TypeError("boom") });
  const reply = await search(ask(), http, settings({ engines: ["upstream", "torrentscsv"] }));
  assert.deepEqual(reply.body.engines, ["torrentscsv"]);
  assert.match(reply.body.engine_errors.upstream, /TypeError: boom/);
});

test("a search that finds something never touches the fallback", async () => {
  // Whatever index it points at is not sized for every request — that is why it
  // was made the fallback — and it does not have to be.
  const http = stub({ [TORRENTSCSV]: fixture("torrentscsv.json"), "https://fallback.test": fixture("upstream.json") });
  const config = settings({ engines: ["torrentscsv"], fallbackUrl: "https://fallback.test" });
  const reply = await search(ask(), http, config);
  assert.ok(reply.body.torrents.length);
  assert.ok(!http.calls.some((call) => call.url.startsWith("https://fallback.test")));
});

test("an empty search falls through to the fallback, and its failing is not an error", async () => {
  const config = settings({ engines: ["torrentscsv"], fallbackUrl: "https://fallback.test" });

  // torrentscsv answers nothing whatever it is asked, which is the condition
  // under test; the query is one the fallback's rows answer, so what comes back
  // is the fallback working rather than the query gate emptying it again.
  const found = stub({ [TORRENTSCSV]: { torrents: [] }, "https://fallback.test": fixture("upstream.json") });
  const reply = await search(ask({ q: "bunny" }), found, config);
  assert.ok(reply.body.torrents.length);
  assert.ok(reply.body.engines.includes("fallback"));

  const throttled = stub({ [TORRENTSCSV]: { torrents: [] }, "https://fallback.test": [429, ""] });
  const quiet = await search(ask({ q: "bunny" }), throttled, config);
  assert.equal(quiet.status, 200);
  assert.equal(quiet.body.count, 0);
  assert.equal(quiet.body.engine_errors.fallback, "rate limited (HTTP 429)");
});

test("being throttled reads differently from being down", async () => {
  // The two need opposite repairs. A site that is down is fixed by waiting or
  // by pointing the engine elsewhere; a site that is throttling you is fixed by
  // asking it less, and changing address does nothing. Knaben published a
  // temporary 1-request-per-2-seconds limit after a 25-million-request day, so
  // this is the failure a busy Worker is most likely to meet.
  LIVENESS.engines.clear();
  const config = settings({ engines: ["knaben", "torrentscsv"] });
  await search(ask(), stub({ [KNABEN]: [429, ""], [TORRENTSCSV]: [503, ""] }), config);

  const health = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  assert.equal(health.body.engine_status.knaben.last, "rate_limited");
  assert.match(health.body.engine_status.knaben.error, /rate limited/);
  assert.equal(health.body.engine_status.torrentscsv.last, "error", "a 503 is still just an error");

  // Throttled is not answering, so coverage still tells the truth about it.
  assert.equal(health.body.coverage, "none");
  assert.equal(health.body.status, "degraded");
});

test("the fallback is dark until an address is configured", async () => {
  // Not even an engine_errors entry: an unset fallback is not an engine that
  // failed, it is a feature that was never turned on.
  const http = stub({ [TORRENTSCSV]: { torrents: [] } });
  const reply = await search(ask({ q: "obscure" }), http, settings({ engines: ["torrentscsv"] }));
  assert.equal(reply.body.count, 0);
  assert.ok(!("engine_errors" in reply.body));
  assert.ok(http.calls.every((call) => call.url.startsWith(TORRENTSCSV)));
});

test("a small page asks the engines for less; a filtered one asks for everything", async () => {
  // Parsing rows is the request's main CPU cost, and a limit=5 client should not
  // pay for a hundred rows an engine.
  const config = settings({ engines: ["upstream"] });
  const small = stub({ [UPSTREAM]: fixture("upstream.json") });
  await search(ask({ limit: 5 }), small, config);
  assert.equal(new URL(small.asked(UPSTREAM).url).searchParams.get("limit"), "20");

  const filtered = stub({ [UPSTREAM]: fixture("upstream.json") });
  await search(ask({ limit: 5, cat: "video" }), filtered, config);
  assert.equal(new URL(filtered.asked(UPSTREAM).url).searchParams.get("limit"), "40");
});

// ───────────────────────────────────────────────────────────────────────────
// Browsing an empty query
// ───────────────────────────────────────────────────────────────────────────

test("an empty query browses rather than returning nothing, and says what it browsed", async () => {
  const http = stub({ [TORRENTSCSV]: fixture("torrentscsv.json") });
  const reply = await search(ask({ q: "   " }), http, settings({ engines: ["torrentscsv"] }));
  assert.equal(reply.status, 200);
  assert.ok(reply.body.torrents.length);
  assert.equal(reply.body.query, "   ", "the echoed query is what the client asked for");
  assert.ok(BROWSE_TERMS.video.includes(reply.body.browse_query));
  assert.ok(http.asked(TORRENTSCSV).url.includes(reply.body.browse_query));
});

test("browsing a category asks for words that category uses", () => {
  // The bug this fixes: every category browsed for a video word, so `cat=audio`
  // asked each site for the music torrents that mention 1080p.
  const config = settings();
  for (const category of TSP_CATEGORIES) {
    const term = browseQuery(config, category);
    assert.ok(BROWSE_TERMS[category].includes(term));
    assert.equal(classifyName(`Some Release ${term}`), category, `browsing ${category} for ${term} self-defeats`);
  }
  assert.deepEqual(Object.keys(BROWSE_TERMS).sort(), [...TSP_CATEGORIES].sort());
});

test("browsing holds still long enough to page through", async () => {
  const config = settings({ engines: ["torrentscsv"] });
  const first = await search(ask({ q: "" }), stub({ [TORRENTSCSV]: fixture("torrentscsv.json") }), config);
  const second = await search(ask({ q: "", offset: 2 }), stub({ [TORRENTSCSV]: fixture("torrentscsv.json") }), config);
  assert.equal(first.body.browse_query, second.body.browse_query);
});

test("browsing survives an empty term list and can be turned off entirely", async () => {
  assert.equal(browseQuery(settings({ browseQueries: [] })), "1080p");
  assert.equal(browseQuery(settings({ browseQueries: ["ubuntu"] })), "ubuntu");
  // ...and an operator's own list does not leak into a categorised browse.
  assert.ok(BROWSE_TERMS.audio.includes(browseQuery(settings({ browseQueries: ["ubuntu"] }), "audio")));

  const config = settings({ engines: ["torrentscsv"], emptyQueryMode: "empty" });
  const reply = await search(ask({ q: "   " }), stub({ [TORRENTSCSV]: fixture("torrentscsv.json") }), config);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.count, 0);
  assert.ok(!("browse_query" in reply.body));
});

// ───────────────────────────────────────────────────────────────────────────
// Resolving a .torrent
// ───────────────────────────────────────────────────────────────────────────

function bencode(value) {
  if (typeof value === "number") return Buffer.from(`i${value}e`);
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === "string") return bencode(Buffer.from(value, "utf8"));
  if (Array.isArray(value)) return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")]);
  const keys = Object.keys(value).sort();
  return Buffer.concat([Buffer.from("d"), ...keys.map((k) => Buffer.concat([bencode(k), bencode(value[k])])), Buffer.from("e")]);
}

test("a torznab row without a magnet resolves when allowed, and is dropped when not", async () => {
  const { createHash } = await import("node:crypto");
  const info = { name: "Resolved", "piece length": 262144, pieces: Buffer.alloc(20), length: 4242 };
  const file = bencode({ info });
  const expected = createHash("sha1").update(bencode(info)).digest("hex");

  const meta = await parseTorrent(new Uint8Array(file));
  assert.equal(meta.infohash, expected);
  assert.equal(meta.name, "Resolved");
  assert.equal(meta.sizeBytes, 4242);
  assert.equal(meta.files, 1);

  const routes = {
    "https://indexer.test/api": fixture("torznab.xml"),
    "https://indexer.test/download/3.torrent": new Uint8Array(file),
  };
  const config = settings({ engines: ["torznab"], torznabUrl: "https://indexer.test/api", maxResolve: 4 });
  const resolved = await search(ask(), stub(routes), config);
  assert.equal(resolved.body.torrents.length, 3);
  assert.ok(resolved.body.torrents.some((t) => t.infohash === expected));

  // TSP requires a magnet on every row, so an unresolved one is dropped.
  const off = await search(ask(), stub(routes), { ...config, maxResolve: 0 });
  assert.equal(off.body.torrents.length, 2);
  assert.equal(off.body.count, 2);

  assert.equal(await parseTorrent(new Uint8Array(Buffer.from("not bencode"))), null);
});

// ───────────────────────────────────────────────────────────────────────────
// Routing and auth
// ───────────────────────────────────────────────────────────────────────────

test("a missing key is 401 and a wrong one is 403, and neither returns rows", async () => {
  const config = settings();
  const missing = await run("GET", "https://w.dev/api/v1/search?q=x", {}, stub({}), config);
  assert.equal(missing.status, 401);
  const wrong = await run("GET", "https://w.dev/api/v1/search?q=x", { "x-api-key": "nope" }, stub({}), config);
  assert.equal(wrong.status, 403);
  assert.ok(!("torrents" in (wrong.body || {})));
});

test("Bearer is accepted too, and anonymous mode serves without a key", async () => {
  const http = stub({ [TORRENTSCSV]: fixture("torrentscsv.json") });
  const bearer = await run(
    "GET",
    "https://w.dev/api/v1/search?q=bunny",
    { authorization: "Bearer " + KEY },
    http,
    settings({ engines: ["torrentscsv"] }),
  );
  assert.equal(bearer.status, 200);
  assert.ok(bearer.body.torrents.length);

  const open = settings({ apiKey: "", allowAnonymous: true, engines: ["torrentscsv"] });
  const anonymous = await run("GET", "https://w.dev/api/v1/search?q=bunny", {}, stub({ [TORRENTSCSV]: fixture("torrentscsv.json") }), open);
  assert.equal(anonymous.status, 200);
});

test("bad query parameters are named, and numbers are clamped rather than rejected", async () => {
  const config = settings();
  for (const [query, error] of [
    ["cat=nonsense", "invalid_cat"],
    ["sort=alphabetical", "invalid_sort"],
    ["res=8k", "invalid_res"],
    ["year=99", "invalid_year"],
  ]) {
    const reply = await run("GET", `https://w.dev/api/v1/search?${query}`, authed(), stub({}), config);
    assert.equal(reply.status, 400);
    assert.equal(reply.body.error, error);
  }

  const read = (search) => readQuery(new URL("https://w.dev/?" + search).searchParams);
  assert.equal(read("limit=9999").limit, 200);
  assert.equal(read("limit=0").limit, 1);
  assert.equal(read("limit=not+a+number").limit, 50);
  assert.equal(read("offset=-5").offset, 0);
  assert.equal(read("min_seeders=12").minSeeders, 12);
});

test("unknown routes and methods", async () => {
  const config = settings();
  assert.equal((await run("GET", "https://w.dev/nope", {}, stub({}), config)).status, 404);
  assert.equal((await run("POST", "https://w.dev/api/v1/search", authed(), stub({}), config)).status, 405);
  // A verb the runtime does not model must not crash the router.
  assert.equal((await run("PROPFIND", "https://w.dev/", {}, stub({}), config)).status, 405);
  // A trailing slash is the same route.
  assert.equal((await run("GET", "https://w.dev/healthz/", {}, stub({}), config)).status, 200);
});

test("the banner answers a browser and can be turned off", async () => {
  const banner = await run("GET", "https://w.dev/", {}, stub({}), settings());
  assert.equal(banner.status, 200);
  assert.match(banner.text, /api\/v1\/search/);
  assert.equal((await run("GET", "https://w.dev/", {}, stub({}), settings({ banner: false }))).status, 404);
});

// ───────────────────────────────────────────────────────────────────────────
// The page that finishes setup
// ───────────────────────────────────────────────────────────────────────────

test("a browser at / gets its URL and its key, together", async () => {
  // Cloudflare invents the account part of the address and lengthens the name,
  // and the setup page forgot the key the moment it was left. The Worker is the
  // only party that knows both, so it says both, once, ready to copy.
  const host = "utsi-g85lc6-old-art-d5e6.demo.workers.dev";
  const key = "sekr-etke-yval-uehe-rezz-zzzz";
  const page = await run(
    "GET",
    `https://${host}/`,
    { accept: "text/html,application/xhtml+xml" },
    stub({}),
    settings({ apiKey: key }),
  );

  assert.equal(page.status, 200);
  assert.match(page.headers["Content-Type"], /^text\/html/);
  assert.match(page.headers["X-Robots-Tag"], /noindex/);
  assert.ok(page.text.includes(`https://${host}`), "the page says its own URL");
  assert.ok(page.text.includes(key), "and the key");
  assert.ok(/Anyone who can open this address can read the key/.test(page.text), "and says what that means");
  assert.ok(!page.text.includes("location.replace"), "and stays put");
  assert.ok(page.text.includes("knaben"), "and lists the engines it runs");
  assert.equal((page.text.match(/<script>/g) || []).length, 1, "one script block");
});

test("UTSI_SHOW_KEY=0 takes the key off the page and nothing else", async () => {
  const key = "sekr-etke-yval-uehe-rezz-zzzz";
  const hidden = readSettings({ UTSI_API_KEY: key, UTSI_SHOW_KEY: "0" });
  assert.equal(hidden.showKey, false);
  const page = await run("GET", "https://w.dev/", { accept: "text/html" }, stub({}), hidden);
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes(key), "the key leaked with UTSI_SHOW_KEY off");
  assert.match(page.text, /hidden/);
  assert.ok(page.text.includes("https://w.dev"), "the URL is still there");
});

test("an unconfigured Worker's page says where the key goes instead of serving one", async () => {
  const page = await run("GET", "https://w.dev/", { accept: "text/html" }, stub({}), readSettings({}));
  assert.equal(page.status, 503);
  assert.match(page.text, /API_KEY/);
});

test("anything that is not a browser still gets the plain banner", async () => {
  // curl, a TSP client, a monitor: none of them want HTML, and the text banner
  // is what they have always been handed.
  for (const headers of [{}, { accept: "*/*" }, { accept: "application/json" }]) {
    const reply = await run("GET", "https://w.dev/", headers, stub({}), settings());
    assert.equal(reply.status, 200);
    assert.match(reply.text, /^Public Tracker Search/);
  }
});

test("turning the banner off turns the page off with it", async () => {
  const off = settings({ banner: false });
  assert.equal((await run("GET", "https://w.dev/", { accept: "text/html" }, stub({}), off)).status, 404);
});

test("the artifact ships with no key in it", () => {
  assert.match(readFileSync(SOURCE, "utf8"), /^const API_KEY = "";$/m);
});

test("robots.txt asks every crawler to leave", async () => {
  // There is no list of other people's instances, and this is one small way of
  // keeping it that way.
  const robots = await run("GET", "https://w.dev/robots.txt", {}, stub({}), settings());
  assert.equal(robots.status, 200);
  assert.equal(robots.text, "User-agent: *\nDisallow: /\n");
});

test("CORS is named origins only", async () => {
  // A wildcard would let any page spend someone else's instance.
  const config = settings({ corsOrigins: ["https://app.test"] });
  const allowed = await run("GET", "https://w.dev/healthz", { origin: "https://app.test" }, stub({}), config);
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], "https://app.test");
  const other = await run("GET", "https://w.dev/healthz", { origin: "https://evil.test" }, stub({}), config);
  assert.ok(!("Access-Control-Allow-Origin" in (other.headers || {})));
  const preflight = await run("OPTIONS", "https://w.dev/api/v1/search", { origin: "https://app.test" }, stub({}), config);
  assert.equal(preflight.status, 204);
});

test("render emits compact JSON and a null body for 204", () => {
  const [status, body, headers] = render({ status: 200, body: { a: 1 }, headers: null, text: null });
  assert.equal(status, 200);
  assert.equal(body, '{"a":1}');
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(render({ status: 204, body: null, headers: null, text: null })[1], null);
  assert.equal(render({ status: 200, body: null, headers: null, text: "hi" })[1], "hi");
});

test("the engines endpoint lists all of them and marks the live ones", async () => {
  const config = settings({ engines: ["knaben", "yts"] });
  const reply = await run("GET", "https://w.dev/api/v1/engines", authed(), stub({}), config);
  assert.equal(reply.status, 200);
  const byId = Object.fromEntries(reply.body.map((row) => [row.id, row]));
  assert.deepEqual(Object.keys(byId).sort(), [...KNOWN_ENGINES].sort());
  assert.equal(byId.knaben.enabled, true);
  assert.equal(byId.torznab.enabled, false);
  assert.equal((await run("GET", "https://w.dev/api/v1/engines", {}, stub({}), config)).status, 401);
});

test("probing reports every engine, including the ones that are off", async () => {
  // "Which engines work from here" cannot be answered anywhere but here:
  // Cloudflare's addresses are not GitHub's, and being refused is per-network.
  const http = stub({
    [UPSTREAM]: fixture("upstream.json"),
    [TORRENTSCSV]: [403, ""],
    [YTS]: { status: "ok", data: { movie_count: 0 } },
    [KNABEN]: fixture("knaben.json"),
  });
  const config = settings({ engines: ["upstream", "knaben"] });
  const [summary, ...rows] = await probe(http, config);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

  assert.deepEqual(Object.keys(byId).sort(), [...KNOWN_ENGINES].sort(), "everything is tried, not only what is on");
  assert.equal(byId.knaben.ok, true);
  assert.equal(byId.knaben.rows, 2);
  assert.equal(byId.knaben.enabled, true);
  assert.equal(byId.yts.enabled, false, "off, but working — the whole point of probing what is disabled");
  assert.equal(byId.yts.ok, true);
  assert.equal(byId.yts.error, "answered with no rows");
  assert.equal(byId.torrentscsv.ok, false);
  assert.match(byId.torrentscsv.error, /HTTP 403/);
  assert.equal(summary.usable, "upstream,knaben");

  assert.equal((await run("GET", "https://w.dev/api/v1/engines?probe=1", {}, stub({}), config)).status, 401);
});

test("one slow engine does not cost the whole request", async () => {
  // The failure this exists to stop, measured on a deployed Worker: five engines
  // finished inside 805ms while a sixth took 5,535ms and returned nothing, and
  // the search paid 5.5s for rows nobody got. Before the fan-out had a clock of
  // its own, every engine budget outlived the request deadline, so nothing was
  // ever cut and `partial` was never emitted.
  const slow = {
    calls: [],
    async text(url, options = {}) {
      this.calls.push({ url, ...options });
      if (url.startsWith(KNABEN)) return [200, fixture("knaben.json")];
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return [200, "{}"];
    },
    async bytes() { return [404, new Uint8Array()]; },
  };

  const began = Date.now();
  const reply = await search(
    ask(),
    slow,
    settings({ engines: ["knaben", "torrentscsv"], requestDeadlineS: 1, engineTimeoutS: 30 }),
  );
  const took = Date.now() - began;

  assert.ok(took < 3000, `the fan-out waited ${took}ms for an engine it had no time for`);
  assert.equal(reply.body.partial, true, "a client must be told it is seeing a subset");
  assert.ok(reply.body.torrents.length > 0, "the engine that answered still counts");
  assert.deepEqual(reply.body.engines, ["knaben"]);
});

test("probing costs far fewer rows than a search", async () => {
  const many = { torrents: Array.from({ length: 50 }, (_, index) => ({
    infohash: String(index).padStart(40, "0"),
    name: `Row ${index}`,
    size_bytes: 1,
    seeders: 1,
  })) };
  const [, ...rows] = await probe(stub({ [TORRENTSCSV]: many }), settings());
  assert.equal(rows.find((row) => row.id === "torrentscsv").rows, 10);
});

// ───────────────────────────────────────────────────────────────────────────
// /healthz tells the truth
// ───────────────────────────────────────────────────────────────────────────

test("healthz needs no key and names the engines that are on", async () => {
  LIVENESS.engines.clear();
  const config = settings({ engines: ["knaben", "yts"] });
  const reply = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.engines, ["knaben", "yts"]);
  assert.equal(reply.body.runtime, "cloudflare-worker");
  assert.equal(reply.body.version, VERSION);
  assert.equal(reply.body.status, "ok");
});

test("healthz reports which address each engine is using and where it came from", async () => {
  LIVENESS.engines.clear();
  const config = settings({ engines: ["knaben", "yts"], engineUrls: { yts: "https://yts.example.test" } });
  const { body } = await run("GET", "https://w.dev/healthz", {}, stub({}), config);

  assert.equal(body.engine_status.knaben.origin, ENGINE_ORIGINS.knaben[0]);
  assert.equal(body.engine_status.knaben.origin_from, "built-in");
  assert.equal(body.engine_status.knaben.last, "unused", "nothing has been asked yet in this isolate");
  assert.equal(body.engine_status.yts.origin, "https://yts.example.test");
  assert.equal(body.engine_status.yts.origin_from, "UTSI_ENGINE_URLS");
  assert.ok(!("torznab" in body.engine_status), "engines that are off are not reported as live");
});

test("healthz stops saying ok once every engine it has tried is broken", async () => {
  // A fully broken Worker used to report "ok". In a paste-and-deploy model,
  // where nobody is watching a build log, that is the difference between a user
  // noticing and a user concluding the project is bad.
  LIVENESS.engines.clear();
  const config = settings({ engines: ["knaben", "torrentscsv"] });
  await search(ask(), stub({ [KNABEN]: [403, ""], [TORRENTSCSV]: [403, ""] }), config);

  const broken = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  assert.equal(broken.body.status, "degraded");
  assert.equal(broken.body.engine_status.knaben.last, "error");
  assert.match(broken.body.engine_status.knaben.error, /HTTP 403/);
  assert.equal(typeof broken.body.engine_status.knaben.seconds_ago, "number");

  // ...and back to ok as soon as one of them answers.
  await search(ask(), stub({ [KNABEN]: fixture("knaben.json"), [TORRENTSCSV]: [403, ""] }), config);
  const better = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  assert.equal(better.body.status, "ok");
  assert.equal(better.body.engine_status.knaben.last, "ok");
  assert.equal(better.body.engine_status.knaben.rows, 2);
});

test("healthz calls it degraded when the broad engines die and only a narrow one is left", async () => {
  // The failure the old check missed, and the reason `coverage` exists. yts is
  // films and nyaa is East Asian media; neither can answer a search for a book,
  // a disk image or a game. With every broad index down, this Worker answers
  // almost nothing — and it used to report "ok", because *something* replied.
  LIVENESS.engines.clear();
  const config = settings({ engines: ["knaben", "piratebay", "yts"] });
  await search(
    ask({ q: "sintel" }),
    stub({ [KNABEN]: [403, ""], [PIRATEBAY]: [503, ""], [YTS]: fixture("yts.json") }),
    config,
  );

  const narrow = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  assert.equal(narrow.body.coverage, "narrow");
  assert.equal(narrow.body.status, "degraded", "something answered, but not anything general");
  assert.equal(narrow.body.engine_status.yts.last, "ok");

  // One broad engine coming back is enough to make it honest again.
  LIVENESS.engines.clear();
  await search(
    ask({ q: "sintel" }),
    stub({ [KNABEN]: [403, ""], [PIRATEBAY]: fixture("piratebay.json"), [YTS]: fixture("yts.json") }),
    config,
  );
  const recovered = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  assert.equal(recovered.body.coverage, "broad");
  assert.equal(recovered.body.status, "ok", "knaben is still down, and that is now survivable");
});

test("healthz does not call a deliberately narrow roster degraded", async () => {
  // Someone who sets UTSI_ENGINES=yts,nyaa has a working deployment doing
  // exactly what they asked. Reporting that as degraded for ever would teach
  // them to ignore the health check, which is worse than not having one.
  LIVENESS.engines.clear();
  const config = settings({ engines: ["yts", "nyaa"] });
  await search(ask({ q: "sintel" }), stub({ [YTS]: fixture("yts.json"), [NYAA]: fixture("nyaa.xml") }), config);

  const narrow = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  assert.equal(narrow.body.coverage, "narrow");
  assert.equal(narrow.body.status, "ok");
});

test("healthz reports unknown coverage until a search has actually run", async () => {
  LIVENESS.engines.clear();
  const fresh = await run("GET", "https://w.dev/healthz", {}, stub({}), settings());
  assert.equal(fresh.body.coverage, "unknown");
  assert.equal(fresh.body.status, "ok", "nothing has failed, because nothing has been tried");
});

test("every engine is declared broad or narrow", () => {
  // A new engine that nobody classified would silently count as narrow, and the
  // coverage report would quietly start lying in the direction of alarm.
  const seeded = new Map(SEED_DESCRIPTORS.map((d) => [d.name, d]));
  for (const engineId of KNOWN_ENGINES) {
    const breadth = ENGINE_BREADTH[engineId] || (seeded.get(engineId) || {}).breadth;
    assert.ok(["broad", "narrow"].includes(breadth), `${engineId} declares no breadth`);
  }
});

test("healthz never says where your own index is", async () => {
  // `/healthz` takes no key, and UTSI_UPSTREAM_URL is a secret — it is the
  // address of a private server. Per-engine reporting is exactly the kind of
  // feature that leaks one by accident, so this pins it: the engines that point
  // at something of yours report a description, never an address, and their
  // error text is about the key rather than the host.
  LIVENESS.engines.clear();
  const config = settings({
    engines: ["upstream", "knaben"],
    upstreamUrl: "https://private-box.example.internal",
    upstreamApikey: "u".repeat(40),
    fallbackUrl: "https://also-private.example.internal",
    torznabUrl: "https://jackett.example.internal/api",
  });
  await search(ask(), stub({ "https://private-box.example.internal": [502, ""] }), config);

  const { body } = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  const printed = JSON.stringify(body);
  for (const secret of ["private-box", "also-private", "jackett.example", "uuuu"]) {
    assert.ok(!printed.includes(secret), `${secret} appears in an unauthenticated /healthz`);
  }
  assert.equal(body.engine_status.upstream.origin, "(your own TSP index)");
  assert.equal(body.engine_status.upstream.last, "error");
});

test("healthz distinguishes a timeout from an error", async () => {
  LIVENESS.engines.clear();
  const http = stub({});
  http.text = () => new Promise((resolve) => setTimeout(() => resolve([200, "{}"]), 5000));
  const config = settings({ engines: ["knaben"], engineTimeoutS: 0.05, requestDeadlineS: 0.5 });
  await search(ask(), http, config);
  const { body } = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  assert.equal(body.engine_status.knaben.last, "timeout");
});

test("healthz says when a newer version exists, and never lets that break a search", async () => {
  LIVENESS.engines.clear();
  UPDATE_MEMO.at = 0;
  UPDATE_MEMO.value = null;
  const config = settings({ engines: ["knaben"] });

  // Unreachable feed: the field is simply absent, and nothing else changes.
  const offline = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  assert.ok(!("update" in offline.body));
  assert.equal(offline.body.status, "ok");

  const feed = stub({ "https://momzv2022-ctrl.github.io": { version: "99.0.0" } });
  const newer = await run("GET", "https://w.dev/healthz", {}, feed, config);
  assert.deepEqual(
    { latest: newer.body.update.latest, available: newer.body.update.available },
    { latest: "99.0.0", available: true },
  );
  // The check is asked for with Cloudflare's own cache, and memoised on top, so
  // a second /healthz costs nothing.
  assert.deepEqual(feed.calls[0].cf, { cacheTtl: 3600, cacheEverything: true });
  const again = await run("GET", "https://w.dev/healthz", {}, feed, config);
  assert.equal(again.body.update.latest, "99.0.0");
  assert.equal(feed.calls.length, 1, "memoised for an hour");

  // Never on the search path: a search must make one subrequest per engine and
  // not one more.
  UPDATE_MEMO.at = 0;
  UPDATE_MEMO.value = null;
  const searching = stub({ [KNABEN]: fixture("knaben.json") });
  await search(ask(), searching, config);
  assert.equal(searching.calls.length, 1);

  // ...and it can be switched off entirely. It is the one request this Worker
  // makes that is not on your behalf.
  const silent = stub({ "https://momzv2022-ctrl.github.io": { version: "99.0.0" } });
  const quiet = await run("GET", "https://w.dev/healthz", {}, silent, { ...config, updateCheck: false });
  assert.ok(!("update" in quiet.body));
  assert.equal(silent.calls.length, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// Reading the environment
// ───────────────────────────────────────────────────────────────────────────

const fromEnv = (pairs = {}) => readSettings({ UTSI_API_KEY: KEY, ...pairs });

test("setting an upstream URL makes it the first engine", async () => {
  const WITHOUT_UPSTREAM = [
    "knaben", "piratebay", "torrentscsv", "torrentdownload", "rutor",
    "yts", "eztvx", "animetosho", "sukebei", "dmhy", "archive",
  ];
  assert.deepEqual(fromEnv().engines, WITHOUT_UPSTREAM);
  assert.deepEqual(
    fromEnv({ UTSI_UPSTREAM_URL: UPSTREAM_BASE }).engines,
    ["upstream", ...WITHOUT_UPSTREAM],
  );
  // The general indexes lead: the first engine to report a release supplies
  // its name and details, and a DHT crawl's name is the file name.
  assert.equal(WITHOUT_UPSTREAM[0], "knaben");
  // Four indexes ship `enabled: false`: measured from a deployed Worker on
  // 2026-09-05, Cloudflare's addresses get 429, 403, an interstitial or no
  // answer from them. They are still engines — naming one in UTSI_ENGINES
  // turns it on for a deployment the site happens to answer.
  for (const off of ["bitsearch", "torrentdownloads", "torrentkitty", "nyaa"]) {
    assert.ok(!fromEnv().engines.includes(off), `${off} is off by default`);
    assert.equal(SEED_DESCRIPTORS.find((d) => d.name === off).enabled, false);
  }
  assert.deepEqual(fromEnv({ UTSI_ENGINES: "nyaa,knaben" }).engines, ["nyaa", "knaben"]);
});

test("a paste-and-deploy worker gets a tight deadline, one fronting an upstream does not", () => {
  // Most people deploy this file and change nothing, so the shipped numbers have
  // to be the good ones. Three seconds is measured: every index that answered a
  // deployed Worker answered within 1.4s. An upstream is not an index though —
  // it is another metasearch running its own fan-out — so it keeps the long one.
  assert.equal(fromEnv().requestDeadlineS, 3);
  assert.equal(fromEnv({ UTSI_UPSTREAM_URL: UPSTREAM_BASE }).requestDeadlineS, 20);
  assert.equal(fromEnv({ UTSI_REQUEST_DEADLINE_S: "9" }).requestDeadlineS, 9);
});

test("anything that is not a URL means no upstream", () => {
  // The value people are told to type when they have no index of their own has
  // to read exactly like leaving it blank.
  for (const typed of ["none", "None", "n/a", "-", "", "   ", "your-box.example.com"]) {
    const config = fromEnv({ UTSI_UPSTREAM_URL: typed, UTSI_UPSTREAM_APIKEY: "none" });
    assert.equal(config.upstreamUrl, "", typed);
    assert.equal(config.upstreamApikey, "");
    assert.ok(!config.engines.includes("upstream"));
  }
});

test("a pasted API URL is trimmed back to its origin", () => {
  // It is the URL that was in front of them when they went looking.
  for (const pasted of [
    UPSTREAM_BASE + "/api/v1/search",
    UPSTREAM_BASE + "/api/v1/search/",
    UPSTREAM_BASE + "/api/v1",
    UPSTREAM_BASE + "/api",
    UPSTREAM_BASE + "/",
  ]) {
    assert.equal(fromEnv({ UTSI_UPSTREAM_URL: pasted }).upstreamUrl, UPSTREAM_BASE, pasted);
  }
});

test("engine order is verbatim, duplicates collapse, and the cap is a prefix", () => {
  const ordered = fromEnv({ UTSI_ENGINES: "yts,upstream,knaben", UTSI_UPSTREAM_URL: UPSTREAM_BASE });
  assert.deepEqual(ordered.engines, ["yts", "upstream", "knaben"]);
  assert.deepEqual(fromEnv({ UTSI_ENGINES: "knaben,yts,knaben" }).engines, ["knaben", "yts"]);
  assert.deepEqual(fromEnv({ UTSI_ENGINES: ["knaben", "yts"].join(",").repeat(12) }).engines.slice(0, 2), [
    "knaben",
    "yts",
  ]);
});

test("an engine that cannot run is named, and the reason given", async () => {
  const config = fromEnv({ UTSI_ENGINES: "upstream,knaben,nosuchengine,torznab,fallback" });
  assert.deepEqual(config.engines, ["knaben"]);
  const health = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  assert.deepEqual(health.body.rejected_engines, {
    upstream: "UTSI_UPSTREAM_URL is not an https:// address",
    nosuchengine: "no such engine",
    torznab: "UTSI_TORZNAB_URL is not set",
    fallback: "not a fan-out engine; it is the empty-result fallback",
  });
});

test("a default deploy does not complain about what nobody asked for", async () => {
  const config = fromEnv();
  assert.deepEqual(config.rejectedEngines, {});
  const health = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  assert.ok(!("rejected_engines" in health.body));
});

test("UTSI_ENGINE_URLS is read as a map and bad entries are ignored", () => {
  const config = fromEnv({ UTSI_ENGINE_URLS: "yts=https://yts.bz/,torrentscsv=,=x,nonsense" });
  assert.deepEqual(config.engineUrls, { yts: "https://yts.bz" });
});

test("no index of anyone else's is pointed at by default", () => {
  // A default for either would send every deployment's searches through one
  // machine, which is the thing this project exists not to be.
  const config = fromEnv();
  assert.equal(config.upstreamUrl, "");
  assert.equal(config.fallbackUrl, "");
  assert.ok(!config.engines.includes("upstream"));

  const source = readFileSync(SOURCE, "utf8");
  assert.ok(!source.includes("workers.dev/"), "no deployment's address may be baked in");
});

test("numeric and flag settings are clamped, not trusted", () => {
  assert.equal(fromEnv({ UTSI_MAX_ROWS_PER_ENGINE: "9999" }).maxRowsPerEngine, 500);
  assert.equal(fromEnv({ UTSI_MAX_ROWS_PER_ENGINE: "1" }).maxRowsPerEngine, 10);
  assert.equal(fromEnv({ UTSI_MAX_ROWS_PER_ENGINE: "banana" }).maxRowsPerEngine, 40);
  assert.equal(fromEnv().maxRowsPerEngine, 40, "three times the engines, so fewer rows from each");
  assert.equal(fromEnv().maxResolve, 4, "the Archive's rows arrive without a hash");
  assert.equal(fromEnv({ UTSI_MAX_RESOLVE: "99" }).maxResolve, 16);
  assert.equal(fromEnv({ UTSI_ALLOW_ANONYMOUS: "yes" }).allowAnonymous, true);
  assert.equal(fromEnv({ UTSI_ALLOW_ANONYMOUS: "0" }).allowAnonymous, false);
  assert.equal(fromEnv({ UTSI_BANNER: "off" }).banner, false);
  // The setup page's origin is compiled in so it can run a real search against a
  // Worker the moment it is deployed. UTSI_CORS_ORIGINS adds to it; nothing in
  // the environment takes it away.
  const setupOrigin = "https://momzv2022-ctrl.github.io";
  assert.deepEqual(fromEnv().corsOrigins, [setupOrigin]);
  assert.deepEqual(fromEnv({ UTSI_CORS_ORIGINS: "https://a.test, https://b.test" }).corsOrigins, [
    setupOrigin,
    "https://a.test",
    "https://b.test",
  ]);
});

test("the setup page can read an answer, and nobody else can", async () => {
  // The one compiled-in origin exists so the setup page's "test your URL and
  // key" button can show a real answer instead of asking for faith. It is an
  // origin and not a wildcard, so it is that page and nothing else, and a caller
  // from it still has to present the key.
  const config = settings();
  const setup = "https://momzv2022-ctrl.github.io";

  const allowed = await run("GET", "https://w.dev/healthz", { origin: setup }, stub({}), config);
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], setup);
  assert.equal(allowed.headers.Vary, "Origin");

  for (const origin of [
    "https://momzv2022-ctrl.github.io.evil.test",
    "http://momzv2022-ctrl.github.io",
    "https://evil.test",
    "null",
  ]) {
    const refused = await run("GET", "https://w.dev/healthz", { origin }, stub({}), config);
    assert.equal(refused.headers["Access-Control-Allow-Origin"], undefined, origin);
  }
});

test("UTSI_API_KEY wins over the key baked into the file", () => {
  // That is how you rotate the key without pasting the file again.
  assert.equal(fromEnv({ UTSI_API_KEY: "from-the-dashboard-0123" }).apiKey, "from-the-dashboard-0123");
  assert.equal(readSettings({}).apiKey, "", "and the committed file carries none");
});

// ───────────────────────────────────────────────────────────────────────────
// The small tools
// ───────────────────────────────────────────────────────────────────────────

test("infohashes normalise from hex and base32", () => {
  assert.equal(normalizeInfohash("DD8255ECDC7CA55FB0BBF81323D87062DB1F6D1C"), "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c");
  // The same hash, base32-encoded, which is the other spelling BEP-9 allows.
  assert.equal(normalizeInfohash("3WBFL3G4PSSV7MF37AJSHWDQMLNR63I4"), "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c");
  for (const junk of ["", null, "xyz", "g".repeat(40), "0".repeat(39)]) {
    assert.equal(normalizeInfohash(junk), null, String(junk));
  }
});

test("magnets encode every character the standard reserves", () => {
  const hash = "d".repeat(40);
  const magnet = magnetFor(hash, "Awkward & name/with?chars=1 100% (2008)");
  const displayName = magnet.slice(magnet.indexOf("&dn=") + 4, magnet.indexOf("&tr="));
  // Byte-for-byte what the local server's `quote(name, safe="")` produces —
  // including the brackets and the apostrophe-class characters that
  // `encodeURIComponent` leaves alone, which is the whole reason `quote()`
  // exists in this file rather than a call to the built-in.
  assert.equal(displayName, "Awkward%20%26%20name%2Fwith%3Fchars%3D1%20100%25%20%282008%29");
  assert.equal(
    magnetFor(hash, "!'()*").slice(magnet.indexOf("&dn=") + 4).split("&tr=")[0],
    "%21%27%28%29%2A",
  );
  assert.ok(magnetFor(hash, "").startsWith(`magnet:?xt=urn:btih:${hash}&tr=`));
  assert.equal(magnet.split("&tr=").length - 1, 5);
});

test("HTML entities are decoded before anything uses the name", () => {
  // Seen live: "Linux Command Line (Hands-On) Ubuntu Linux &amp; Linux
  // Scripting". Left encoded it reaches the client, ends up in the magnet's
  // display name, and stops the row deduplicating against the same release from
  // an engine that decoded it.
  assert.equal(
    htmlUnescape("Ubuntu Linux &amp; Scripting &#8211; 2024 &quot;Edition&quot;"),
    'Ubuntu Linux & Scripting – 2024 "Edition"',
  );
  assert.equal(htmlUnescape("&amp"), "&", "a browser accepts the legacy ones without a semicolon");
  assert.equal(htmlUnescape("a &notit; b"), "a ¬it; b", "longest match, then literal text");
  assert.equal(htmlUnescape("&unknownref;"), "&unknownref;", "an entity we do not know is left alone");
  assert.equal(htmlUnescape("&#x27;"), "'");
  assert.equal(htmlUnescape("&#146;"), "’", "cp1252 in numeric-reference clothing");
  assert.equal(htmlUnescape("no ampersand here"), "no ampersand here");
});

test("human-readable sizes come back to bytes", () => {
  assert.equal(humanSize("1.4 GiB"), Math.trunc(1.4 * 1024 ** 3));
  assert.equal(humanSize("420.7 MiB"), Math.trunc(420.7 * 1024 ** 2));
  assert.equal(humanSize("3 TB"), 3 * 1000 ** 4);
  assert.equal(humanSize("512 Bytes"), 512);
  for (const junk of ["", "GiB", "1.4", "1.4 parsecs", "NaN GiB", null]) {
    assert.equal(humanSize(junk), null, String(junk));
  }
});

test("RFC 822 dates come back as ISO-8601, keeping the offset they were given", () => {
  assert.equal(pubDate("Wed, 01 May 2024 12:00:00 -0000"), "2024-05-01T12:00:00Z", "-0000 means UTC, zone unknown");
  assert.equal(pubDate("Tue, 01 Jan 2019 00:00:00 +0000"), "2019-01-01T00:00:00Z");
  assert.equal(pubDate("Tue, 01 Jan 2019 00:00:00 GMT"), "2019-01-01T00:00:00Z");
  assert.equal(pubDate("Tue, 01 Jan 2019 01:02:03 +0230"), "2019-01-01T01:02:03+02:30");
  assert.equal(pubDate("Tue, 01 Jan 2019 00:00:00 -0500"), "2019-01-01T00:00:00-05:00");
  assert.equal(pubDate("Tue, 01 Jan 2019 00:00:00 EST"), "2019-01-01T00:00:00-05:00");
  assert.equal(pubDate("Tue, 1 Jan 19 00:00:00 +0000"), "2019-01-01T00:00:00Z");
  for (const junk of ["garbage", "", null, "Tue, 32 Xyz 2019 00:00:00 +0000"]) {
    assert.equal(pubDate(junk), null, String(junk));
  }
});

test("release names give up their six fields", () => {
  assert.deepEqual(parseName("Big.Buck.Bunny.2008.1080p.BluRay.x264-GRP"), {
    year: "2008",
    resolution: "1080p",
    codec: "x264",
    source: "bluray",
  });
  assert.deepEqual(parseName("Show.Name.S01E02.720p.WEB-DL.x265"), {
    resolution: "720p",
    codec: "x265",
    source: "web-dl",
    season: "01",
    episode: "02",
  });
  // A film called "2012" released in 2009: the year is the one before the first
  // quality marker, not the one in the title.
  assert.equal(parseName("2012.2009.1080p.BluRay").year, "2009");
  assert.deepEqual(parseName(""), {});
  assert.deepEqual(parseName("A plain title with nothing in it"), {});
});

test("word boundaries behave the way the local server's do, not the way JavaScript's do", () => {
  // JavaScript's own \b stops at ASCII, so `\bx264\b` would match inside a
  // Japanese title where the local server's would not — and the two would then
  // classify the same release differently.
  assert.deepEqual(parseName("アニメx264"), {}, "no boundary between a letter and a letter");
  assert.equal(parseName("アニメ x264").codec, "x264", "a space is a boundary in both");
  assert.equal(classifyName("日本語1080p"), null);
  assert.equal(classifyName("日本語 1080p"), "video");
});

test("classifying a name reads markers, and says so when there are none", () => {
  assert.equal(classifyName("Some.Show.S01E01.1080p"), "video");
  assert.equal(classifyName("Album Name FLAC 2019"), "audio");
  assert.equal(classifyName("Ubuntu 24.04 iso"), "software");
  assert.equal(classifyName("Some Title epub"), "document");
  assert.equal(classifyName("Nature wallpapers"), "image");
  assert.equal(classifyName("archive.rar"), "archive");
  assert.equal(classifyName("Big Buck Bunny"), null, "no idea is not no");
  assert.equal(classifyName(""), null);
});

test("TSP's query separator rules are applied once, before the fan-out", () => {
  assert.equal(normalizeQuery("  Big.Buck_Bunny-2008  "), "Big Buck Bunny 2008");
  assert.equal(normalizeQuery("a[b]c(d)"), "a b c d");
  assert.equal(normalizeQuery(""), "");
});

// ───────────────────────────────────────────────────────────────────────────
// TGP: engines as data
// ───────────────────────────────────────────────────────────────────────────

test("expression paths walk own properties only, and ^. steps outward", () => {
  const scopes = [{ a: { b: [{ c: "found" }] } }, { parent: "yes" }];
  assert.equal(resolvePath(scopes, "a.b.0.c"), "found");
  assert.equal(resolvePath(scopes, "^.parent"), "yes");
  assert.equal(resolvePath(scopes, "a.missing"), undefined);
  assert.equal(resolvePath(scopes, "a.b.9.c"), undefined);
  // A hostile key must find nothing rather than a function off the prototype.
  assert.equal(resolvePath(scopes, "constructor"), undefined);
  assert.equal(resolvePath(scopes, "a.b.constructor"), undefined);
});

test("coercions are total: a value or absent, never NaN, zero or a default", () => {
  // Integers: the strict rule intOrNone already enforced, for every engine.
  for (const junk of [null, "", "abc", "1e999", "-3", "9".repeat(20), true, 1e999]) {
    assert.equal(coerceValue("seeders", junk), null, String(junk));
  }
  assert.equal(coerceValue("seeders", "0"), 0, "a swarm of zero is a fact, not an absence");
  assert.equal(coerceValue("size_bytes", "0", { nonzero: true }), null, "unless the site says 0 for unknown");
  assert.equal(coerceValue("size_bytes", "1.4 GiB"), Math.trunc(1.4 * 1024 ** 3));
  assert.equal(coerceValue("size_bytes", "1.5", { unit: "mib" }), 1572864);
  assert.equal(coerceValue("size_bytes", "-1.5", { unit: "mib" }), null);

  // Dates: ISO passes through as written, integers are epoch seconds or
  // milliseconds, RFC 822 is what feeds speak, and junk is no date at all.
  assert.equal(coerceValue("first_seen", "2019-01-01T00:00:00+00:00"), "2019-01-01T00:00:00+00:00");
  assert.equal(coerceValue("first_seen", 1546300700), "2018-12-31T23:58:20Z");
  assert.equal(coerceValue("first_seen", "Wed, 01 May 2024 12:00:00 -0000"), "2024-05-01T12:00:00Z");
  for (const junk of ["0", 0, "yesterday", ""]) assert.equal(coerceValue("first_seen", junk), null);

  // Infohashes: hex, base32, or fished out of a magnet.
  assert.equal(coerceValue("infohash", "D".repeat(40)), "d".repeat(40));
  assert.equal(coerceValue("infohash", `magnet:?xt=urn:btih:${"e".repeat(40)}&dn=x`), "e".repeat(40));
  assert.equal(coerceValue("infohash", "not a hash"), null);
});

test("the validator holds the feed's descriptors to the schema, one by one", () => {
  const good = {
    name: "example",
    kind: "json",
    origins: ["https://example.test"],
    rows: "torrents",
    fields: { name: "name", infohash: "hash" },
  };
  assert.equal(descriptorProblem(good), "");
  assert.equal(descriptorProblem({ ...good, kind: "carrier-pigeon" }), "", "unknown kinds are skipped, not invalid");
  assert.match(descriptorProblem({ ...good, name: "upstream" }), /reserved/);
  assert.match(descriptorProblem({ ...good, name: "Bad Name!" }), /name/);
  assert.match(descriptorProblem({ ...good, origins: ["http://example.test"] }), /https/);
  assert.match(descriptorProblem({ ...good, origins: [] }), /origins/);
  assert.match(
    descriptorProblem({ ...good, fields: { name: Array.from({ length: 9 }, (_, i) => `n${i}`) } }),
    /alternatives/,
  );
  assert.match(descriptorProblem({ ...good, fields: { name: "a.".repeat(40) + "z" } }), /path/);
  assert.match(descriptorProblem({ ...good, fields: { sneaky: "x" } }), /unknown field/);
  assert.match(descriptorProblem({ ...good, fields: { name: { from: "x", map: { a: "video" } } } }), /map/);
  assert.match(
    descriptorProblem({ ...good, fields: { category: { from: "x", map: { 1: "films" } } } }),
    /category/,
  );
  assert.match(descriptorProblem({ ...good, fields: { name: { from: "x", template: "https://x/{value}" } } }), /template/);
});

/** One feed document, as the repository publishes it. */
function plainFeed(engines, envelope = {}) {
  return JSON.stringify({
    tgp_version: 1,
    serial: 7,
    issued_at: "2026-08-17T04:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    moved_to: null,
    mirrors: [],
    engines,
    ...envelope,
  });
}

/** The feed as a stub route. */
function feedRoutes(text, base = "https://feed.test/") {
  return { [base + "feed.json"]: [200, text] };
}

/** A stand-in for the Cache API that remembers exactly one entry. */
function fakeCache() {
  const store = new Map();
  return {
    async match(key) {
      const text = store.get(key);
      return text === undefined ? null : { json: async () => JSON.parse(text) };
    },
    async put(key, response) {
      store.set(key, await response.text());
    },
  };
}

const FEED_URL = "https://feed.test/feed.json";
const feedSettings = (overrides = {}) => settings({ feedUrl: FEED_URL, ...overrides });

test("a loaded feed re-points an engine and introduces a new one, and env still wins", async (t) => {
  t.after(resetFeed);
  const moved = {
    name: "knaben",
    kind: "json",
    breadth: "broad",
    origins: ["https://knaben-moved.test"],
    request: { method: "POST", path: "/v1", body: { query: "{q}", size: "{limit}" } },
    rows: "hits",
    rows_required: true,
    provenance: "tracker",
    fields: { name: "title", infohash: ["hash", "magnetUrl"], size_bytes: "bytes", seeders: "seeders", leechers: "peers" },
  };
  const bridge = { name: "bridge1", kind: "tsp", breadth: "broad", origins: ["https://bridge.test"] };
  const alien = { name: "hologram", kind: "quantum", origins: ["https://hologram.test"] };
  const broken = { name: "broken", kind: "json", origins: ["https://broken.test"], rows: "x", fields: { sneaky: "y" } };
  const text = plainFeed([moved, bridge, alien, broken]);

  const refreshed = await refreshFeed(stub(feedRoutes(text)), feedSettings(), { cache: fakeCache() });
  assert.equal(refreshed, true);
  assert.equal(FEED.serial, 7);
  assert.ok(FEED.engines.has("knaben") && FEED.engines.has("bridge1"));
  assert.deepEqual(FEED.unsupportedKinds, ["hologram: quantum"], "a 2029 kind is skipped, not fatal");
  assert.equal(FEED.invalidDescriptors.length, 1, "one malformed entry does not blank the deployment");
  assert.match(FEED.invalidDescriptors[0], /^broken:/);

  // The feed's address book now drives knaben; UTSI_ENGINE_URLS still outranks it.
  const config = feedSettings();
  assert.deepEqual(originsFor("knaben", config), [{ url: "https://knaben-moved.test", from: "feed" }]);
  assert.deepEqual(
    originsFor("knaben", { ...config, engineUrls: { knaben: "https://mine.test" } }),
    [{ url: "https://mine.test", from: "UTSI_ENGINE_URLS" }],
  );

  // The new engine joins the default roster last, and searches like any other —
  // with no credential, because a feed engine is a public engine.
  const roster = readSettings({ UTSI_API_KEY: KEY }).engines;
  assert.equal(roster[roster.length - 1], "bridge1");
  const http = stub({
    "https://knaben-moved.test/v1": fixture("knaben.json"),
    "https://bridge.test/api/v1/search": fixture("upstream.json"),
  });
  const reply = await search(
    ask(),
    http,
    feedSettings({ engines: ["knaben", "bridge1"], upstreamApikey: "SECRET-UPSTREAM" }),
  );
  assert.deepEqual(reply.body.engines, ["knaben", "bridge1"]);
  assert.ok(reply.body.torrents.length);
  for (const call of http.calls) {
    for (const header of Object.keys(call.headers || {})) {
      assert.ok(!/^(authorization|x-api-key|cookie)$/i.test(header), `${header} sent to ${call.url}`);
    }
  }

  // /healthz says what the feed is, and which layer configured each engine.
  const health = await run("GET", "https://w.dev/healthz", {}, stub({}), feedSettings());
  assert.equal(health.body.feed.status, "live");
  assert.equal(health.body.feed.serial, 7);
  assert.equal(health.body.engine_status.knaben.config, "feed");
  assert.equal(health.body.engine_status.torrentscsv.config, "seed");
});

test("a feed marking an engine dead takes it out of the default roster", async (t) => {
  t.after(resetFeed);
  const dead = {
    name: "eztvx",
    kind: "json",
    enabled: false,
    origins: ["https://eztvx.to"],
    rows: "torrents",
    fields: { name: "title", infohash: "hash" },
  };
  await refreshFeed(stub(feedRoutes(plainFeed([dead]))), feedSettings(), { cache: fakeCache() });
  const roster = readSettings({ UTSI_API_KEY: KEY }).engines;
  assert.ok(!roster.includes("eztvx"), "the per-request budget stops burning on a corpse");
  // ...but naming it in UTSI_ENGINES still wins: the operator outranks the feed.
  assert.ok(readSettings({ UTSI_API_KEY: KEY, UTSI_ENGINES: "eztvx" }).engines.includes("eztvx"));
});

test("every way a feed can be bad degrades to the seed, and names the reason", async (t) => {
  t.after(resetFeed);
  const engine = {
    name: "knaben", kind: "json", origins: ["https://elsewhere.test"],
    rows: "hits", fields: { name: "title", infohash: "hash" },
  };
  const text = plainFeed([engine]);

  const cases = [
    ["a 404", { [FEED_URL]: [404, ""] }, /HTTP 404/],
    ["a truncated file", feedRoutes(text.slice(0, 50)), /not JSON/],
    ["an HTML page where the feed should be", feedRoutes("<!doctype html><title>Moved</title>"), /not JSON/],
    ["a list, not a feed", feedRoutes("[]"), /not an object/],
    ["a feed from the future", feedRoutes(plainFeed([engine], { tgp_version: 9 })), /version 9/],
    ["an expired feed", feedRoutes(plainFeed([engine], { expires_at: "2020-01-01T00:00:00Z" })), /expired/],
    ["no serial", feedRoutes(plainFeed([engine], { serial: "seven" })), /serial/],
    ["no engines", feedRoutes(plainFeed([engine], { engines: null })), /no engines/],
  ];
  for (const [what, routes, expected] of cases) {
    resetFeed();
    const refreshed = await refreshFeed(stub(routes), feedSettings(), { cache: fakeCache() });
    assert.equal(refreshed, false, what);
    assert.equal(FEED.engines, null, `${what} must not load anything`);
    assert.match(FEED.error, expected, what);

    // The failure never reaches a search: the seed configuration serves.
    const reply = await search(
      ask(),
      stub({ [KNABEN]: fixture("knaben.json") }),
      feedSettings({ engines: ["knaben"] }),
    );
    assert.equal(reply.status, 200);
    assert.ok(reply.body.torrents.length, `${what} broke a search`);
    const health = await run("GET", "https://w.dev/healthz", {}, stub({}), feedSettings());
    assert.equal(health.body.feed.status, "seed_only", what);
    assert.ok(health.body.feed.error, `${what} is invisible in /healthz`);
  }

  // Before anything has been fetched the report says so, rather than blaming
  // a feed nobody has asked for yet.
  resetFeed();
  const fresh = await run("GET", "https://w.dev/healthz", {}, stub({}), feedSettings());
  assert.equal(fresh.body.feed.status, "not_yet_fetched");
});

test("the last good feed survives the network going away, and rollback is refused", async (t) => {
  t.after(resetFeed);
  const engine = {
    name: "knaben", kind: "json", origins: ["https://moved.test"],
    rows: "hits", fields: { name: "title", infohash: "hash" },
  };
  const cache = fakeCache();
  await refreshFeed(stub(feedRoutes(plainFeed([engine]))), feedSettings(), { cache });
  assert.equal(FEED.serial, 7);

  // A cold isolate with the network down: the cached copy is re-read and
  // serves, marked as what it is.
  resetFeed();
  await refreshFeed(stub({}), feedSettings(), { cache });
  assert.ok(FEED.engines && FEED.engines.has("knaben"), "the cache is the last known good");
  assert.equal(FEED.fromCache, true);
  const health = await run("GET", "https://w.dev/healthz", {}, stub({}), feedSettings());
  assert.equal(health.body.feed.status, "cache");

  // An older feed is a replay: the cache remembers serial 7, so serial 3 is
  // refused, and the cached serial-7 feed keeps serving.
  resetFeed();
  const chainCache = fakeCache();
  await refreshFeed(stub(feedRoutes(plainFeed([engine]))), feedSettings(), { cache: chainCache });
  assert.equal(FEED.serial, 7);
  await refreshFeed(stub(feedRoutes(plainFeed([engine], { serial: 3 }))), feedSettings(), { cache: chainCache });
  assert.equal(FEED.serial, 7, "the replay did not take");
  assert.match(FEED.error, /serial 3 is older than 7/);

  // A cached copy that has since expired is not served either: the cache is
  // checked like a download.
  resetFeed();
  const staleCache = fakeCache();
  await staleCache.put(
    "https://feed.public-tracker-search.internal/last-known-good",
    new Response(JSON.stringify({ serial: 2, storedAt: 0, text: plainFeed([engine], { serial: 2, expires_at: "2020-01-01T00:00:00Z" }) })),
  );
  await refreshFeed(stub({}), feedSettings(), { cache: staleCache });
  assert.equal(FEED.engines, null, "an expired cache entry does not serve");
});

test("UTSI_FEED=0 keeps the feed dark, and the seed alone still searches", async (t) => {
  t.after(resetFeed);
  const config = readSettings({ UTSI_API_KEY: KEY, UTSI_FEED: "0" });
  assert.equal(config.feed, false);
  const http = stub(feedRoutes(plainFeed([])));
  const refreshed = await refreshFeed(http, config, { cache: fakeCache() });
  assert.equal(refreshed, false);
  assert.equal(http.calls.length, 0, "off means not even fetched");

  const reply = await search(
    ask(),
    stub({ [TORRENTSCSV]: fixture("torrentscsv.json") }),
    { ...config, engines: ["torrentscsv"] },
  );
  assert.ok(reply.body.torrents.length, "the compiled-in seed is a complete configuration");
  const health = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  assert.equal(health.body.feed.status, "disabled");
});

test("a moved_to in the feed surfaces in /healthz", async (t) => {
  t.after(resetFeed);
  await refreshFeed(
    stub(feedRoutes(plainFeed([], { moved_to: "https://new-home.example.org" }))),
    feedSettings(),
    { cache: fakeCache() },
  );
  const health = await run("GET", "https://w.dev/healthz", {}, stub({}), feedSettings());
  assert.equal(health.body.feed.moved_to, "https://new-home.example.org");
});

test("a descriptor that stopped matching its site reads as a collapsed emit ratio", async () => {
  // The drift alarm: the fetch is a 200, the JSON parses, and every row fails
  // the invariants — which used to be indistinguishable from healthy.
  LIVENESS.engines.clear();
  const renamed = {
    torrents: [
      { new_hash_field: "1".repeat(40), title_v2: "Renamed One" },
      { new_hash_field: "2".repeat(40), title_v2: "Renamed Two" },
    ],
  };
  const config = settings({ engines: ["torrentscsv"] });
  await search(ask(), stub({ [TORRENTSCSV]: renamed }), config);
  const health = await run("GET", "https://w.dev/healthz", {}, stub({}), config);
  const entry = health.body.engine_status.torrentscsv;
  assert.equal(entry.rows_seen, 2);
  assert.equal(entry.rows_emitted, 0);
  assert.equal(entry.drop_ratio, 1);
});

test("junk in a numeric field is an omitted key on the wire — never 0, NaN or null", async () => {
  const body = `{"torrents": [
    {"infohash": "${"a".repeat(40)}", "name": "Bunny Junk Numbers", "size_bytes": null, "seeders": "", "leechers": "abc"},
    {"infohash": "${"b".repeat(40)}", "name": "Bunny Overflow", "size_bytes": 1e999, "seeders": "3"}
  ]}`;
  const reply = await search(
    ask(),
    stub({ [TORRENTSCSV]: [200, body] }),
    settings({ engines: ["torrentscsv"] }),
  );
  const junk = reply.body.torrents.find((t) => t.infohash === "a".repeat(40));
  const overflow = reply.body.torrents.find((t) => t.infohash === "b".repeat(40));
  for (const field of ["size_bytes", "seeders", "leechers"]) {
    assert.ok(!(field in junk), `${field} should be omitted, not invented`);
  }
  assert.ok(!("size_bytes" in overflow), "1e999 is not a size");
  assert.equal(overflow.seeders, 3);
});

test("a descriptor engine still walks its address list when the first host is gone", async () => {
  // The origin-retry behaviour the hand-written adapters had, proven for the
  // descriptor path too: knaben's .org dies, .eu answers.
  LIVENESS.engines.clear();
  const second = ENGINE_ORIGINS.knaben[1];
  const http = stub({
    [ENGINE_ORIGINS.knaben[0]]: Object.assign(new TypeError("fetch failed"), { name: "TypeError" }),
    [second + "/v1"]: fixture("knaben.json"),
  });
  const rows = await ENGINES.knaben(http, engineQuery("big buck bunny"), settings());
  assert.equal(rows.length, 2);
  assert.equal(http.calls.length, 2, "both addresses were tried");
  assert.equal(LIVENESS.engines.get("knaben").origin, second);
});
