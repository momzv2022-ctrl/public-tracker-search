# Every index that was tried, and what happened

The record behind the table in the README: which public indexes were probed
while this project was assembled, from where, and why each did or did not
become an engine. Dates are when the probe was made; sites move, so treat an
entry as a lead rather than a fact.

Two things a probe from here cannot settle. First, whether a site answers a
**Cloudflare Worker's** address — the probes below were made from other
networks, and a site can treat each differently. That answer comes from a
deployed Worker: `/api/v1/engines?probe=1`. Second, whether a search page's
structure holds: a `kind: html` engine reads a table by its classes and cell
order, and a redesign breaks it until the feed is updated. `/healthz` shows a
broken one as a collapsed `drop_ratio` (rows seen, none emitted).

## In the feed (2026-09-05)

| engine | kind | what was verified |
|---|---|---|
| knaben | json | `POST https://api.knaben.org/v1`; rows in `hits`, tracker per row. Inherited from UTSI with its recorded fixture. |
| piratebay | json | `https://apibay.org/q.php?q=`; the "No results returned" sentinel row is dropped. Inherited. |
| torrentscsv | json | `https://torrents-csv.com/service/search?q=&size=`; `torrents[]` with `infohash`. Inherited; answered live. |
| bitsearch | json | `https://bitsearch.eu/api/v1/search?q=&category=all&sort=seeders` → `results[]` with `infohash`, `title`, `size`, `seeders`, `leechers`, `createdAt` (only on recently indexed rows). `solidtorrents.to` redirects here; `torrentz2.nz` serves the same index (its `f=` parameter is ignored — `q=` works). 20 rows a page. |
| torrentdownload | html | `https://www.torrentdownload.info/search?q=`: `table.table2 tr`, name link in `td.tdleft` with the infohash as the first path segment, size in the third cell, `td.tdseed` / `td.tdleech` with thousands separators. Also has `/feed?q=` (RSS, served as `text/html`) whose `<link>` carries the hash but folds size and swarm into one description string — the page gives more. |
| torrentdownloads | rss | `https://www.torrentdownloads.pro/rss.xml?type=search&search=`: items with `info_hash`, `size` (bytes), `seeders`, `leechers`, `pubDate`, and a site-relative `link`. Served as `text/html`; the XML inside is fine. |
| rutor | html | `https://rutor.info/search/0/0/100/0/<q>`: `div#index` table, rows `tr.gai` / `tr.tum`, a magnet link on every row, `span.green` / `span.red` for the swarm, size second from the end (rows with comments have one more cell). Dates are Russian and left absent. `rutor.is` listed as the fallback address. |
| torrentkitty | html | `https://www.torrentkitty.tv/search/<q>/`: `table#archiveResult tr`, `td.name`, `td.size`, `td.date` (ISO), `td.action` with a magnet and a `/information/<hash>` link. No swarm counts — a DHT index. |
| yts | json | The API announces a move to `https://movies-api.accel.li/api/v2/`; `yts.bz` now redirects to `yts.gg`. Both listed ahead of the old names. Inherited adapter. |
| eztvx | json | `https://eztvx.to/api/get-torrents?limit=&page=1&Keywords=` — the API ignores `Keywords` and answers with the newest episodes; the Worker's query gate filters them. Inherited. |
| animetosho | json | `https://feed.animetosho.org/json?q=`; flat array with `info_hash` and `magnet_uri`. Inherited; answered live. |
| nyaa | rss | `https://nyaa.si/?page=rss&q=`; `nyaa:infoHash` and friends. Inherited; answered live. |
| sukebei | rss | The same software at `https://sukebei.nyaa.si`, namespace `https://sukebei.nyaa.si/xmlns/nyaa`. Answered live; fixture recorded. Adult content — a query that does not ask for it rarely gets any, and `UTSI_ENGINES` drops it. |
| dmhy | rss | `https://share.dmhy.org/topics/rss/rss.xml?keyword=`: CDATA titles, `enclosure@url` is a base32 magnet, no swarm. Answers a broad query with up to 500 items (2.3 MB), so the engine reads the first 256 KB. Answered a browser; `max_bytes` set for it. |
| archive | json | `https://archive.org/advancedsearch.php?q=&fl[]=identifier,title,item_size,publicdate&sort[]=downloads desc&rows=&output=json`. Comma-separated `fl[]` works. No infohash: `torrent_url` is `download/<id>/<id>_archive.torrent` and the resolver reads the hash from the file, for up to `UTSI_MAX_RESOLVE` rows a search. |

## Measured from a deployed Worker (2026-09-05)

The first real deployment (`npm run build` serial 1, pasted into a free
Cloudflare account) ran one search and then `/api/v1/try` per engine:

| engine | from Cloudflare | decision |
|---|---|---|
| knaben, torrentscsv, rutor, yts, eztvx, animetosho, sukebei, dmhy, archive | answered, 475–2571 ms | on |
| piratebay | HTTP 429 on the first search, 10 rows in 906 ms on the retry | on — rate limiting comes and goes |
| torrentdownload | timed out at 3 s on the first search, 5 rows in 367–552 ms on the retries | on — a slow first connection. The page has a "Fast Links" advert table with the same class as the results, so five matched rows per page carry nothing and are counted as seen |
| bitsearch | bitsearch.eu HTTP 429 on every request; solidtorrents.to an HTML interstitial (`<meta name…`) | **off by default** |
| torrentdownloads | no answer before the 5 s timeout, every time; answers a browser at once | **off by default** |
| torrentkitty | HTTP 403 in 3 ms | **off by default** |
| nyaa | HTTP 525, then HTTP 429 — what UTSI's probes saw too | **off by default**; animetosho aggregates it |

The four are `enabled: false` in the seed and the feed: still engines, still
selectable by name in `UTSI_ENGINES`, and one feed edit away from being on for
everybody if a site changes its mind.

## Tried and left out (2026-09-05)

**Behind a browser challenge** (an HTTP 200 carrying "Just a moment…"; a
Worker cannot pass it): 1337x, RuTracker (which also needs a login to search),
Kickass, ExtraTorrent, ext.to, uindex, and — where the probing browser was
allowed to look — MagnetDL, GloDLS, BTDig, iDope, AniDex, TokyoTosho. Most of
these are indexed by Knaben, whose rows name the tracker. The Worker recognises
a challenge page and reports the address as down rather than as empty, so if
one of them ever drops the challenge, a descriptor is all it takes.

**No hash on the listing** (a second request per row would be needed):
TorrentGalaxy (`torrentgalaxy.one`, search at `/get-posts/keywords:<q>`),
Torlock, BT4G, TorrentProject (`torrentproject.cc`), YourBittorrent, EZTV's
HTML search (its API is used instead), acg.rip and Mikan (`.torrent` links
only; the Archive shows the resolver can carry a narrow engine like this if
one is wanted).

**Not reachable from the probes**: LimeTorrents (`.lol`, `.pro`, `.fun`), Torrent9,
Il Corsaro Nero, cloudtorrents, piratesparadise, SkyTorrents, torrents.me,
rutracker.net — empty answers or no answer. Worth a `/api/v1/try` from a
deployed Worker before ruling them out.

**Structurally awkward**: LinuxTracker (one nested table per torrent, fields
found by label text rather than position — outside what selectors alone can
say); SubsPlease's API (rows keyed by title in an object, three magnets per
row — its releases are on Nyaa anyway); NNM-Club (magnets need a login);
Academic Torrents (a JavaScript browser check).

## Trying a new one

Write the descriptor, then ask a deployed Worker to run it:

```
GET /api/v1/try?q=<query>&d=<descriptor as URL-encoded JSON>
X-API-Key: <the key>
```

The answer has the rows it found (capped at ten), `stats.seen` and
`stats.emitted`, or the complaint: `invalid descriptor: …`, `HTTP 403`,
`bot challenge page (HTTP 200)`, `not HTML`, `not a feed`. Once it works, it
goes into `SEED_DESCRIPTORS` with a recorded fixture, and `npm run build` puts
it in the feed.
