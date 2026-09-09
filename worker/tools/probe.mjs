/**
 * Ask a deployed Worker which indexes still answer it, and take the ones that
 * do not out of the feed.
 *
 *     npm run probe            # ask, and print what it found
 *     npm run probe -- --fix   # ask, and write the answer into the feed
 *
 * Why a deployed Worker and not this machine: the sites treat Cloudflare's
 * address ranges differently from a home connection, and four of the engines
 * in the seed are off for exactly that reason — they answer a browser here and
 * refuse a Worker there. A probe run from a laptop would report all of them
 * healthy and be wrong every time. So the question is put to a Worker, over
 * its own `/api/v1/engines?probe=1`, and the answer is the Worker's: an engine
 * counts as working when the Worker lists it in `usable`.
 *
 * Two rounds, a pause apart. One bad minute at one index should not take it out
 * of everybody's roster, and an engine has to miss both rounds to be recorded
 * as unreachable.
 *
 * What this may and may not do:
 *
 *   - It may turn an engine **off**. That is safe and it undoes itself: the
 *     next run that sees the engine answer twice turns it back on.
 *   - It may not turn an engine on that the *seed* has off. `torrentdownload`
 *     is off because it fabricates results, and it would probe perfectly
 *     green — "Do not enable it", says the descriptor, and nothing automatic
 *     is in a position to disagree. Those are reported and left alone.
 *
 * The result lands in `unreachable.json`, which `feedEngines()` reads. It only
 * ever narrows what the feed enables, so the worst a wrong entry can do is
 * cost coverage until the next run.
 *
 * Credentials come from `PTS_WORKER_URL` and `PTS_WORKER_KEY`, or from a
 * `.probe.local` at the top of the repository, which is not committed. The key
 * is a key: it is never printed, and only the Worker's host is recorded.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { build as buildDocs } from "./build.mjs";
import { UNREACHABLE_PATH, feedEngines, seedEngines, unreachable } from "./feed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const CONFIG_PATH = join(REPO, ".probe.local");

const ROUNDS = 2;
const DEFAULT_GAP_S = 45;
const REQUEST_TIMEOUT_MS = 120 * 1000;

/** Where to ask, and with what. Environment first, then the uncommitted file. */
export function credentials(env = process.env) {
  let url = (env.PTS_WORKER_URL || "").trim();
  let key = (env.PTS_WORKER_KEY || "").trim();
  if ((!url || !key) && existsSync(CONFIG_PATH)) {
    for (const line of readFileSync(CONFIG_PATH, "utf8").split("\n")) {
      const found = /^\s*(PTS_WORKER_URL|PTS_WORKER_KEY)\s*=\s*(.*?)\s*$/.exec(line);
      if (!found) continue;
      if (found[1] === "PTS_WORKER_URL" && !url) url = found[2];
      if (found[1] === "PTS_WORKER_KEY" && !key) key = found[2];
    }
  }
  if (!url || !key) {
    throw new Error(
      "No Worker to ask. Put your URL and key in .probe.local at the top of the repository:\n" +
        "\n    PTS_WORKER_URL=https://your-worker.workers.dev\n    PTS_WORKER_KEY=your-key\n\n" +
        "or set PTS_WORKER_URL and PTS_WORKER_KEY in the environment. The file is not committed.",
    );
  }
  return { url: url.replace(/\/+$/, ""), key };
}

/**
 * One round. Returns the Worker's own verdict: the set it called usable, and a
 * line per engine for the report.
 */
export async function askOnce({ url, key }, fetchImpl = fetch) {
  const response = await fetchImpl(`${url}/api/v1/engines?probe=1`, {
    headers: { "X-API-Key": key, accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    // 401 is the common one and it is worth saying plainly, because the key
    // being wrong looks exactly like every index being down.
    const hint = response.status === 401 || response.status === 403 ? " — is PTS_WORKER_KEY the key this Worker carries?" : "";
    throw new Error(`the Worker answered HTTP ${response.status}${hint}`);
  }
  const body = await response.json();
  if (!Array.isArray(body) || !body.length) throw new Error("the Worker's probe did not answer with a list");
  const [summary, ...rows] = body;
  const usable = new Set(String(summary.usable || "").split(",").filter(Boolean));
  const detail = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== "string") continue;
    detail.set(row.id, { ok: !!row.ok, rows: row.rows || 0, ms: row.ms || 0, error: row.error || "" });
  }
  return { usable, detail };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask twice and decide. `worked` is the engines usable in *every* round;
 * `failed` the ones usable in none. An engine that managed one of the two is
 * in neither, and is left exactly as it is — that is what flapping looks like,
 * and it is not a verdict.
 */
export async function probeWorker(config, { rounds = ROUNDS, gapS = DEFAULT_GAP_S, log = console.log, ask = askOnce } = {}) {
  const seen = [];
  for (let round = 1; round <= rounds; round += 1) {
    if (round > 1 && gapS > 0) {
      log(`  waiting ${gapS}s before round ${round} of ${rounds}`);
      await sleep(gapS * 1000);
    }
    const result = await ask(config);
    log(`  round ${round}: ${result.usable.size} of ${result.detail.size} answered`);
    seen.push(result);
  }
  const names = new Set();
  for (const result of seen) for (const id of result.detail.keys()) names.add(id);
  const worked = new Set();
  const failed = new Set();
  for (const name of names) {
    if (seen.every((result) => result.usable.has(name))) worked.add(name);
    else if (seen.every((result) => !result.usable.has(name))) failed.add(name);
  }
  return { worked, failed, rounds: seen };
}

/**
 * What the probe would change, given the seed and what is already recorded.
 * Pure, so the tests can drive every case without a Worker.
 */
export function decide({ worked, failed }, seed = seedEngines(), recorded = unreachable().engines) {
  const inSeed = new Map(seed.map((engine) => [engine.name, engine]));
  const disable = [];
  const restore = [];
  const suggest = [];
  for (const [name, engine] of inSeed) {
    const isRecorded = Object.prototype.hasOwnProperty.call(recorded, name);
    if (engine.enabled === false && !isRecorded) {
      // Off in the seed by somebody's judgement. Not ours to undo.
      if (worked.has(name)) suggest.push(name);
      continue;
    }
    if (failed.has(name) && !isRecorded) disable.push(name);
    if (worked.has(name) && isRecorded) restore.push(name);
  }
  return { disable, restore, suggest };
}

function table(seed, { worked, failed }, recorded) {
  const width = Math.max(...seed.map((engine) => engine.name.length));
  const lines = [];
  for (const engine of seed) {
    const name = engine.name.padEnd(width);
    const verdict = worked.has(engine.name) ? "answers" : failed.has(engine.name) ? "silent" : "mixed";
    const state = Object.prototype.hasOwnProperty.call(recorded, engine.name)
      ? "off (unreachable)"
      : engine.enabled === false
        ? "off (in the seed)"
        : "on";
    lines.push(`  ${name}  ${verdict.padEnd(8)}  ${state}`);
  }
  return lines.join("\n");
}

export async function run({ fix = false, gapS = DEFAULT_GAP_S, rounds = ROUNDS, log = console.log, now = new Date() } = {}) {
  const config = credentials();
  const host = new URL(config.url).host;
  log(`asking ${host} — ${rounds} rounds`);

  const result = await probeWorker(config, { rounds, gapS, log });
  const seed = seedEngines();
  const before = unreachable();
  log("");
  log(table(seed, result, before.engines));
  log("");

  const { disable, restore, suggest } = decide(result, seed, before.engines);
  for (const name of suggest) {
    log(`note: ${name} answered, but the seed has it off on purpose. Read its descriptor before changing anything.`);
  }
  if (!disable.length && !restore.length) {
    log("nothing to change.");
    return { changed: false, disable, restore, suggest };
  }
  for (const name of disable) log(`down: ${name} missed every round — taking it out of the feed`);
  for (const name of restore) log(`back: ${name} answered every round — putting it back in the feed`);

  if (!fix) {
    log("");
    log("run again with --fix to write it.");
    return { changed: false, disable, restore, suggest };
  }

  const engines = { ...before.engines };
  for (const name of restore) delete engines[name];
  for (const name of disable) {
    const detail = result.rounds[result.rounds.length - 1].detail.get(name) || {};
    engines[name] = { since: now.toISOString().replace(/\.\d{3}Z$/, "Z"), error: detail.error || "no answer" };
  }
  writeFileSync(
    UNREACHABLE_PATH,
    JSON.stringify(
      {
        "//": "Written by `npm run probe -- --fix`: indexes a deployed Worker could not reach, so the feed can stop asking for them. Only ever narrows what the feed enables; an index the seed turns off stays off whatever is here.",
        checked_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
        worker: host,
        engines,
      },
      null,
      2,
    ) + "\n",
  );
  log("");
  await buildDocs({ log });
  return { changed: true, disable, restore, suggest };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const gap = /^--gap=(\d+)$/.exec(args.find((a) => a.startsWith("--gap=")) || "");
  try {
    const outcome = await run({
      fix: args.includes("--fix"),
      rounds: args.includes("--once") ? 1 : ROUNDS,
      gapS: gap ? Number(gap[1]) : DEFAULT_GAP_S,
    });
    // 3 rather than 1: a caller that commits wants to tell "the feed moved"
    // from "the probe could not run".
    process.exit(outcome.changed ? 3 : 0);
  } catch (thrown) {
    console.error(thrown && thrown.message ? thrown.message : thrown);
    process.exit(1);
  }
}
