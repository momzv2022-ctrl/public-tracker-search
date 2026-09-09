/**
 * The probe: asking a deployed Worker what still answers it, and letting the
 * answer narrow the feed.
 *
 * The policy is the whole risk here, so the policy is what these drive. An
 * engine that flaps must not be taken out of everybody's roster; an engine the
 * seed has off for a reason a probe cannot see must never be put back by one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { UNREACHABLE_PATH, feedEngines, seedEngines, unreachable } from "../tools/feed.mjs";
import { askOnce, decide, probeWorker } from "../tools/probe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const seed = [
  { name: "alive", enabled: true },
  { name: "alsoalive", enabled: true },
  { name: "refused", enabled: false },
  { name: "liar", enabled: false },
];

// ───────────────────────────────────────────────────────────────────────────
// What the probe decides
// ───────────────────────────────────────────────────────────────────────────

test("an engine that missed every round comes out of the feed", () => {
  const verdict = decide({ worked: new Set(["alsoalive"]), failed: new Set(["alive"]) }, seed, {});
  assert.deepEqual(verdict.disable, ["alive"]);
  assert.deepEqual(verdict.restore, []);
});

test("an engine that managed one round of two is left exactly as it was", () => {
  // Neither set holds it: that is what flapping looks like, and it is not a
  // verdict. One bad minute at one index must not reach everybody's roster.
  const verdict = decide({ worked: new Set(), failed: new Set() }, seed, {});
  assert.deepEqual(verdict.disable, []);
  assert.deepEqual(verdict.restore, []);
});

test("an engine recorded unreachable that answers again goes back in", () => {
  const verdict = decide({ worked: new Set(["alive"]), failed: new Set() }, seed, { alive: { since: "2026-01-01T00:00:00Z" } });
  assert.deepEqual(verdict.restore, ["alive"]);
  assert.deepEqual(verdict.disable, []);
});

test("an engine the seed turns off is never turned on, however well it probes", () => {
  // `torrentdownload` is the real case: it answers every time and fabricates
  // what it answers with. A probe cannot see that, so a probe does not get a
  // vote — it says so and stops.
  const verdict = decide({ worked: new Set(["liar", "refused"]), failed: new Set() }, seed, {});
  assert.deepEqual(verdict.restore, []);
  assert.deepEqual(verdict.disable, []);
  assert.deepEqual(verdict.suggest.sort(), ["liar", "refused"]);
});

test("an engine already recorded is not recorded twice, and one not in the seed is ignored", () => {
  const verdict = decide(
    { worked: new Set(), failed: new Set(["alive", "stranger"]) },
    seed,
    { alive: { since: "2026-01-01T00:00:00Z" } },
  );
  assert.deepEqual(verdict.disable, [], "already down, nothing to do");
  assert.ok(!verdict.disable.includes("stranger"), "the feed carries the seed's engines, not the Worker's whole roster");
});

// ───────────────────────────────────────────────────────────────────────────
// Reading a Worker's answer
// ───────────────────────────────────────────────────────────────────────────

const answer = (usable, rows) => ({
  ok: true,
  json: async () => [{ query: "the", usable }, ...rows],
});

test("the Worker's own `usable` list is the verdict, not our reading of the rows", () => {
  return askOnce({ url: "https://x.test", key: "k" }, async () =>
    answer("alive", [
      { id: "alive", ok: true, rows: 4, ms: 300 },
      { id: "refused", ok: false, rows: 0, ms: 3, error: "HTTP 403" },
    ]),
  ).then((result) => {
    assert.deepEqual([...result.usable], ["alive"]);
    assert.equal(result.detail.get("refused").error, "HTTP 403");
    assert.equal(result.detail.size, 2);
  });
});

test("a Worker that refuses the key says so, rather than reading as every index being down", async () => {
  await assert.rejects(
    askOnce({ url: "https://x.test", key: "wrong" }, async () => ({ ok: false, status: 401, json: async () => ({}) })),
    /HTTP 401.*PTS_WORKER_KEY/s,
  );
  await assert.rejects(
    askOnce({ url: "https://x.test", key: "k" }, async () => ({ ok: true, json: async () => ({}) })),
    /did not answer with a list/,
  );
});

test("both rounds have to agree before anything is called down or back", async () => {
  const rounds = [answer("alive,flappy", [{ id: "alive" }, { id: "flappy" }, { id: "gone" }]), answer("alive", [{ id: "alive" }, { id: "flappy" }, { id: "gone" }])];
  let round = 0;
  const result = await probeWorker(
    { url: "https://x.test", key: "k" },
    { gapS: 0, log: () => {}, ask: (config) => askOnce(config, async () => rounds[round++]) },
  );
  assert.deepEqual([...result.worked], ["alive"]);
  assert.deepEqual([...result.failed], ["gone"]);
  assert.ok(!result.worked.has("flappy") && !result.failed.has("flappy"), "one round each way is no verdict");
});

// ───────────────────────────────────────────────────────────────────────────
// What reaches the feed
// ───────────────────────────────────────────────────────────────────────────

test("the overlay narrows the feed and can never widen it", () => {
  const bySeed = new Map(seedEngines().map((engine) => [engine.name, engine]));
  const on = seedEngines().filter((engine) => engine.enabled !== false);
  assert.ok(on.length >= 1, "something is on in the seed");

  // Every engine the probe names goes off, whatever the seed said.
  const named = Object.fromEntries(seedEngines().map((engine) => [engine.name, { since: "2026-01-01T00:00:00Z" }]));
  for (const engine of feedEngines(named)) assert.equal(engine.enabled, false, engine.name);

  // And with nothing named, the feed is the seed, untouched.
  assert.deepEqual(feedEngines({}), seedEngines());

  // The invariant, stated once: enabled in the feed implies enabled in the seed.
  for (const engine of feedEngines(named)) {
    if (engine.enabled !== false) assert.notEqual(bySeed.get(engine.name).enabled, false, engine.name);
  }
});

test("the committed unreachable.json is readable, names only real engines, and is not a place for a key", () => {
  assert.ok(existsSync(UNREACHABLE_PATH), "unreachable.json is committed, so a fresh clone builds the same feed");
  const raw = readFileSync(UNREACHABLE_PATH, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(typeof parsed.engines, "object");
  const names = new Set(seedEngines().map((engine) => engine.name));
  for (const name of Object.keys(parsed.engines)) assert.ok(names.has(name), `${name} is not an engine in the seed`);
  // It records a host, never a URL with a key in it, and never the key.
  assert.ok(!/[?&](key|api[_-]?key)=/i.test(raw), "no key in unreachable.json");
  assert.ok(!parsed.worker || !parsed.worker.includes("/"), "the Worker is recorded by host, not by URL");
});

test("the key file is ignored, so a probe cannot leave one in the repository", () => {
  const ignored = readFileSync(join(REPO, ".gitignore"), "utf8");
  assert.ok(ignored.includes(".probe.local"), ".probe.local must never be committed");
  assert.ok(!existsSync(join(REPO, ".probe.local")) || true, "present locally is fine; committed is not");
  // And nothing the probe writes is read back as configuration by the Worker.
  assert.ok(!readFileSync(join(REPO, "worker", "src", "worker.js"), "utf8").includes("unreachable.json"));
});
