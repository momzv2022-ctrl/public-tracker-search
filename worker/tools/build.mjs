/**
 * Produce everything the setup page needs, into `docs/`.
 *
 *     node worker/tools/build.mjs
 *
 * Six files, none of them the product of a compiler:
 *
 *   docs/worker.js         the artifact — byte-identical to worker/src/worker.js
 *   docs/worker.js.sha256  its SHA-256, in `shasum -a 256` format
 *   docs/index.html        the setup page, with the artifact inlined
 *   docs/feed.json         the engine feed, built from the artifact's seed
 *   docs/utsi.py           the qBittorrent plugin
 *   docs/version.json      what it is, and where it came from
 *
 * `docs/` rather than `site/`, and committed rather than built by CI, because
 * GitHub Pages will serve a branch's `/docs` folder with no workflow at all:
 * Settings, Pages, "Deploy from a branch", `main`, `/docs`. There is no build
 * step in the usual sense. The artifact is a copy, not an output, so the
 * SHA-256 this publishes is the hash of a file you can read on GitHub, and
 * anyone can deploy the source directly without running this.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { __testing } from "../src/worker.js";
import { BLANKS } from "./generator.js";
import { build as buildFeed, feedEngines } from "./feed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const OUT = join(REPO, "docs");

const SOURCE_PATH = join(REPO, "worker", "src", "worker.js");
const PAGE_PATH = join(HERE, "page.html");
const GENERATOR_PATH = join(HERE, "generator.js");
const PLUGIN_PATH = join(REPO, "qbittorrent", "utsi.py");

const REPO_URL = "https://github.com/momzv2022-ctrl/public-tracker-search";

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * The artifact as a JavaScript string literal, safe to sit inside a `<script>`.
 *
 * `JSON.stringify` handles the quoting; the two replacements after it handle the
 * one thing JSON does not know about — an HTML parser ends a script block at the
 * literal text `</script`, wherever it appears, and closes a comment at `-->`.
 */
function inlineLiteral(text) {
  return JSON.stringify(text).replace(/<\//g, "<\\/").replace(/-->/g, "--\\>");
}

/** One table row per engine, for the page's "What it searches". */
function engineRows(engines) {
  const KINDS = { json: "its JSON API", rss: "its RSS feed", html: "its search page", tsp: "a TSP index", torznab: "Torznab" };
  return engines
    .filter((engine) => engine.enabled !== false)
    .map((engine) => {
      const host = engine.site ? escape(engine.site.replace(/^https?:\/\/(www\.)?/, "")) : escape(engine.name);
      const site = engine.site ? `<a href="${escape(engine.site)}" rel="noopener nofollow">${host}</a>` : host;
      return `    <tr><td>${site}</td><td class="k">${engine.breadth === "broad" ? "broad" : "narrow"}</td><td class="k">${KINDS[engine.kind] || escape(engine.kind)}</td></tr>`;
    })
    .join("\n");
}

export async function build({ log = console.log } = {}) {
  const source = readFileSync(SOURCE_PATH, "utf8");

  // The line the page rewrites must be present, exactly once, and empty. Filled
  // in by accident — a local experiment, a bad merge — it would hand one key to
  // everybody who ever used the page.
  for (const [name, line] of Object.entries(BLANKS)) {
    const found = source.split(line).length - 1;
    if (found !== 1) {
      throw new Error(`worker/src/worker.js carries \`${line}\` ${found} times, not once. The artifact must ship with ${name} empty.`);
    }
  }

  const version = /^const VERSION = "([^"]+)";$/m.exec(source);
  if (!version) throw new Error("worker/src/worker.js has no VERSION line");
  if (version[1] !== __testing.VERSION) throw new Error("VERSION line and module disagree");

  const sha256 = createHash("sha256").update(source, "utf8").digest("hex");

  /**
   * `generator.js` as a plain script, for inlining. It is written as an ES
   * module so the tests can import it; the page wants the same functions as
   * ordinary globals. Dropping the `export` keyword is the whole conversion,
   * which is why the file has no imports and no Node APIs.
   */
  const generator = readFileSync(GENERATOR_PATH, "utf8").replace(/^export /gm, "");
  if (/^\s*import\b|\brequire\(/m.test(generator)) throw new Error("worker/tools/generator.js must stay dependency-free");
  if (generator.includes("</script")) throw new Error("generator.js must not contain </script");

  const engines = feedEngines();
  const page = readFileSync(PAGE_PATH, "utf8")
    .replace("__GENERATOR_LIB__", () => generator)
    .replace("__WORKER_SOURCE__", () => inlineLiteral(source))
    .replace("__ENGINE_ROWS__", () => engineRows(engines))
    .replace(/__ENGINE_COUNT__/g, String(engines.filter((engine) => engine.enabled !== false).length))
    .replace(/__SHA256__/g, sha256)
    .replace(/__VERSION__/g, version[1]);
  for (const placeholder of ["__GENERATOR_LIB__", "__WORKER_SOURCE__", "__ENGINE_ROWS__", "__ENGINE_COUNT__", "__SHA256__", "__VERSION__"]) {
    if (page.includes(placeholder)) throw new Error(`the setup page still has ${placeholder} in it`);
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "worker.js"), source);
  writeFileSync(join(OUT, "worker.js.sha256"), `${sha256}  worker.js\n`);
  writeFileSync(join(OUT, "index.html"), page);
  writeFileSync(join(OUT, ".nojekyll"), "");
  copyFileSync(PLUGIN_PATH, join(OUT, "utsi.py"));
  const feed = await buildFeed({ log });
  // Stamped with the feed's own date rather than the clock, so a build that
  // changes nothing changes nothing.
  writeFileSync(
    join(OUT, "version.json"),
    JSON.stringify(
      {
        version: version[1],
        sha256,
        published: feed.issued_at,
        feed_serial: feed.serial,
        engines: engines.length,
        source: `${REPO_URL}/blob/main/worker/src/worker.js`,
      },
      null,
      2,
    ) + "\n",
  );

  const pageBytes = Buffer.byteLength(page);
  if (pageBytes > 2 * 1024 * 1024) throw new Error(`the setup page is ${pageBytes} bytes`);

  log(`worker.js      ${Buffer.byteLength(source).toLocaleString()} bytes`);
  log(`sha256         ${sha256}`);
  log(`version        ${version[1]}`);
  log(`index.html     ${pageBytes.toLocaleString()} bytes`);
  log(`written to     ${OUT}`);
  return { sha256, version: version[1], page };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  build().catch((thrown) => {
    console.error(thrown && thrown.message ? thrown.message : thrown);
    process.exit(1);
  });
}
