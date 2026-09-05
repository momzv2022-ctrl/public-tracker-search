# VERSION: 1.0
# AUTHORS: Unified Torrent Search Interface contributors; Public Tracker Search contributors
#
# A qBittorrent search plugin that sends your searches to your own search URL.
#
# Two lines to fill in, below: the URL and the key your Worker shows at its
# own address once it is deployed. The setup page is here:
#
#     https://momzv2022-ctrl.github.io/public-tracker-search/
#
# What it does: one request per search, to your URL, with your key in the
# X-API-Key header. The answer is printed in the format qBittorrent expects.
# Nothing else is contacted, and nothing outside the Python standard library
# is used.
#
# MIT licence. Source and documentation:
#     https://github.com/momzv2022-ctrl/public-tracker-search

URL = ""
KEY = ""

import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

from novaprinter import prettyPrinter

# The search takes a few seconds at most, because several indexes are asked at
# once. This is the ceiling for one that never answers.
TIMEOUT_SECONDS = 40

# How many rows to ask for. The server caps this at 200.
LIMIT = 100


class utsi:
    # qBittorrent matches each result's engine_url against this to put the
    # plugin's name in the Engine column, so it must be the same string both
    # places. Your URL when it is filled in; the project page when it is not.
    url = URL.strip().rstrip("/") or "https://github.com/momzv2022-ctrl/public-tracker-search"
    name = "Unified Torrent Search Interface"

    # qBittorrent's categories on the left, the search URL's on the right.
    # An empty string means no filter, which is how "all" is asked for.
    supported_categories = {
        "all": "",
        "movies": "video",
        "tv": "video",
        "anime": "video",
        "music": "audio",
        "games": "software",
        "software": "software",
        "pictures": "image",
        "books": "document",
    }

    def search(self, what, cat="all"):
        base = URL.strip().rstrip("/")
        key = KEY.strip()
        if not base or not key:
            complain("URL or KEY is empty at the top of utsi.py. Fill both in, or download "
                     "the file again from the setup page.")
            return

        # `what` arrives already percent-encoded from qBittorrent, so it goes
        # into the query string as it is.
        query = f"{base}/api/v1/search?q={what}&limit={LIMIT}"
        filter_by = self.supported_categories.get(cat, "")
        if filter_by:
            query += "&cat=" + filter_by

        answer = fetch(query, key)
        if answer is None:
            return

        for row in answer.get("torrents") or []:
            link = row.get("magnet") or row.get("torrent_url")
            name = row.get("name")
            if not link or not name:
                continue
            prettyPrinter({
                "link": link,
                "name": name,
                # A plain byte count as a string: every qBittorrent version reads it.
                "size": str(whole_number(row.get("size_bytes"))),
                "seeds": whole_number(row.get("seeders")),
                "leech": whole_number(row.get("leechers")),
                "engine_url": self.url,
                "desc_link": row.get("description_url") or "",
                "pub_date": unix_time(row.get("first_seen")),
            })


def fetch(query, key):
    """One GET with the key, parsed as JSON. Says what went wrong, then returns None."""
    request = urllib.request.Request(query, headers={
        "X-API-Key": key,
        "Accept": "application/json",
        "User-Agent": "utsi-qbittorrent-plugin/1.0",
    })
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            complain("your URL answered, but it refused the key. The key inside utsi.py is "
                     "not the key inside your Worker.")
        elif error.code == 429:
            complain("your URL is asking you to slow down (HTTP 429). Try again in a minute.")
        else:
            complain(f"your URL answered HTTP {error.code}.")
        return None
    except Exception as error:
        complain(f"could not reach {URL.strip()} ({error}).")
        return None

    try:
        parsed = json.loads(body)
    except ValueError:
        complain("the answer was not JSON. Check that the URL is your search URL.")
        return None
    if not isinstance(parsed, dict):
        complain("the answer was not a search result. Check the URL.")
        return None
    return parsed


def whole_number(value):
    """An integer, or -1, which is how qBittorrent spells unknown."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return -1
    return number if number >= 0 else -1


def unix_time(value):
    """An ISO 8601 timestamp as a Unix time, or -1 when there is none."""
    if not value:
        return -1
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return -1
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp())


def complain(message):
    """qBittorrent keeps a plugin's stderr in its log, which is the one place this can go."""
    print("utsi: " + message, file=sys.stderr)
