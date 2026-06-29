import asyncio
import json
import re
from urllib.parse import quote_plus
from urllib.request import Request, urlopen


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"
__version__ = "1.0.0"
DEFAULT_QUERY = "lofi live"
DEFAULT_LIMIT = 5
MAX_QUERY_LENGTH = 80
YOUTUBE_TIMEOUT_SECONDS = 8

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
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{11}", value) is not None


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
    url = (
        "https://www.youtube.com/results"
        f"?search_query={quote_plus(query)}&sp=EgJAAQ%3D%3D"
    )
    request = Request(
        url,
        headers={
            "Accept-Language": "en-US,en;q=0.8",
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
            ),
        },
    )
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


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "__version__"]
