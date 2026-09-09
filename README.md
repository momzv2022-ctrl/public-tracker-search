# Public Tracker Search

Search the public torrent indexes — ten of them, at once — from a URL only you
know.

One file, run for free by Cloudflare, asks the indexes your question and merges
the answers into one list: names, sizes, seeders, and `magnet:` links. You get
a URL and a key. Nothing is installed on your computer, no card is involved,
and there is no public copy of this. The only URL that exists is the one you
make.

It answers as a [Unified Torrent Search Interface](https://github.com/momzv2022-ctrl/unified-torrent-search-interface),
whose Worker it grew out of, so anything that talks to a UTSI — the qBittorrent
plugin, [tracker-integration](https://github.com/momzv2022-ctrl/tracker-integration),
any [Torrent Stream Protocol](https://github.com/raul2hot/torrent-stream-protocol)
client — talks to this. What changed: three times the indexes, search pages
read as engines and not only APIs, and a setup that is copy and paste rather
than a link.

## Set it up

**→ https://momzv2022-ctrl.github.io/public-tracker-search/**

1. Press **Copy the code**. A key is made in your browser and written into the
   copy.
2. At [dash.cloudflare.com](https://dash.cloudflare.com/) (free, no card):
   *Workers & Pages → Create → Start with Hello World → Deploy*, then
   *Edit code*, select all, paste, *Deploy*.
3. Open the Worker's address. It shows your URL and your key, ready for the
   app, and a button that runs a real search.

**It is pasted, not uploaded.** *Create* offers *Upload and deploy* as well —
a drag-and-drop box that publishes files as a static site. Drop `worker.js`
into it and you get the file back as text at `/worker.js`, your address answers
404, and nothing runs; it warns you on the way past ("this uploader does not
yet support projects that require a build process"). Use *Edit code* and paste.

The page makes no network request — the browser is told to refuse one — and
the key never leaves it except inside the file you copy. There is no link to
Cloudflare and no account connection: the file is the whole handover.

**Anyone who can open your Worker's address can read the key.** That is the
trade for a setup with no dashboard in it. Keep the address to yourself, and
once your app has the key, hide it: `UTSI_SHOW_KEY` = `0` under the Worker's
*Settings → Variables and Secrets*. To change the key, copy the code again and
paste it over the old one.

## Use it

**qBittorrent.** [`qbittorrent/utsi.py`](qbittorrent/utsi.py) sends your
searches to your URL. Put your URL and key on its first two lines, then in
qBittorrent: *View → Search Engine*; in the Search tab, *Search plugins →
Install a new one → Local file*. Results come from your URL.

**Anything else.** The URL is an ordinary JSON API: three routes, one header.

```sh
curl -H "X-API-Key: YOUR-KEY" \
  "https://your-url.workers.dev/api/v1/search?q=big+buck+bunny&limit=5"
```

`/api/v1/search` takes `q`, and optionally `cat`, `year`, `res`, `min_seeders`,
`sort`, `limit` and `offset`. Every row has a `magnet`, an `infohash`, a name,
a size, seeders and leechers, and whatever the release name gives up. Rows from
two indexes that turn out to be the same file are one row, naming both.
`/api/v1/engines` lists the indexes, and `?probe=1` asks each one for real.
`/healthz` needs no key and says which indexes are answering and what broke.
The API is UTSI's, documented in full in
[its docs/api.md](https://github.com/momzv2022-ctrl/unified-torrent-search-interface/blob/main/docs/api.md).

**From tracker-integration.** Tick *Public indexes, through a UTSI of your own*
on its form and give it this Worker's URL and key. Private and public rows land
in one list.

## What it searches

| | covers | read as |
|---|---|---|
| [Knaben](https://knaben.org) | everything — a meta-index over dozens of trackers, 1337x, RuTracker and The Pirate Bay among them, each row naming its tracker | JSON API |
| [The Pirate Bay](https://apibay.org) | everything | JSON API |
| [Torrents-CSV](https://torrents-csv.com) | everything — a DHT crawl | JSON API |
| [Rutor](https://rutor.info) | everything, Russian-language | search page |
| [YTS](https://yts.gg) | films | JSON API |
| [EZTV](https://eztvx.to) | television | JSON API |
| [Anime Tosho](https://animetosho.org) | anime — and it aggregates Nyaa | JSON API |
| [Sukebei](https://sukebei.nyaa.si) | Nyaa's adult half | RSS |
| [DMHY](https://share.dmhy.org) | anime, Chinese-language | RSS |
| [Internet Archive](https://archive.org) | public domain film, Creative Commons media, software, datasets | JSON API + `.torrent` |

Every one of them is asked on every search, in this order — the first to report
a release supplies its name and details — unless `UTSI_ENGINES` says
otherwise. Whether a site also answers *your* Worker is a separate question:
public indexes rate limit, move domain and sometimes decline Cloudflare's
addresses, and `/api/v1/engines?probe=1` is how you ask.

Four more ship in the file but **off by default**, because a deployed Worker
measured them refusing Cloudflare's addresses on 2026-09-05:
[Bitsearch](https://bitsearch.eu) (HTTP 429, and an interstitial page from
solidtorrents.to), [TorrentDownloads](https://www.torrentdownloads.pro) (never
answers), [Torrent Kitty](https://www.torrentkitty.tv) (HTTP 403) and
[Nyaa](https://nyaa.si) (HTTP 429; its releases arrive through Anime Tosho).
Their descriptors are correct, so naming one in `UTSI_ENGINES` turns it on for
a deployment the site happens to answer, and the feed can switch any of them
back on for everybody the day that changes. A fifth,
[TorrentDownload](https://www.torrentdownload.info), is off for a worse
reason: it fabricates results, writing your query into unrelated release names
with invented seeder counts, so a magnet from it fetches something other than
what it is called. It is kept only as a test fixture; do not enable it.

Sites behind a browser challenge cannot be read from a Worker at all, which is
why 1337x, RuTracker, Kickass, MagnetDL, ExtraTorrent and the like are not in
the table — most of them turn up through Knaben instead, tracker named. The
list of what was tried and why it did or did not make it is in
[docs/engines.md](docs/engines.md).

### How the list stays current

A pasted Worker is a photocopy of one moment, in an account this project can
never reach again. So the Worker fetches this repository's
[feed](https://momzv2022-ctrl.github.io/public-tracker-search/feed.json) once
an hour, off the search path, and adopts its engine definitions: a moved
address, a search page that changed its table, a new index, an index marked
dead — all without a re-paste. The feed is data, never code, and is checked
against the same schema and limits the file enforces on itself. A feed that is
unreachable, expired or malformed changes nothing: the Worker keeps the last
good one, or the definitions compiled into the file. `UTSI_FEED=0` turns it
off.

## Settings

Everything is optional. Set them under the Worker's *Settings → Variables and
Secrets*, then *Deploy*; the names are UTSI's.

| | |
|---|---|
| `UTSI_API_KEY` | Wins over the key in the file. At least 16 characters. |
| `UTSI_SHOW_KEY` | `0` takes the key off the page at `/`. |
| `UTSI_ENGINES` | Which indexes, comma separated, in merge order. Empty means all of them. |
| `UTSI_ENGINE_URLS` | `name=https://address`, replacing an index's address list. The repair for a move nobody predicted. |
| `UTSI_MAX_ROWS_PER_ENGINE` | Rows kept from each index before merging. Default 40; the main lever on CPU time. |
| `UTSI_MAX_RESOLVE` | `.torrent` files fetched per search for rows that arrive without an infohash (the Archive's). Default 4; `0` drops them. |
| `UTSI_FEED`, `UTSI_FEED_URL` | The feed above: off, or somewhere else. |
| `UTSI_QUERY_MATCH` | `off` returns whatever the indexes said, instead of only rows whose name answers every word of the query. |
| `UTSI_UPSTREAM_URL`, `UTSI_UPSTREAM_APIKEY` | A TSP index of your own, asked first. |
| `UTSI_TORZNAB_URL`, `UTSI_TORZNAB_APIKEY` | Your own Jackett, Prowlarr or NZBHydra, as one more engine. |
| `UTSI_FALLBACK_URL`, `UTSI_FALLBACK_APIKEY` | An index asked only when everything else found nothing. |
| `UTSI_ENGINE_TIMEOUT_S`, `UTSI_REQUEST_DEADLINE_S`, `UTSI_CORS_ORIGINS`, `UTSI_ALLOW_ANONYMOUS`, `UTSI_BANNER`, `UTSI_UPDATE_CHECK`, `UTSI_EMPTY_QUERY_MODE`, `UTSI_BROWSE_QUERIES` | The knobs. Each is explained beside its line in section 2 of the file. |

## Check it before you trust it

A stranger is asking you to put their code into your cloud account. Being
suspicious of that is correct.

- **It is one file, and you can read all of it.**
  [`worker/src/worker.js`](worker/src/worker.js): no dependencies, no build
  step, no minifier. What you deploy is what you read.
- **The page ships that file unchanged.** `docs/worker.js` is a byte-for-byte
  copy and `docs/worker.js.sha256` its hash; `npm test` fails if they drift.
- **Search the file for `fetch(`.** Every request goes to an index in the
  table above, or to this repository's feed and version files on GitHub Pages.
  No other host, no telemetry, no log of what you searched.
- **Your key never leaves your browser.** The setup page makes it with
  `crypto.getRandomValues` and writes it into the copy of the file you take
  away. The page makes no network request; open your browser's network tab and
  watch.
- **It can only answer requests sent to its own URL**, with your key. It has
  no access to your computer or to anything else in your Cloudflare account,
  and you can delete it in one click.
- **The tests run offline**, against recorded answers from every index, on
  every push: `npm test`.

## What it does not do

It searches public indexes and returns names, sizes, swarm counts and `magnet:`
links. It hosts nothing, stores nothing, transfers no file, and downloads
nothing. The links open in whatever torrent app you already have.

Laws about what you may download differ from country to country, and so do the
terms of the sites this queries. Complying with both is yours to do. Plenty of
what moves over BitTorrent is meant to: Linux images, Internet Archive
material, public domain film, Creative Commons music and video, open datasets.
The example throughout this project is *Big Buck Bunny*, released by the
Blender Foundation under Creative Commons, and that is deliberate. Nothing here
is legal advice.

## For whoever maintains this

Node 20 or newer, nothing else. There is no CI and no workflow: `docs/` is the
GitHub Pages site, built by hand and committed.

```sh
npm test         # every test, offline; refuses a stale docs/
npm run build    # writes docs/: the page, worker.js, its hash, feed.json, version.json
```

Pages is switched on once, in the repository's *Settings → Pages*: deploy from
a branch, `main`, folder `/docs`.

**Adding or repairing an index** is one descriptor — data, not code — in
`SEED_DESCRIPTORS` in section 6 of the file, next to the reasoning that put it
there. Three kinds: `json` (a path into each row), `rss` (a child of each
`<item>`, or `element@attribute`), `html` (a CSS selector inside each row of a
search page). Then a recorded answer in `worker/tests/fixtures/`, a line in
`REPLAY_FIXTURES` in `worker/tools/feed.mjs`, `npm run build`, and every
deployment has it within the hour. The rules the descriptor has to satisfy are
the ones `descriptorProblem()` enforces on the feed, and the language they are
written in is described above that function.

To try a descriptor against the real site before it goes anywhere, a deployed
Worker will run it for you:

```sh
curl -H "X-API-Key: YOUR-KEY" \
  "https://your-url.workers.dev/api/v1/try?q=ubuntu&d=$(jq -rR @uri < descriptor.json)"
```

It answers with the rows the descriptor found, or with what went wrong.

MIT licence, provided without warranty of any kind. The Worker began as the
Unified Torrent Search Interface's Worker, MIT as well; its tests and its
protocol are kept as they were, on purpose.
