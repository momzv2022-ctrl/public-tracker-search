/**
 * The setup page and the published `docs/`.
 *
 * The page is one HTML file that inlines the Worker and a key generator, and
 * makes no network request. These tests drive the generator directly, then
 * check the committed `docs/` against what `npm run build` would produce —
 * so a source edit without a rebuild fails here rather than on GitHub Pages.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { __testing } from "../src/worker.js";
import { BLANKS, generate, literal, mintKey, sourceUsable } from "../tools/generator.js";
import { REPLAY_FIXTURES, feedEngines, feedIsCurrent } from "../tools/feed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SOURCE = readFileSync(join(REPO, "worker", "src", "worker.js"), "utf8");
const DOCS = join(REPO, "docs");
const read = (name) => readFileSync(join(DOCS, name), "utf8");

// ───────────────────────────────────────────────────────────────────────────
// The generator
// ───────────────────────────────────────────────────────────────────────────

test("the committed source has the one blank line the page fills, exactly once", () => {
  assert.ok(sourceUsable(SOURCE));
  assert.equal(SOURCE.split(BLANKS.API_KEY).length, 2);
});

test("a minted key is long, grouped, and free of look-alike characters", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const key = mintKey();
    assert.match(key, /^[a-hj-km-np-z2-9]{4}(-[a-hj-km-np-z2-9]{4}){5}$/, key);
    assert.ok(key.length >= __testing.MIN_KEY_LENGTH);
    seen.add(key);
  }
  assert.equal(seen.size, 200, "two hundred keys, two hundred different ones");
});

test("generate writes the key into the API_KEY line and touches nothing else", () => {
  const key = "abcd-efgh-jkmn-pqrs-tuvw-xyz2";
  const { code, key: minted } = generate(SOURCE, { key });
  assert.equal(minted, key);
  assert.ok(code.includes(`const API_KEY = "${key}";`));
  assert.ok(!code.includes(BLANKS.API_KEY));
  // Everything else is byte-identical.
  assert.equal(code.replace(`const API_KEY = "${key}";`, BLANKS.API_KEY), SOURCE);
  // And the Worker reads it.
  const settings = __testing.readSettings({});
  assert.equal(settings.apiKey, "", "the committed file has no key");
  const patched = code.match(/^const API_KEY = ("[^"]*");$/m)[1];
  assert.equal(JSON.parse(patched), key);
});

test("a key that could end the string literal cannot", () => {
  for (const nasty of ['a"; fetch("https://evil.test"); //', "a\\b", "a\nb", "a$&b$'c$$d"]) {
    const padded = nasty.padEnd(16, "x");
    const { code } = generate(SOURCE, { key: padded });
    const line = code.match(/^const API_KEY = (.*);$/m)[1];
    assert.equal(JSON.parse(line), padded, `the literal round-trips ${JSON.stringify(padded)}`);
    assert.equal(literal(padded), JSON.stringify(padded));
  }
  assert.throws(() => generate(SOURCE, { key: "short" }), /16 characters/);
  assert.throws(() => generate(SOURCE.replace(BLANKS.API_KEY, 'const API_KEY = "x";'), {}), /could not find/);
});

// ───────────────────────────────────────────────────────────────────────────
// docs/ is what `npm run build` produces
// ───────────────────────────────────────────────────────────────────────────

test("docs/worker.js is the source, byte for byte, and its hash is the published one", () => {
  assert.equal(read("worker.js"), SOURCE, "run `npm run build`");
  const sha = createHash("sha256").update(SOURCE, "utf8").digest("hex");
  assert.equal(read("worker.js.sha256"), `${sha}  worker.js\n`);
  const version = JSON.parse(read("version.json"));
  assert.equal(version.sha256, sha);
  assert.equal(version.version, __testing.VERSION);
  assert.equal(version.engines, feedEngines().length);
});

test("docs/index.html carries the current source, the generator, the engine table, and no placeholder", () => {
  const page = read("index.html");
  assert.ok(page.includes(JSON.stringify(SOURCE).slice(0, 2000)), "the inlined source is stale — run `npm run build`");
  assert.ok(!/__[A-Z_]+__/.test(page), "a placeholder survived the build");
  assert.ok(page.includes("function mintKey()"));
  assert.ok(page.includes("function generate("));
  for (const engine of feedEngines()) {
    if (!engine.site) continue;
    assert.ok(page.includes(`href="${engine.site}"`), `${engine.name} is missing from the table`);
  }
  assert.ok(page.includes(`>${feedEngines().length} public indexes</strong>`));
  // The page may never reach the network. The CSP says so, and nothing in the
  // markup asks for anything: no external script, style, image or font.
  assert.match(page, /Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'/);
  assert.ok(!/<script[^>]+src=/.test(page), "no external scripts");
  assert.ok(!/<link[^>]+rel="?stylesheet/.test(page), "no external styles");
  assert.ok(!/<img\b/.test(page), "no images");
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => !s.includes("var SOURCE ="));
  assert.equal(scripts.length, 2, "the generator and the page script");
  for (const script of scripts) assert.ok(!/fetch\(|XMLHttpRequest|navigator\.sendBeacon/.test(script), "the page's own script never fetches");
});

test("docs/feed.json is the seed, unexpired, and readable by the Worker", () => {
  assert.ok(feedIsCurrent(), "docs/feed.json lags the seed — run `npm run build`");
  const feed = __testing.readFeed(read("feed.json"), Date.now());
  assert.equal(feed.engines.length, feedEngines().length);
  assert.deepEqual(feed.mirrors, ["https://momzv2022-ctrl.github.io/public-tracker-search/feed.json"]);
  assert.equal(feed.moved_to, null);
  // Every engine in it is one this Worker would accept, and the feed engines
  // are exactly the seed — a deployment on the feed and one on the seed search
  // the same indexes.
  for (const entry of feed.engines) assert.equal(__testing.descriptorProblem(entry), "", entry.name);
  assert.equal(JSON.parse(read("version.json")).feed_serial, feed.serial);
});

test("every shipped engine has a recorded answer to replay, and every fixture is real", () => {
  for (const engine of feedEngines()) {
    const fixture = REPLAY_FIXTURES[engine.name];
    assert.ok(fixture, `${engine.name} has no fixture`);
    assert.ok(existsSync(join(HERE, "fixtures", fixture)), `${fixture} is missing`);
  }
});

test("docs/utsi.py is the plugin, pointed at this project", () => {
  const plugin = read("utsi.py");
  assert.equal(plugin, readFileSync(join(REPO, "qbittorrent", "utsi.py"), "utf8"));
  assert.match(plugin, /^URL = ""$/m);
  assert.match(plugin, /^KEY = ""$/m);
  assert.ok(plugin.includes("public-tracker-search"));
  assert.ok(existsSync(join(DOCS, ".nojekyll")));
});
