import asyncio
import json
import re
import time
from urllib.parse import parse_qs, quote_plus, urlparse
from urllib.request import Request, urlopen


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"
__version__ = "1.0.1"
DEFAULT_QUERY = "lofi live"
DEFAULT_LIMIT = 5
MAX_QUERY_LENGTH = 80
MAX_URL_LENGTH = 512
YOUTUBE_TIMEOUT_SECONDS = 8
YOUTUBE_CACHE_SECONDS = 300
YOUTUBE_CACHE_MAX_ITEMS = 32
YOUTUBE_HEADERS = {
    "Accept-Language": "en-US,en;q=0.8",
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    ),
}
YOUTUBE_VIDEO_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{11}")
_youtube_station_cache = {}
_youtube_video_cache = {}
_CACHE_MISS = object()

DEFAULT_LOFI_STATIONS = [
    {
        "title": "Lofi Hip Hop",
        "channel": "Lofi Girl",
        "url": "https://www.youtube.com/watch?v=X4VbdwhkE10",
        "videoId": "X4VbdwhkE10",
    },
    {
        "title": "Jazz Lofi",
        "channel": "Lofi Girl",
        "url": "https://www.youtube.com/watch?v=E2vONfzoyRI",
        "videoId": "E2vONfzoyRI",
    },
    {
        "title": "Sleep Lofi",
        "channel": "Lofi Girl",
        "url": "https://www.youtube.com/watch?v=JD-kMIpDfnY",
        "videoId": "JD-kMIpDfnY",
    },
    {
        "title": "Study Lofi",
        "channel": "STEEZYASFUCK",
        "url": "https://www.youtube.com/watch?v=rPjez8z61rI",
        "videoId": "rPjez8z61rI",
    },
    {
        "title": "Night Drive",
        "channel": "Lofi Girl",
        "url": "https://www.youtube.com/watch?v=4xDzrJKXOOY",
        "videoId": "4xDzrJKXOOY",
    },
]


def _text_value(value):
    if isinstance(value, str):
        return value
    if not isinstance(value, dict):
        return ""
    if isinstance(value.get("simpleText"), str):
        return value["simpleText"]
    runs = value.get("runs")
    if isinstance(runs, list):
        return "".join(str(run.get("text", "")) for run in runs if isinstance(run, dict))
    return ""


def _extract_balanced_json(html, marker):
    marker_index = html.find(marker)
    if marker_index < 0:
        return None

    start = html.find("{", marker_index)
    if start < 0:
        return None

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(html)):
        char = html[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return html[start : index + 1]

    return None


def _walk_video_renderers(value):
    if isinstance(value, dict):
        renderer = value.get("videoRenderer")
        if isinstance(renderer, dict):
            yield renderer
        for child in value.values():
            yield from _walk_video_renderers(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_video_renderers(child)


def _looks_live(renderer):
    blob = json.dumps(renderer, ensure_ascii=True).lower()
    return '"live"' in blob or "live now" in blob or "watching" in blob


def _valid_video_id(value):
    return isinstance(value, str) and YOUTUBE_VIDEO_ID_PATTERN.fullmatch(value) is not None


def _cache_get(cache, key):
    entry = cache.get(key)
    if not entry:
        return _CACHE_MISS

    cached_at, value = entry
    if time.monotonic() - cached_at <= YOUTUBE_CACHE_SECONDS:
        return value

    cache.pop(key, None)
    return _CACHE_MISS


def _cache_set(cache, key, value):
    if len(cache) >= YOUTUBE_CACHE_MAX_ITEMS:
        oldest_key = min(cache, key=lambda item: cache[item][0])
        cache.pop(oldest_key, None)
    cache[key] = (time.monotonic(), value)


def _youtube_host(host):
    normalized_host = str(host or "").lower().split("@")[-1].split(":")[0]
    if normalized_host.startswith("www."):
        normalized_host = normalized_host[4:]
    return (
        normalized_host == "youtu.be"
        or normalized_host == "youtube.com"
        or normalized_host.endswith(".youtube.com")
        or normalized_host == "youtube-nocookie.com"
        or normalized_host.endswith(".youtube-nocookie.com")
    )


def _normalized_youtube_url(value):
    url = str(value or "").strip()
    if not url:
        return ""
    if _valid_video_id(url):
        return f"https://www.youtube.com/watch?v={url}"

    parsed = urlparse(url)
    if not parsed.scheme and not parsed.netloc:
        parsed = urlparse(f"https://{url}")
    if parsed.scheme not in {"http", "https"} or not _youtube_host(parsed.netloc):
        return ""
    return parsed.geturl()


def _video_id_from_youtube_url(value):
    url = str(value or "").strip()
    if _valid_video_id(url):
        return url

    parsed = urlparse(url)
    if not parsed.scheme and not parsed.netloc:
        parsed = urlparse(f"https://{url}")
    if parsed.scheme not in {"http", "https"} or not _youtube_host(parsed.netloc):
        return ""

    host = parsed.hostname.lower() if parsed.hostname else ""
    if host.startswith("www."):
        host = host[4:]

    path_parts = [part for part in parsed.path.split("/") if part]
    if host == "youtu.be" and path_parts:
        return path_parts[0] if _valid_video_id(path_parts[0]) else ""

    query_video_ids = parse_qs(parsed.query).get("v", [])
    if query_video_ids and _valid_video_id(query_video_ids[0]):
        return query_video_ids[0]

    markers = {"embed", "live", "shorts"}
    for index, part in enumerate(path_parts[:-1]):
        if part in markers and _valid_video_id(path_parts[index + 1]):
            return path_parts[index + 1]

    return ""


def _video_id_from_html(html):
    for pattern in (
        r'<link[^>]+rel=["\']canonical["\'][^>]+href=["\'][^"\']*watch\?v=([A-Za-z0-9_-]{11})',
        r'"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"',
        r'watch\?v=([A-Za-z0-9_-]{11})',
    ):
        match = re.search(pattern, html)
        if match and _valid_video_id(match.group(1)):
            return match.group(1)
    return ""


def _resolve_youtube_video_id(value):
    direct_video_id = _video_id_from_youtube_url(value)
    if direct_video_id:
        return direct_video_id

    url = _normalized_youtube_url(value)
    if not url:
        return ""

    cached = _cache_get(_youtube_video_cache, url)
    if cached is not _CACHE_MISS:
        return cached

    request = Request(url, headers=YOUTUBE_HEADERS)
    with urlopen(request, timeout=YOUTUBE_TIMEOUT_SECONDS) as response:
        final_url = response.geturl()
        html = response.read().decode("utf-8", errors="replace")

    video_id = _video_id_from_youtube_url(final_url) or _video_id_from_html(html)
    _cache_set(_youtube_video_cache, url, video_id)
    return video_id


def _station_from_renderer(renderer):
    video_id = renderer.get("videoId")
    if not _valid_video_id(video_id) or not _looks_live(renderer):
        return None

    title = _text_value(renderer.get("title")).strip() or "lofi live"
    channel = _text_value(renderer.get("ownerText")).strip()
    if not channel:
        channel = _text_value(renderer.get("shortBylineText")).strip()

    thumbnail_data = renderer.get("thumbnail", {})
    thumbnails = thumbnail_data.get("thumbnails", []) if isinstance(thumbnail_data, dict) else []
    thumbnail = ""
    if thumbnails and isinstance(thumbnails[-1], dict):
        thumbnail = str(thumbnails[-1].get("url", ""))

    return {
        "title": re.sub(r"\s+", " ", title),
        "channel": re.sub(r"\s+", " ", channel) or "YouTube Live",
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "videoId": video_id,
        "thumbnail": thumbnail,
    }


def _fetch_youtube_live_stations(query=DEFAULT_QUERY, limit=DEFAULT_LIMIT):
    normalized_query = re.sub(r"\s+", " ", str(query or DEFAULT_QUERY).strip() or DEFAULT_QUERY)
    cache_key = (normalized_query.lower(), int(limit))
    cached = _cache_get(_youtube_station_cache, cache_key)
    if cached is not _CACHE_MISS:
        return cached

    url = (
        "https://www.youtube.com/results"
        f"?search_query={quote_plus(normalized_query)}&sp=EgJAAQ%3D%3D"
    )
    request = Request(url, headers=YOUTUBE_HEADERS)
    with urlopen(request, timeout=YOUTUBE_TIMEOUT_SECONDS) as response:
        html = response.read().decode("utf-8", errors="replace")

    payload = _extract_balanced_json(html, "ytInitialData")
    if not payload:
        return []

    data = json.loads(payload)
    stations = []
    seen = set()
    for renderer in _walk_video_renderers(data):
        station = _station_from_renderer(renderer)
        if not station or station["videoId"] in seen:
            continue
        stations.append(station)
        seen.add(station["videoId"])
        if len(stations) >= limit:
            break

    _cache_set(_youtube_station_cache, cache_key, stations)
    return stations


try:
    from aiohttp import web
    from server import PromptServer
except ImportError:
    web = None
    PromptServer = None


if web is not None and PromptServer is not None and getattr(PromptServer, "instance", None) is not None:

    @PromptServer.instance.routes.get("/radiostation/lofi-live")
    async def lofi_live_stations(request):
        query = (request.query.get("q", DEFAULT_QUERY).strip() or DEFAULT_QUERY)[:MAX_QUERY_LENGTH]
        try:
            stations = await asyncio.to_thread(_fetch_youtube_live_stations, query, DEFAULT_LIMIT)
        except Exception:
            stations = []

        return web.json_response(
            {"stations": stations or DEFAULT_LOFI_STATIONS},
            headers={"Cache-Control": "no-store, max-age=0"},
        )

    @PromptServer.instance.routes.get("/radiostation/youtube-video")
    async def youtube_video(request):
        url = request.query.get("url", "").strip()[:MAX_URL_LENGTH]
        try:
            video_id = await asyncio.to_thread(_resolve_youtube_video_id, url)
        except Exception:
            video_id = ""

        return web.json_response(
            {"videoId": video_id},
            headers={"Cache-Control": "no-store, max-age=0"},
        )


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "__version__"]
