/**
 * The engines this fork added, and the machinery they needed: search pages
 * read with selectors, feed attributes, relative links, hashes inside links,
 * the byte cap, the `.torrent` resolver for the Archive, and `/api/v1/try`.
 *
 * Offline, like everything else here. Each fixture is what the site actually
 * sent (`bitsearch.json`, `sukebei.xml`, `archive.json`, `torrentdownloads.xml`,
 * `dmhy.xml`) or a page rebuilt to the exact structure observed on the site
 * (`rutor.html`, `torrentkitty.html`, `torrentdownload.html`) — the row
 * classes, the cell order, the link shapes — since a search page cannot be
 * saved verbatim without saving its adverts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { __testing } from "../src/worker.js";

const {
  ENGINES,
  LIVENESS,
  SEED_DESCRIPTORS,
  compileSelector,
  descriptorProblem,
  handle,
  htmlRows,
  humanSize,
  infohashFromText,
  intOrNone,
  originsFor,
  readSettings,
  search,
  selectorProblem,
  tryDescriptor,
} = __testing;

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(HERE, "fixtures", name), "utf8");
const KEY = "k".repeat(32);
const seed = (name) => SEED_DESCRIPTORS.find((d) => d.name === name);

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
  };
  return client;
}

const settings = (overrides = {}) => ({ ...readSettings({ UTSI_API_KEY: KEY }), ...overrides });
const query = (terms) => ({ q: terms, terms, cat: "", year: "", res: "", minSeeders: 0, sort: "", limit: 50, offset: 0 });

// ───────────────────────────────────────────────────────────────────────────
// Small tools
// ───────────────────────────────────────────────────────────────────────────

test("integers with thousands separators, sizes glued to their unit, hashes inside links", () => {
  assert.equal(intOrNone("4,341"), 4341);
  assert.equal(intOrNone("4 341"), 4341);
  assert.equal(intOrNone("4 341"), 4341);
  assert.equal(intOrNone("4.341"), null, "a dot is not a thousands separator anywhere this reads");
  assert.equal(intOrNone("12"), 12);
  assert.equal(intOrNone("1,2"), null);

  assert.equal(humanSize("1.53GB"), 1530000000);
  assert.equal(humanSize("697.57 MB"), 697570000);
  assert.equal(humanSize("223.04 kb"), 223040);
  assert.equal(humanSize("1.4 GiB"), Math.trunc(1.4 * 1024 ** 3));
  assert.equal(humanSize("1,024 MB"), 1024000000);
  assert.equal(humanSize("GB"), null);
  assert.equal(humanSize("12"), null, "a bare number is not a human size");

  assert.equal(
    infohashFromText("https://www.torrentkitty.tv/information/A1425E0D6630336CDD9FB320F3FFF1030098975A"),
    "a1425e0d6630336cdd9fb320f3fff1030098975a",
  );
  assert.equal(infohashFromText("/232cd67eb3ffbd7c37bf9ec3ee887417e5ae1ee6/Ubuntu-Linux-Bible"), "232cd67eb3ffbd7c37bf9ec3ee887417e5ae1ee6");
  assert.equal(infohashFromText("a".repeat(64)), null, "a SHA-256 is not an infohash");
  assert.equal(infohashFromText("x" + "a".repeat(40)), null, "delimited on both sides");
  assert.equal(infohashFromText(""), null);
});

// ───────────────────────────────────────────────────────────────────────────
// Selectors and the HTML scanner
// ───────────────────────────────────────────────────────────────────────────

test("the selector subset compiles, and what is outside it is refused by name", () => {
  for (const good of [
    "tr", "tr.gai", "div#index tr.gai, div#index tr.tum", "td:nth-child(2) a", "a[href^='magnet:']",
    'a[href$=".torrent"]', "a[href*=torrent]", "a[rel~=nofollow]", "td > a", "tr:first-child", "td:nth-of-type(3)",
    "a:not(.downgif)", "*", "td.a.b#c[x][y=z]",
  ]) {
    assert.equal(selectorProblem(good), "", good);
  }
  for (const [bad, why] of [
    ["", /empty/],
    ["tr:last-child", /bad selector/],
    ["tr ~ td", /bad selector/],
    ["td:contains(x)", /bad selector/],
    ["a >", /bad selector/],
    ["td:nth-child(2n+1)", /bad selector/],
    ["x".repeat(200), /too long/],
  ]) {
    assert.match(selectorProblem(bad), why, bad);
  }
  assert.equal(compileSelector("td:nth-child(2) a").length, 1);
  assert.equal(compileSelector("a, b, c").length, 3);
});

test("rows come out of a page: implied end tags, nested tables, entities, scripts and comments", () => {
  const html = `<!doctype html><html><body>
<!-- <tr class="row"><td>a comment is not a row</td></tr> -->
<script>document.write("<tr class='row'><td>nor is a script</td></tr>")</script>
<table id="t">
<tr class="head"><th>Name<th>Size<th>Seeds
<tr class="row"><td>First &amp; <b>bold</b> name<td>1.5 GB<td><span class=s>4,000</span>
<tr class="row"><td><a href="/x/1">Second</a> <table><tr><td>nested cell</td></tr></table><td>2 GB<td><span class="s">7</span>
<tr class="row"><td>Third<td>3 GB<td><span class="s">1</span>
</table></body></html>`;
  const rows = htmlRows(html, compileSelector("table#t tr.row"), {
    name: { compiled: compileSelector("td:nth-child(1)") },
    link: { compiled: compileSelector("a"), attr: "href" },
    seeds: { compiled: compileSelector("span.s") },
  }, 10);

  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].cells, ["First & bold name", "1.5 GB", "4,000"]);
  assert.equal(rows[0].fields.name, "First & bold name", "descendant text, entities decoded");
  assert.equal(rows[0].fields.link, null, "no link, no value");
  assert.equal(rows[0].fields.seeds, "4,000");
  assert.equal(rows[1].fields.link, "/x/1");
  assert.equal(rows[1].cells.length, 3, "a nested table's cells are not this row's cells");
  assert.equal(rows[1].cells[0], "Second nested cell", "but its text is still inside the outer cell");
  assert.equal(rows[2].fields.name, "Third");

  // The cap stops the scan early.
  assert.equal(htmlRows(html, compileSelector("tr.row"), {}, 2).length, 2);
});

test("selectors match what a browser would: classes, attributes, positions, :not, child vs descendant", () => {
  const html = `<div id="a"><ul><li class="x y" data-k="v w">one</li><li class="x" data-k="value">two</li><li>three</li></ul>
<p><span>not in a list</span></p><section><ul><li>deep</li></ul></section></div>`;
  const pick = (rowSelector) => htmlRows(html, compileSelector(rowSelector), {}, 20).length;
  assert.equal(pick("li"), 4);
  assert.equal(pick("li.x"), 2);
  assert.equal(pick("li.x.y"), 1);
  assert.equal(pick("li[data-k]"), 2);
  assert.equal(pick('li[data-k="value"]'), 1);
  assert.equal(pick("li[data-k^=val]"), 1);
  assert.equal(pick("li[data-k$=w]"), 1);
  assert.equal(pick("li[data-k*=alu]"), 1);
  assert.equal(pick("li[data-k~=w]"), 1);
  assert.equal(pick("li:first-child"), 2);
  assert.equal(pick("li:nth-child(3)"), 1);
  assert.equal(pick("li:not(.x)"), 2);
  assert.equal(pick("div#a > ul > li"), 3, "child combinator stops at the section");
  assert.equal(pick("div#a li"), 4, "descendant combinator does not");
  assert.equal(pick("section li"), 1);
  assert.equal(pick("ul:nth-of-type(1) > li:first-child"), 2);
  assert.equal(pick("span"), 1);
});

// ───────────────────────────────────────────────────────────────────────────
// The engines
// ───────────────────────────────────────────────────────────────────────────

test("bitsearch reads the API, keeps the hash, and only dates rows the index dated", async () => {
  const rows = await ENGINES.bitsearch(stub({ "https://bitsearch.eu/api/v1/search": fixture("bitsearch.json") }), query("ubuntu"), settings());
  assert.equal(rows.length, 3);
  assert.equal(rows[0].infohash, "611f70899d4e1d6a9c39cfc925f103dfef630328");
  assert.equal(rows[0].name, "ubuntu-24.04.2-desktop-amd64.iso");
  assert.equal(rows[0].sizeBytes, 6343219200);
  assert.equal(rows[0].seeders, 165);
  assert.equal(rows[0].leechers, 311);
  assert.equal(rows[0].firstSeen, null, "updatedAt is the last scrape, not a date");
  assert.equal(rows[1].firstSeen, "2025-07-22T15:10:01.567Z");
  assert.equal(rows[0].descriptionUrl, "https://bitsearch.eu/torrent/68131baea48761f7a5a37bd9");
});

test("torrentdownloads' RSS carries the hash, and its relative link is made absolute", async () => {
  const http = stub({ "https://www.torrentdownloads.pro/rss.xml": fixture("torrentdownloads.xml") });
  const rows = await ENGINES.torrentdownloads(http, query("ubuntu"), settings());
  const asked = new URL(http.calls[0].url);
  assert.equal(asked.searchParams.get("type"), "search");
  assert.equal(asked.searchParams.get("search"), "ubuntu");
  assert.equal(rows.length, 2, "the item with an empty info_hash is not a torrent");
  assert.equal(rows[0].infohash, "19987310611f0fae3b2c9678601b92967d938aff");
  assert.equal(rows[0].sizeBytes, 24898149);
  assert.equal(rows[0].seeders, 978);
  assert.equal(rows[0].leechers, 30);
  assert.equal(rows[0].firstSeen, "2013-10-21T13:20:49+02:00");
  assert.equal(rows[0].descriptionUrl, "https://www.torrentdownloads.pro/torrent/1656525368/Ubuntu-12-10-Server-64-Bit");
  assert.equal(rows[1].descriptionUrl, "https://www.torrentdownloads.pro/torrent/1705747268/Ubuntu-Linux-Bible-11E-by-David-Clinton-%28epub%29%28Nonfiction%29-epub");
});

test("dmhy's magnet is an enclosure attribute in base32, and the body is capped", async () => {
  const http = stub({ "https://share.dmhy.org/topics/rss/rss.xml": fixture("dmhy.xml") });
  const rows = await ENGINES.dmhy(http, query("naruto"), settings());
  assert.equal(http.calls[0].limitBytes, 262144, "a feed that does not page is read in part");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "博人传.阿拉伯字幕文件.Boruto Naruto Next Generations [1 - 293] Arabic Subtitles");
  assert.equal(rows[0].infohash, "52794c19b602fbc975355cb9d87e6b6b5035cf68", "base32, decoded");
  assert.equal(rows[0].firstSeen, "2026-05-14T07:34:26+08:00");
  assert.equal(rows[0].descriptionUrl, "http://share.dmhy.org/topics/view/718878_Boruto_Naruto_Next_Generations_1_-_293_Arabic_Subtitles.html");
  assert.equal(rows[1].infohash, "0123456789abcdef0123456789abcdef01234567");
});

test("sukebei is nyaa's software with its own namespace", async () => {
  const rows = await ENGINES.sukebei(stub({ "https://sukebei.nyaa.si/?page=rss": fixture("sukebei.xml") }), query("test"), settings());
  assert.ok(rows.length >= 3);
  for (const row of rows) {
    assert.match(row.infohash, /^[0-9a-f]{40}$/);
    assert.equal(typeof row.seeders, "number");
    assert.ok(row.sizeBytes > 0);
    assert.match(row.torrentUrl, /^https:\/\/sukebei\.nyaa\.si\/download\//);
  }
});

test("rutor: magnets on the listing, sizes second from the end, comments or not", async () => {
  LIVENESS.engines.clear();
  const http = stub({ "https://rutor.info/search/": fixture("rutor.html") });
  const rows = await ENGINES.rutor(http, query("ubuntu"), settings());
  assert.equal(http.calls[0].url, "https://rutor.info/search/0/0/100/0/ubuntu");
  assert.equal(http.calls[0].accept, "text/html, */*");

  assert.equal(rows.length, 3, "the header row falls out; the row without a magnet keeps its .torrent link for the resolver");
  assert.equal(rows[2].infohash, null);
  assert.equal(rows[2].torrentUrl, "https://d.rutor.info/download/1");
  assert.equal(rows[0].name, "Ubuntu*Pack 24.04.1 [amd64] [июль] (2026) PC");
  assert.equal(rows[0].infohash, "abcdef0123456789abcdef0123456789abcdef01");
  assert.equal(rows[0].sizeBytes, 4390000000);
  assert.equal(rows[0].seeders, 12);
  assert.equal(rows[0].leechers, 3);
  assert.equal(rows[0].torrentUrl, "https://d.rutor.info/download/1099896", "a protocol-relative link, made absolute");
  assert.equal(rows[0].descriptionUrl, "https://rutor.info/torrent/1099896/ubuntu_pack-24.04.1-amd64-2026");
  assert.equal(rows[0].firstSeen, null, "a Russian date is left absent, not guessed");

  // The second row has a comments cell between the name and the size.
  assert.equal(rows[1].name, "Ubuntu Server 24.04 Live & Desktop (2026) PC", "entities decoded");
  assert.equal(rows[1].sizeBytes, 1190000000, "cell -2 is the size whatever the column count");
  assert.equal(rows[1].seeders, 5);
  assert.equal(rows[1].leechers, 0, "a swarm of nought is a fact, kept");
});

test("torrentkitty: a DHT listing with a magnet and a date on every row", async () => {
  const http = stub({ "https://www.torrentkitty.tv/search/": fixture("torrentkitty.html") });
  const rows = await ENGINES.torrentkitty(http, query("ubuntu"), settings());
  assert.equal(http.calls[0].url, "https://www.torrentkitty.tv/search/ubuntu/");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "ubuntu-26.04-live-server-amd64.iso");
  assert.equal(rows[0].infohash, "a1425e0d6630336cdd9fb320f3fff1030098975a");
  assert.equal(rows[0].sizeBytes, 223040);
  assert.equal(rows[0].firstSeen, "2026-07-20");
  assert.equal(rows[0].seeders, null, "no swarm on a DHT index — omitted, never zero");
  assert.equal(rows[0].descriptionUrl, "https://www.torrentkitty.tv/information/A1425E0D6630336CDD9FB320F3FFF1030098975A");
  assert.equal(rows[1].name, "Ubuntu 22.04 & friends");
});

test("torrentdownload: the hash is in the link, the swarm has thousands separators", async () => {
  const http = stub({ "https://www.torrentdownload.info/search": fixture("torrentdownload.html") });
  const rows = await ENGINES.torrentdownload(http, query("ubuntu"), settings());
  assert.equal(new URL(http.calls[0].url).searchParams.get("q"), "ubuntu");
  assert.equal(rows.length, 2, "the header row has no link and falls out");
  assert.equal(rows[0].name, "Ubuntu 10 04 LTS x64", "the highlighted span is part of the name");
  assert.equal(rows[0].infohash, "a1425e0d6630336cdd9fb320f3fff1030098975a");
  assert.equal(rows[0].sizeBytes, 697570000);
  assert.equal(rows[0].seeders, 4341);
  assert.equal(rows[0].leechers, 2956);
  assert.equal(rows[0].descriptionUrl, "https://www.torrentdownload.info/A1425E0D6630336CDD9FB320F3FFF1030098975A/Ubuntu-10-04-LTS-x64");
  assert.equal(rows[1].infohash, "232cd67eb3ffbd7c37bf9ec3ee887417e5ae1ee6");
});

test("a bot challenge served as HTTP 200 is a dead address, not an empty page", async () => {
  LIVENESS.engines.clear();
  const challenge = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>";
  const http = stub({
    "https://rutor.info/": challenge,
    "https://rutor.is/search/": fixture("rutor.html"),
  });
  const rows = await ENGINES.rutor(http, query("ubuntu"), settings());
  assert.equal(rows.length, 3, "the second address answered");
  assert.equal(http.calls.length, 2);
  assert.equal(LIVENESS.engines.get("rutor").origin, "https://rutor.is");

  await assert.rejects(
    () => ENGINES.torrentkitty(stub({ "https://www.torrentkitty.tv/": challenge }), query("x"), settings()),
    /bot challenge/,
  );
  await assert.rejects(
    () => ENGINES.torrentkitty(stub({ "https://www.torrentkitty.tv/": "{}" }), query("x"), settings()),
    /not HTML/,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// The Archive and the resolver
// ───────────────────────────────────────────────────────────────────────────

function bencode(value) {
  if (typeof value === "number") return `i${value}e`;
  if (typeof value === "string") return `${Buffer.byteLength(value)}:${value}`;
  if (Array.isArray(value)) return `l${value.map(bencode).join("")}e`;
  const keys = Object.keys(value).sort();
  return `d${keys.map((key) => bencode(key) + bencode(value[key])).join("")}e`;
}

test("archive rows arrive without a hash and are resolved from the .torrent, within the cap", async () => {
  const descriptor = seed("archive");
  const http = stub({ "https://archive.org/advancedsearch.php": fixture("archive.json") });
  const rows = await ENGINES.archive(http, query("big buck bunny"), settings());
  const asked = new URL(http.calls[0].url);
  assert.equal(asked.searchParams.get("q"), "big buck bunny");
  assert.equal(asked.searchParams.get("fl[]"), "identifier,title,item_size,publicdate");
  assert.equal(asked.searchParams.get("output"), "json");
  assert.equal(asked.searchParams.get("rows"), "20", "limit_cap");
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.infohash, null);
    assert.match(row.torrentUrl, /^https:\/\/archive\.org\/download\/[^/]+\/[^/]+_archive\.torrent$/);
  }
  assert.equal(rows[2].torrentUrl, "https://archive.org/download/dvd_20250906/dvd_20250906_archive.torrent");
  assert.equal(rows[2].descriptionUrl, "https://archive.org/details/dvd_20250906");
  assert.equal(rows[2].sizeBytes, 1359502853);
  assert.equal(rows[2].firstSeen, "2025-09-06T16:24:51Z");
  assert.equal(descriptor.breadth, "narrow");

  // Through the whole search: the query gate keeps the film and drops the
  // radio show, the resolver reads the hash out of the file, and the row
  // reaches the client with a magnet.
  const torrent = Buffer.from(bencode({
    announce: "https://archive.org/announce",
    info: { name: "HOMEMADE BIG BUCK BUNNY DISC", "piece length": 262144, pieces: "", length: 1359502853 },
  }));
  const full = stub({
    "https://archive.org/advancedsearch.php": fixture("archive.json"),
    "https://archive.org/download/dvd_20250906/": torrent,
    "https://archive.org/download/bbb2d_lossless": torrent,
  });
  const reply = await search(query("big buck bunny"), full, settings({ engines: ["archive"] }));
  assert.equal(reply.status, 200);
  const names = reply.body.torrents.map((t) => t.name);
  assert.ok(names.includes("HOMEMADE BIG BUCK BUNNY DISC"), JSON.stringify(names));
  assert.ok(!names.some((n) => /VOA/.test(n)), "the row that answers none of the query is gone before any fetch");
  const fetched = full.calls.filter((call) => call.url.includes("/download/"));
  assert.equal(fetched.length, 1, "only the row that passed the gate cost a fetch");
  assert.match(reply.body.torrents[0].magnet, /^magnet:\?xt=urn:btih:[0-9a-f]{40}/);
  assert.equal(reply.body.torrents[0].torrent_url, "https://archive.org/download/dvd_20250906/dvd_20250906_archive.torrent");

  // A page already full of rows with their hash does not wait on a `.torrent`:
  // three Archive rows behind eight hashed rows, limit 5, no fetch.
  const busy = stub({
    "https://archive.org/advancedsearch.php": fixture("archive.json"),
    "https://api.knaben.org/v1": fixture("knaben.json"),
    "https://apibay.org/q.php": fixture("piratebay.json"),
    "https://torrents-csv.com/service/search": fixture("torrentscsv.json"),
    "https://archive.org/download/": torrent,
  });
  const fullPage = await search(
    { ...query("big buck bunny"), limit: 5 },
    busy,
    settings({ engines: ["knaben", "piratebay", "torrentscsv", "archive"], queryMatch: "off" }),
  );
  assert.ok(fullPage.body.count >= 5);
  assert.equal(busy.calls.filter((call) => call.url.includes("/download/")).length, 0, "no .torrent fetched for a full page");
  assert.equal(settings().resolveTimeoutS, 2);

  // With the resolver off the rows are dropped rather than sent without a magnet.
  const off = await search(query("big buck bunny"), stub({ "https://archive.org/advancedsearch.php": fixture("archive.json") }), settings({ engines: ["archive"], maxResolve: 0 }));
  assert.equal(off.body.torrents.length, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// All of them at once
// ───────────────────────────────────────────────────────────────────────────

const ALL = () => stub({
  "https://api.knaben.org/v1": fixture("knaben.json"),
  "https://apibay.org/q.php": fixture("piratebay.json"),
  "https://torrents-csv.com/service/search": fixture("torrentscsv.json"),
  "https://bitsearch.eu/api/v1/search": fixture("bitsearch.json"),
  "https://www.torrentdownload.info/search": fixture("torrentdownload.html"),
  "https://www.torrentdownloads.pro/rss.xml": fixture("torrentdownloads.xml"),
  "https://rutor.info/search/": fixture("rutor.html"),
  "https://www.torrentkitty.tv/search/": fixture("torrentkitty.html"),
  "https://yts.gg/api/v2/list_movies.json": fixture("yts.json"),
  "https://eztvx.to/api/get-torrents": fixture("eztvx.json"),
  "https://feed.animetosho.org/json": fixture("animetosho.json"),
  "https://nyaa.si/?page=rss": fixture("nyaa.xml"),
  "https://sukebei.nyaa.si/?page=rss": fixture("sukebei.xml"),
  "https://share.dmhy.org/topics/rss/rss.xml": fixture("dmhy.xml"),
  "https://archive.org/advancedsearch.php": fixture("archive.json"),
});

/** Every seed engine by name, the ones off by default included. */
const EVERY_ENGINE = SEED_DESCRIPTORS.map((d) => d.name);

test("every shipped engine runs in one search, off one query, with no credential sent anywhere", async () => {
  LIVENESS.engines.clear();
  const http = ALL();
  const config = settings({ queryMatch: "off", engines: EVERY_ENGINE });
  const reply = await search(query("ubuntu"), http, config);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.engines.slice().sort(), config.engines.slice().sort(), JSON.stringify(reply.body.engine_errors || {}));
  assert.ok(reply.body.torrents.length > 20);
  for (const call of http.calls) {
    for (const header of Object.keys(call.headers || {})) {
      assert.ok(!/^(authorization|x-api-key|cookie)$/i.test(header), `${header} sent to ${call.url}`);
    }
    assert.match(call.url, /^https:\/\//);
  }
  // One subrequest per engine, plus at most `maxResolve` `.torrent` fetches for
  // the rows that arrived without a hash — well inside the free plan's fifty.
  const resolves = http.calls.filter((call) => /\.torrent$|\/download\//.test(call.url));
  assert.equal(http.calls.length - resolves.length, config.engines.length);
  assert.ok(resolves.length <= config.maxResolve, `${resolves.length} .torrent fetches`);
  // Provenance survives the merge: rows say which index had them.
  const sources = new Set(reply.body.torrents.flatMap((t) => t.sources || []));
  for (const engine of ["rutor", "torrentkitty", "bitsearch", "torrentdownload", "torrentdownloads", "dmhy"]) {
    assert.ok(sources.has(engine), `${engine} contributed no row`);
  }
});

test("healthz after that search says every engine answered, and how many rows each kept", async () => {
  const config = settings({ queryMatch: "off", engines: EVERY_ENGINE });
  await search(query("ubuntu"), ALL(), config);
  const health = await handle("GET", "https://w.dev/healthz", new Headers(), stub({}), config);
  assert.equal(health.body.status, "ok");
  assert.equal(health.body.coverage, "broad");
  for (const engine of config.engines) {
    const entry = health.body.engine_status[engine];
    assert.equal(entry.last, "ok", `${engine}: ${JSON.stringify(entry)}`);
  }
  assert.equal(health.body.engine_status.rutor.rows_seen, 3, "rutor's header row has its own class and is never a row");
  assert.equal(health.body.engine_status.rutor.rows_emitted, 3);
  assert.equal(health.body.engine_status.torrentkitty.rows_seen, 3, "torrentkitty's header row matches, is seen, and yields nothing");
  assert.equal(health.body.engine_status.torrentkitty.rows_emitted, 2);
  assert.equal(health.body.engine_status.torrentkitty.drop_ratio, 0.33);
});

// ───────────────────────────────────────────────────────────────────────────
// /api/v1/try
// ───────────────────────────────────────────────────────────────────────────

test("/api/v1/try runs one descriptor live and shows its rows or its complaint", async () => {
  const config = settings();
  const descriptor = { ...seed("torrentkitty"), name: "kitty-test", origins: ["https://kitty.test"] };
  const http = stub({ "https://kitty.test/search/": fixture("torrentkitty.html") });
  const params = new URLSearchParams({ d: JSON.stringify(descriptor), q: "ubuntu" });

  const answer = await tryDescriptor(params, http, config);
  assert.equal(answer.descriptor, "kitty-test");
  assert.equal(answer.kind, "html");
  assert.equal(answer.rows.length, 2);
  assert.equal(answer.rows[0].infohash, "a1425e0d6630336cdd9fb320f3fff1030098975a");
  assert.deepEqual(answer.stats, { seen: 3, emitted: 2 });
  assert.equal(typeof answer.ms, "number");

  const broken = await tryDescriptor(new URLSearchParams({ d: JSON.stringify({ ...descriptor, rows: "tr:last-child" }) }), http, config);
  assert.match(broken.error, /invalid descriptor: rows: bad selector/);
  const dead = await tryDescriptor(params, stub({}), config);
  assert.match(dead.error, /HTTP 404/);
  assert.match((await tryDescriptor(new URLSearchParams({ d: "nope" }), http, config)).error, /JSON/);

  // A try that borrows a shipped engine's name still runs its own addresses —
  // that is how a new address for a known engine is tested before the feed
  // carries it — while the engine itself keeps the list it shipped with.
  const renamed = { ...seed("torrentkitty"), origins: ["https://kitty.test"] };
  const borrowed = await tryDescriptor(new URLSearchParams({ d: JSON.stringify(renamed), q: "ubuntu" }), http, config);
  assert.equal(borrowed.rows.length, 2, JSON.stringify(borrowed));
  assert.deepEqual(originsFor("torrentkitty", config).map((o) => o.url), seed("torrentkitty").origins);

  // Through the router: the key is required, like every route that fetches.
  const refused = await handle("GET", `https://w.dev/api/v1/try?${params}`, new Headers(), http, config);
  assert.equal(refused.status, 401);
  const allowed = await handle("GET", `https://w.dev/api/v1/try?${params}`, new Headers({ "x-api-key": KEY }), http, config);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.rows.length, 2);
});

// ───────────────────────────────────────────────────────────────────────────
// The schema, for the new forms
// ───────────────────────────────────────────────────────────────────────────

test("the validator knows html descriptors, @attributes, absolute links, byte caps and two-hole templates", () => {
  const html = seed("rutor");
  assert.equal(descriptorProblem(html), "");
  assert.match(descriptorProblem({ ...html, rows: "tr ~ td" }), /rows: bad selector/);
  assert.match(descriptorProblem({ ...html, fields: { ...html.fields, name: "title" } }), /name: html fields are/);
  assert.match(descriptorProblem({ ...html, fields: { ...html.fields, name: { selector: "a", cell: 1 } } }), /not both/);
  assert.match(descriptorProblem({ ...html, fields: { ...html.fields, size_bytes: { cell: 0 } } }), /cell must be/);
  assert.match(descriptorProblem({ ...html, fields: { ...html.fields, size_bytes: { cell: 40 } } }), /cell must be/);
  assert.match(descriptorProblem({ ...html, fields: { ...html.fields, name: { selector: "a", attr: "bad attr" } } }), /bad attr/);
  assert.match(descriptorProblem({ ...html, fields: { ...html.fields, name: { selector: "a", absolute: true } } }), /absolute only/);
  assert.match(descriptorProblem({ ...html, request: { method: "POST", path: "/x" } }), /GET only/);
  assert.match(descriptorProblem({ ...html, request: { path: "/x", max_bytes: 10 } }), /max_bytes/);
  assert.match(descriptorProblem({ ...html, provenance: "x" }), /provenance/);

  const rss = seed("dmhy");
  assert.equal(descriptorProblem(rss), "");
  assert.match(descriptorProblem({ ...rss, fields: { ...rss.fields, infohash: "a@b@c" } }), /one @attribute/);
  assert.match(descriptorProblem({ ...rss, fields: { ...rss.fields, name: { selector: "td" } } }), /for html engines/);

  const json = seed("archive");
  assert.equal(descriptorProblem(json), "");
  assert.match(
    descriptorProblem({ ...json, fields: { ...json.fields, torrent_url: { template: "https://a/{value}/{value}/{value}", from: "identifier" } } }),
    /one or two/,
  );
  assert.equal(descriptorProblem({ ...json, request: { ...json.request, query: { "fl[]": "x", "sort[]": "y" } } }), "");
  assert.match(descriptorProblem({ ...json, request: { ...json.request, query: { "fl[": "x" } } }), /query key/);
  assert.match(
    descriptorProblem({ ...json, fields: { ...json.fields, description_url: { from: "x", absolute: true, template: "https://a/{value}" } } }),
    /do not combine/,
  );
  assert.match(descriptorProblem({ ...json, fields: { ...json.fields, name: { from: "x", absolute: true } } }), /absolute only/);
});
