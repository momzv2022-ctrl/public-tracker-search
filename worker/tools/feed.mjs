/**
 * The engine feed: `docs/feed.json`, built from the descriptors compiled into
 * the Worker.
 *
 *     node worker/tools/feed.mjs build    # validate, replay, write docs/feed.json
 *     node worker/tools/feed.mjs check    # validate and replay only; fail if docs/feed.json is stale
 *
 * There is one source of truth — `SEED_DESCRIPTORS` in `worker/src/worker.js`,
 * where every engine sits next to the reasoning that put it there — and the
 * feed is that list, published. A deployed Worker fetches it hourly, so an
 * edit to the seed reaches every deployment on the next refresh, and a new
 * paste has it compiled in. To repair an engine: edit its descriptor in the
 * Worker, run `npm run build`, commit, push.
 *
 * `build` refuses anything the deployed Worker would reject: every descriptor
 * goes through the Worker's own validator, and every engine that has a
 * recorded fixture is replayed against it and must still yield rows. The feed
 * is not signed; it travels over HTTPS from GitHub Pages, and what guards it
 * is the repository — the same thing that guards the file people paste.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { __testing } from "../src/worker.js";

const { ENGINES, SEED_DESCRIPTORS, descriptorProblem, readFeed } = __testing;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const DOCS = join(REPO, "docs");
const FIXTURES = join(REPO, "worker", "tests", "fixtures");
const FEED_PATH = join(DOCS, "feed.json");
const PAGES_BASE = "https://momzv2022-ctrl.github.io/public-tracker-search/";

/** How long a feed stands before a Worker stops trusting it and falls back to its seed. */
export const EXPIRES_DAYS = 60;

/**
 * The recorded answer each engine is replayed against. An engine without one
 * is validated but not replayed; every engine shipped so far has one.
 */
export const REPLAY_FIXTURES = {
  knaben: "knaben.json",
  piratebay: "piratebay.json",
  torrentscsv: "torrentscsv.json",
  bitsearch: "bitsearch.json",
  torrentdownload: "torrentdownload.html",
  torrentdownloads: "torrentdownloads.xml",
  rutor: "rutor.html",
  torrentkitty: "torrentkitty.html",
  animetosho: "animetosho.json",
  nyaa: "nyaa.xml",
  sukebei: "sukebei.xml",
  dmhy: "dmhy.xml",
  eztvx: "eztvx.json",
  yts: "yts.json",
  archive: "archive.json",
};

function fixtureHttp(body) {
  return {
    async text() {
      return [200, body];
    },
    async bytes() {
      return [404, new Uint8Array()];
    },
  };
}

const replaySettings = () => ({ engineUrls: {}, maxRowsPerEngine: 100, engineTimeoutS: 5, upstreamTimeoutS: 15 });
const replayQuery = { q: "replay", terms: "replay", cat: "", year: "", res: "", minSeeders: 0 };

/** The feed's engines, as data: the seed with nothing added and nothing lost. */
export function feedEngines() {
  return JSON.parse(JSON.stringify(SEED_DESCRIPTORS));
}

/** Validate the seed and replay every engine with a fixture. Throws on the first problem. */
export async function check({ log = console.log } = {}) {
  const engines = feedEngines();
  if (!engines.length) throw new Error("the Worker ships no engines");
  const names = new Set();
  for (const entry of engines) {
    const problem = descriptorProblem(entry);
    if (problem) throw new Error(`${entry.name}: ${problem}`);
    if (names.has(entry.name)) throw new Error(`${entry.name} is defined twice`);
    names.add(entry.name);
  }

  let replayed = 0;
  for (const entry of engines) {
    const fixture = REPLAY_FIXTURES[entry.name];
    if (!fixture) {
      log(`${entry.name}: no fixture, validated only`);
      continue;
    }
    const engine = ENGINES[entry.name];
    if (!engine) throw new Error(`${entry.name} has a fixture but no engine`);
    const body = readFileSync(join(FIXTURES, fixture), "utf8");
    const rows = await engine(fixtureHttp(body), replayQuery, replaySettings());
    if (!rows.length) throw new Error(`${entry.name}: replaying ${fixture} yields no rows`);
    replayed += 1;
    log(`${entry.name}: ${rows.length} rows from ${fixture}`);
  }
  log(`checked ${engines.length} engines (${replayed} replayed against fixtures)`);
  return engines;
}

/** The current published feed, or null. */
export function currentFeed() {
  if (!existsSync(FEED_PATH)) return null;
  try {
    return JSON.parse(readFileSync(FEED_PATH, "utf8"));
  } catch {
    return null;
  }
}

/** True when docs/feed.json carries exactly the seed. */
export function feedIsCurrent() {
  const published = currentFeed();
  return !!published && JSON.stringify(published.engines) === JSON.stringify(feedEngines());
}

const stamp = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

/** The feed text for *engines*, one serial past the published one. */
export function feedText(engines, { now = new Date(), previous = currentFeed() } = {}) {
  const serial = (previous && Number.isSafeInteger(previous.serial) ? previous.serial : 0) + 1;
  const expires = new Date(now.getTime() + EXPIRES_DAYS * 24 * 3600 * 1000);
  return JSON.stringify(
    {
      "//": "The engine feed of public-tracker-search. Built from worker/src/worker.js by `npm run build`; a deployed Worker fetches it hourly. Data only.",
      tgp_version: 1,
      serial,
      issued_at: stamp(now),
      expires_at: stamp(expires),
      moved_to: null,
      mirrors: [`${PAGES_BASE}feed.json`],
      engines,
    },
    null,
    2,
  ) + "\n";
}

/**
 * True when the published feed still has more than half its life ahead of it.
 * A build that changes nothing does not bump the serial — a diff on every
 * build would bury the ones that matter — but a feed in its second half is
 * renewed, so a repository left alone for a while keeps its Workers fed.
 */
export function feedIsFresh(now = Date.now()) {
  const published = currentFeed();
  if (!published) return false;
  const expires = Date.parse(String(published.expires_at || ""));
  return Number.isFinite(expires) && expires - now > (EXPIRES_DAYS / 2) * 24 * 3600 * 1000;
}

export async function build({ log = console.log, now = new Date() } = {}) {
  const engines = await check({ log });
  if (feedIsCurrent() && feedIsFresh(now.getTime())) {
    const kept = currentFeed();
    log(`docs/feed.json unchanged — serial ${kept.serial}, ${engines.length} engines, expires ${kept.expires_at}`);
    return kept;
  }
  const text = feedText(engines, { now });
  // The Worker's own reader is the last word on whether the file is usable.
  const accepted = readFeed(text, now.getTime());
  writeFileSync(FEED_PATH, text);
  log(`wrote docs/feed.json — serial ${accepted.serial}, ${engines.length} engines, expires ${accepted.expires_at}`);
  return accepted;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const command = process.argv[2];
  try {
    if (command === "build") await build();
    else if (command === "check") {
      await check();
      if (!feedIsCurrent()) {
        console.error("docs/feed.json does not match the seed in worker/src/worker.js — run `npm run build`");
        process.exit(1);
      }
      console.log("docs/feed.json is current");
    } else {
      console.error("usage: node worker/tools/feed.mjs <build|check>");
      process.exit(2);
    }
  } catch (thrown) {
    console.error(thrown && thrown.message ? thrown.message : thrown);
    process.exit(1);
  }
}
