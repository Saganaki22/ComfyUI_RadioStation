const appModule = window.comfyAPI?.app || await import("../../scripts/app.js");
const { app } = appModule;

const EXTENSION_NAME = "ComfyUI.RadioStation";
const STORAGE_KEY = "ComfyUI.RadioStation.v1";
const YOUTUBE_API_SRC = "https://www.youtube.com/iframe_api";
const STATIONS_ENDPOINT = "radiostation/lofi-live";
const YOUTUBE_RESOLVE_ENDPOINT = "radiostation/youtube-video";
const STYLESHEET_ID = "comfy-radio-station-style";
const STYLESHEET_HREF = new URL("./css/radio_station.css?style=20260630", import.meta.url).href;
const DEFAULT_STATION_QUERY = "lofi live";
const DEFAULT_VOLUME = 64;
const MAX_STATIONS = 8;
const YOUTUBE_VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;
const FALLBACK_STATIONS = [
    {
        title: "Lofi Hip Hop",
        channel: "Lofi Girl",
        url: "https://www.youtube.com/watch?v=X4VbdwhkE10",
        videoId: "X4VbdwhkE10",
    },
    {
        title: "Jazz Lofi",
        channel: "Lofi Girl",
        url: "https://www.youtube.com/watch?v=E2vONfzoyRI",
        videoId: "E2vONfzoyRI",
    },
    {
        title: "Sleep Lofi",
        channel: "Lofi Girl",
        url: "https://www.youtube.com/watch?v=JD-kMIpDfnY",
        videoId: "JD-kMIpDfnY",
    },
    {
        title: "Study Lofi",
        channel: "STEEZYASFUCK",
        url: "https://www.youtube.com/watch?v=rPjez8z61rI",
        videoId: "rPjez8z61rI",
    },
    {
        title: "Night Drive",
        channel: "Lofi Girl",
        url: "https://www.youtube.com/watch?v=4xDzrJKXOOY",
        videoId: "4xDzrJKXOOY",
    },
];

const CLEAN_STATION_TITLES = {
    ...Object.fromEntries(FALLBACK_STATIONS.map((station) => [station.videoId, station.title])),
};

const STATION_TITLE_PATTERNS = [
    [/coffee\s+shop/, "Coffee Shop"],
    [/cozy.*jazz|jazz.*cozy/, "Cozy Jazz"],
    [/jazz.*lofi|lofi.*jazz/, "Jazz Lofi"],
    [/night\s+drive/, "Night Drive"],
    [/sleep/, "Sleep Lofi"],
    [/study/, "Study Lofi"],
    [/lofi\s+hip\s+hop|hip\s+hop.*lofi/, "Lofi Hip Hop"],
];

let youtubeApiPromise = null;
let activePlayer = null;
let activePlayerHost = null;
let directAudio = null;
let dockHost = null;
let canvasToolbarObserver = null;
let canvasToolbarRetryTimer = null;
let canvasToolbarFrame = 0;
let playbackToken = 0;
let stationRefreshToken = 0;
let stations = FALLBACK_STATIONS;
let shell = null;
let state = {
    expanded: false,
    dockOpen: false,
    playing: false,
    playbackStatus: "idle",
    selectedUrl: FALLBACK_STATIONS[0].url,
    customUrl: "",
    volume: DEFAULT_VOLUME,
    muted: false,
    volumeOpen: false,
    stationManageOpen: false,
    editingStation: "",
    customStations: null,
    stationsEdited: false,
};

const UI_TEXT = {
    play: "Play",
    pause: "Pause",
    volume: "Volume",
    volumeSettings: "Volume settings",
    mute: "Mute",
    unmute: "Unmute",
    stationList: "Station list",
    stations: "Stations",
    editStations: "Edit stations",
    refreshStations: "Refresh live stations",
    customUrl: "Custom stream URL",
    playLink: "Play link",
    stationTitle: "Station title",
    channelName: "Channel name",
    stationUrl: "Station URL",
    save: "Save",
    cancel: "Cancel",
    edit: "Edit",
    remove: "Remove",
    radioPlayer: "Radio player",
    customTitle: "Custom Stream",
    customChannel: "Manual URL",
};

function withTransientStateReset(nextState) {
    return {
        ...nextState,
        dockOpen: false,
        playing: false,
        playbackStatus: "idle",
        volumeOpen: false,
        stationManageOpen: false,
        editingStation: "",
    };
}

function clampVolume(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Math.min(100, Math.max(0, numericValue)) : DEFAULT_VOLUME;
}

function normalizeLoadedState(savedState) {
    const nextState = withTransientStateReset({ ...state, ...savedState });
    const customStations = Array.isArray(nextState.customStations)
        ? dedupeStations(nextState.customStations)
        : null;
    return {
        ...nextState,
        expanded: Boolean(nextState.expanded),
        selectedUrl: String(nextState.selectedUrl || FALLBACK_STATIONS[0].url).trim(),
        customUrl: String(nextState.customUrl || "").trim(),
        volume: clampVolume(nextState.volume),
        muted: Boolean(nextState.muted),
        customStations,
        stationsEdited: Boolean(nextState.stationsEdited && customStations?.length),
    };
}

function loadState() {
    try {
        return normalizeLoadedState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
    } catch (error) {
        console.warn("[RadioStation] Failed to load saved state", error);
        return normalizeLoadedState({});
    }
}

function saveState(nextState = state) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(withTransientStateReset(nextState)));
    } catch (error) {
        console.warn("[RadioStation] Failed to save state", error);
    }
}

function isYoutubeUrl(url) {
    const value = String(url || "").trim();
    if (YOUTUBE_VIDEO_ID_PATTERN.test(value)) {
        return true;
    }

    try {
        const parsed = new URL(value);
        const host = parsed.hostname.replace(/^www\./, "");
        return host === "youtu.be" ||
            host === "youtube.com" ||
            host.endsWith(".youtube.com") ||
            host === "youtube-nocookie.com" ||
            host.endsWith(".youtube-nocookie.com");
    } catch {
        return false;
    }
}

function parseYoutubeId(url) {
    const value = String(url || "").trim();
    if (YOUTUBE_VIDEO_ID_PATTERN.test(value)) {
        return value;
    }

    try {
        const parsed = new URL(value);
        const host = parsed.hostname.replace(/^www\./, "");
        const isYoutubeHost = host === "youtube.com" || host.endsWith(".youtube.com");
        const isNoCookieHost = host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com");
        if (!isYoutubeHost && !isNoCookieHost && host !== "youtu.be") {
            return "";
        }
        if (host === "youtu.be") {
            return normalizeYoutubeId(parsed.pathname.split("/").filter(Boolean)[0]);
        }
        if (parsed.searchParams.get("v")) {
            return normalizeYoutubeId(parsed.searchParams.get("v"));
        }
        const parts = parsed.pathname.split("/").filter(Boolean);
        const marker = parts.findIndex((part) => ["embed", "live", "shorts"].includes(part));
        return marker >= 0 ? normalizeYoutubeId(parts[marker + 1]) : "";
    } catch {
        return "";
    }
}

function normalizeYoutubeId(value) {
    return YOUTUBE_VIDEO_ID_PATTERN.test(String(value || "").trim()) ? String(value).trim() : "";
}

async function resolveYoutubeVideoId(url) {
    const query = encodeURIComponent(String(url || "").trim());
    const payload = await fetchComfyJson(`${YOUTUBE_RESOLVE_ENDPOINT}?url=${query}`, { cache: "no-store" });
    return normalizeYoutubeId(payload.videoId);
}

function normalizeStation(station = {}, index = 0) {
    const source = station && typeof station === "object" ? station : {};
    const sourceUrl = String(source.url || "").trim();
    const videoId = normalizeYoutubeId(source.videoId) || parseYoutubeId(sourceUrl);
    const url = sourceUrl || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
    return {
        title: String(source.title || `lofi live ${index + 1}`).trim(),
        channel: String(source.channel || "YouTube Live").trim(),
        url,
        videoId,
        thumbnail: String(source.thumbnail || "").trim(),
        titleLocked: Boolean(source.titleLocked),
    };
}

function cleanStationTitle(station) {
    if (station.titleLocked) {
        return String(station.title || "").trim() || UI_TEXT.customTitle;
    }

    const videoId = normalizeYoutubeId(station.videoId) || parseYoutubeId(station.url);
    if (videoId && CLEAN_STATION_TITLES[videoId]) {
        return CLEAN_STATION_TITLES[videoId];
    }

    const title = String(station.title || "").trim();
    const lowerTitle = title.toLowerCase();
    const matchedTitle = STATION_TITLE_PATTERNS.find(([pattern]) => pattern.test(lowerTitle));
    if (matchedTitle) {
        return matchedTitle[1];
    }

    return title
        .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
        .replace(/\b(live|radio|24\/7|beats?|to|with)\b/gi, " ")
        .replace(/\s*[-|/]\s*.*/, "")
        .replace(/\s+/g, " ")
        .trim() || UI_TEXT.customTitle;
}

function displayStation(station) {
    if (!station) {
        return station;
    }
    return {
        ...station,
        title: cleanStationTitle(station),
    };
}

function stationKey(station) {
    return station.videoId || station.url;
}

function dedupeStations(stations = []) {
    const next = [];
    const seen = new Set();
    const stationList = Array.isArray(stations) ? stations : [];
    for (const [index, value] of stationList.entries()) {
        const station = normalizeStation(value, index);
        const key = stationKey(station);
        if (!key || seen.has(key)) {
            continue;
        }
        next.push(station);
        seen.add(key);
    }
    return next.slice(0, MAX_STATIONS);
}

function thumbnailForStation(station) {
    if (station?.thumbnail) {
        return station.thumbnail;
    }
    const videoId = normalizeYoutubeId(station?.videoId) || parseYoutubeId(station?.url);
    if (!videoId) {
        return "";
    }
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

async function fetchComfyJson(path, options = {}) {
    const normalizedPath = `/${path.replace(/^\/+/, "")}`;
    const response = app.api?.fetchApi
        ? await app.api.fetchApi(normalizedPath, options)
        : await fetch(normalizedPath, options);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
}

function ensureStylesheet() {
    if (document.getElementById(STYLESHEET_ID)) {
        return;
    }

    const link = document.createElement("link");
    link.id = STYLESHEET_ID;
    link.rel = "stylesheet";
    link.href = STYLESHEET_HREF;
    document.head.appendChild(link);
}

function ensureYoutubeApi() {
    if (window.YT?.Player) {
        return Promise.resolve(window.YT);
    }
    if (youtubeApiPromise) {
        return youtubeApiPromise;
    }

    youtubeApiPromise = new Promise((resolve, reject) => {
        const previousCallback = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
            try {
                previousCallback?.();
            } finally {
                resolve(window.YT);
            }
        };
        const script = document.createElement("script");
        script.src = YOUTUBE_API_SRC;
        script.async = true;
        script.onerror = (event) => {
            youtubeApiPromise = null;
            reject(event);
        };
        document.head.appendChild(script);
    });

    return youtubeApiPromise;
}

function destroyYoutubePlayer() {
    if (activePlayer) {
        try {
            activePlayer.stopVideo?.();
        } catch (error) {
            console.warn("[RadioStation] Failed to stop YouTube player", error);
        }
        if (activePlayer.destroy) {
            activePlayer.destroy();
        }
    }
    activePlayer = null;
    activePlayerHost?.remove();
    activePlayerHost = null;
}

function stopDirectAudio() {
    if (!directAudio) {
        return;
    }
    const audio = directAudio;
    directAudio = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
}

function nextPlaybackToken() {
    playbackToken += 1;
    return playbackToken;
}

function isActivePlaybackToken(token) {
    return token === playbackToken;
}

function nextStationRefreshToken() {
    stationRefreshToken += 1;
    return stationRefreshToken;
}

function invalidateStationRefreshes() {
    stationRefreshToken += 1;
}

function isActiveStationRefreshToken(token) {
    return token === stationRefreshToken;
}

function stopPlayback() {
    nextPlaybackToken();
    state.playing = false;
    state.playbackStatus = "paused";
    destroyYoutubePlayer();
    stopDirectAudio();
}

function applyMute() {
    if (state.muted) {
        activePlayer?.mute?.();
    } else {
        activePlayer?.unMute?.();
        activePlayer?.setVolume?.(state.volume);
    }
    if (directAudio) {
        directAudio.muted = state.muted;
        directAudio.volume = state.volume / 100;
    }
}

async function playYoutube(videoId, volume, token) {
    stopDirectAudio();
    await ensureYoutubeApi();
    if (!isActivePlaybackToken(token) || !state.playing) {
        return;
    }

    destroyYoutubePlayer();
    if (!isActivePlaybackToken(token) || !state.playing) {
        return;
    }

    if (!activePlayerHost) {
        activePlayerHost = document.createElement("div");
        activePlayerHost.className = "crs-host";
        document.body.appendChild(activePlayerHost);
    }

    activePlayer = new window.YT.Player(activePlayerHost, {
        width: 1,
        height: 1,
        videoId,
        playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
            iv_load_policy: 3,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            origin: window.location.origin,
        },
        events: {
            onReady: (event) => {
                if (!isActivePlaybackToken(token) || !state.playing) {
                    return;
                }
                event.target.setVolume(volume);
                if (state.muted) {
                    event.target.mute();
                } else {
                    event.target.unMute();
                }
                event.target.playVideo();
            },
            onError: () => stopPlaybackAfterFailure(token),
        },
    });
}

function isPlaybackAbort(error) {
    return error?.name === "AbortError";
}

async function playDirect(url, volume, token) {
    destroyYoutubePlayer();
    stopDirectAudio();
    directAudio = new Audio(url);
    const audio = directAudio;
    audio.volume = volume / 100;
    audio.muted = state.muted;
    const fail = () => {
        if (directAudio === audio && isActivePlaybackToken(token)) {
            stopPlaybackAfterFailure(token);
        }
    };
    audio.addEventListener("error", fail, { once: true });
    try {
        await audio.play();
    } catch (error) {
        if (directAudio !== audio || !isActivePlaybackToken(token) || isPlaybackAbort(error)) {
            return;
        }
        fail();
    }
}

function stopPlaybackAfterFailure(token = playbackToken) {
    if (!isActivePlaybackToken(token)) {
        return;
    }
    state.playing = false;
    state.playbackStatus = "error";
    destroyYoutubePlayer();
    stopDirectAudio();
    saveState();
    syncPlaybackUi();
}

function setVolume(value) {
    state.volume = clampVolume(value);
    activePlayer?.setVolume?.(state.volume);
    if (directAudio) {
        directAudio.volume = state.volume / 100;
    }
    if (state.volume > 0 && state.muted) {
        state.muted = false;
        applyMute();
    }
    syncVolumeUi();
    saveState();
}

function toggleMute() {
    state.muted = !state.muted;
    state.volumeOpen = true;
    applyMute();
    saveState();
    syncVolumeUi();
}

function toggleVolumePanel() {
    state.volumeOpen = !state.volumeOpen;
    saveState();
    syncVolumeUi();
}

async function playCurrent(options = {}) {
    const url = state.selectedUrl || FALLBACK_STATIONS[0].url;
    let videoId = parseYoutubeId(url);
    const token = nextPlaybackToken();
    state.playing = true;
    state.playbackStatus = "playing";
    saveState();
    const syncView = () => {
        if (options.refreshView) {
            render();
        } else {
            syncPlaybackUi();
        }
    };

    try {
        if (videoId || isYoutubeUrl(url)) {
            syncView();
            videoId = videoId || await resolveYoutubeVideoId(url);
            if (!isActivePlaybackToken(token) || !state.playing) {
                return;
            }
            if (!videoId) {
                throw new Error("Could not resolve YouTube URL");
            }
            await playYoutube(videoId, state.volume, token);
        } else {
            await playDirect(url, state.volume, token);
            if (!isActivePlaybackToken(token)) {
                return;
            }
            syncView();
        }
    } catch (error) {
        if (!isActivePlaybackToken(token)) {
            return;
        }
        console.warn("[RadioStation] Playback failed", error);
        stopPlaybackAfterFailure(token);
    }
}

function selectedStation(stations) {
    return displayStation(
        stations.find(isSelectedStation) ||
        (state.customUrl && state.customUrl === state.selectedUrl
            ? { title: UI_TEXT.customTitle, channel: UI_TEXT.customChannel, url: state.customUrl }
            : stations[0] || FALLBACK_STATIONS[0])
    );
}

function hasStation(url) {
    const normalized = normalizeStation({ url }, 0);
    const key = stationKey(normalized);
    return stations.some((station) => stationKey(station) === key);
}

function isSelectedStation(station) {
    const selectedId = parseYoutubeId(state.selectedUrl);
    return station.url === state.selectedUrl || Boolean(station.videoId && station.videoId === selectedId);
}

function ensureSelectedStation() {
    const previousUrl = state.selectedUrl;
    if (!state.selectedUrl || !stations.some(isSelectedStation)) {
        state.selectedUrl = stations[0]?.url || FALLBACK_STATIONS[0].url;
    }
    return previousUrl !== state.selectedUrl;
}

function syncStoredStations(nextStations) {
    invalidateStationRefreshes();
    stations = dedupeStations(nextStations);
    state.customStations = stations;
    state.stationsEdited = true;
    state.editingStation = "";
    ensureSelectedStation();
    saveState();
    render();
}

function editStation(key, values) {
    const currentStation = stations.find((station) => stationKey(station) === key);
    const nextUrl = String(values.url || "").trim();
    const nextStation = normalizeStation(
        {
            ...values,
            url: nextUrl,
            thumbnail: currentStation?.url === nextUrl ? currentStation.thumbnail : "",
            titleLocked: true,
        },
        0
    );
    if (!nextStation.url) {
        return;
    }
    const previousSelectedUrl = state.selectedUrl;
    const editedSelected = stations.some((station) => (
        stationKey(station) === key &&
        isSelectedStation(station)
    ));
    if (editedSelected) {
        state.selectedUrl = nextStation.url;
    }
    syncStoredStations(stations.map((station) => (stationKey(station) === key ? nextStation : station)));
    if (editedSelected && state.playing && previousSelectedUrl !== nextStation.url) {
        playCurrent({ refreshView: true });
    }
}

function removeStation(key) {
    const removedSelected = stations.some((station) => (
        stationKey(station) === key &&
        isSelectedStation(station)
    ));
    const nextStations = stations.filter((station) => stationKey(station) !== key);
    syncStoredStations(nextStations.length ? nextStations : FALLBACK_STATIONS);
    if (removedSelected && state.playing) {
        playCurrent({ refreshView: true });
    }
}

function addStation(url) {
    const station = normalizeStation(
        {
            url,
            title: UI_TEXT.customTitle,
            channel: UI_TEXT.customChannel,
            titleLocked: true,
        },
        stations.length
    );
    if (!station.url) {
        return false;
    }
    if (!hasStation(station.url)) {
        invalidateStationRefreshes();
        stations = dedupeStations([...stations, station]);
        state.customStations = stations;
        state.stationsEdited = true;
    }
    state.selectedUrl = station.url;
    state.customUrl = station.url;
    state.editingStation = "";
    return true;
}

const ICONS = {
    play: '<path class="crs-icon-fill" d="M8 5.75c0-.75.82-1.22 1.47-.84l10.08 5.92a1.35 1.35 0 0 1 0 2.34L9.47 19.09A.98.98 0 0 1 8 18.25V5.75z"/>',
    pause: '<rect class="crs-icon-fill" x="7" y="5" width="3.6" height="14" rx="1.1"/><rect class="crs-icon-fill" x="13.4" y="5" width="3.6" height="14" rx="1.1"/>',
    volume: '<path d="M4.5 9.25h3.1L12.4 5.4c.7-.56 1.75-.06 1.75.84v11.52c0 .9-1.05 1.4-1.75.84l-4.8-3.85H4.5a1 1 0 0 1-1-1v-3.5a1 1 0 0 1 1-1z"/><path d="M17.2 8.35a5.1 5.1 0 0 1 0 7.3"/><path d="M19.8 6a8.75 8.75 0 0 1 0 12"/>',
    muted: '<path d="M4.5 9.25h3.1L12.4 5.4c.7-.56 1.75-.06 1.75.84v11.52c0 .9-1.05 1.4-1.75.84l-4.8-3.85H4.5a1 1 0 0 1-1-1v-3.5a1 1 0 0 1 1-1z"/><path d="m17.25 9.25 4 4"/><path d="m21.25 9.25-4 4"/>',
    chevronUp: '<path d="m6.5 14.5 5.5-5 5.5 5"/>',
    chevronDown: '<path d="m6.5 9.5 5.5 5 5.5-5"/>',
    link: '<path d="M10.15 13.85a4.2 4.2 0 0 0 5.94.15l2.15-2.15a4.2 4.2 0 0 0-5.94-5.94l-1.05 1.05"/><path d="M13.85 10.15a4.2 4.2 0 0 0-5.94-.15L5.76 12.15a4.2 4.2 0 0 0 5.94 5.94l1.05-1.05"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M8 16H3v5"/>',
};

function icon(name) {
    return `<svg class="crs-icon-svg" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

function syncVolumeUi() {
    if (shell) {
        shell.dataset.muted = String(state.muted);
        shell.dataset.volumeOpen = String(state.volumeOpen);
    }

    document.querySelectorAll(".crs-volume").forEach((volumeInput) => {
        if (Number(volumeInput.value) !== state.volume) {
            volumeInput.value = String(state.volume);
        }
    });

    document.querySelectorAll('[data-action="volume"]').forEach((button) => {
        button.innerHTML = icon(state.muted ? "muted" : "volume");
    });

    const muteLabel = state.muted ? UI_TEXT.unmute : UI_TEXT.mute;
    document.querySelectorAll('[data-action="mute"]').forEach((button) => {
        button.title = muteLabel;
        button.setAttribute("aria-label", muteLabel);
        button.innerHTML = icon(state.muted ? "muted" : "volume");
    });
}

function syncPlaybackUi() {
    if (!shell) {
        return;
    }
    shell.dataset.playing = String(state.playing);
    shell.dataset.playbackStatus = state.playbackStatus;
    renderDockButton();
    const playButton = shell.querySelector('[data-action="play"]');
    if (!playButton) {
        return;
    }
    const label = state.playing ? UI_TEXT.pause : UI_TEXT.play;
    playButton.title = label;
    playButton.setAttribute("aria-label", label);
    playButton.innerHTML = icon(state.playing ? "pause" : "play");
}

function findCanvasToolbarDockSlot() {
    const toolbars = Array.from(document.querySelectorAll('[role="toolbar"]'));
    const toolbar = toolbars.find((element) => (
        element instanceof HTMLElement &&
        element.querySelector('[data-testid="zoom-controls-button"]') &&
        element.querySelector('[data-testid="toggle-minimap-button"]')
    )) || toolbars
        .filter((element) => element instanceof HTMLElement)
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 120 && rect.height > 24 && rect.bottom > window.innerHeight * 0.55)
        .sort((a, b) => b.rect.bottom - a.rect.bottom || b.rect.right - a.rect.right)[0]?.element;
    return toolbar instanceof HTMLElement ? { toolbar, slot: toolbar } : null;
}

function positionShellNearCanvasToolbar() {
    if (!shell || !state.dockOpen) {
        return;
    }
    const dockSlot = findCanvasToolbarDockSlot();
    if (!dockSlot) {
        return;
    }

    requestAnimationFrame(() => {
        const anchor = dockHost?.getBoundingClientRect();
        const rect = anchor?.width ? anchor : dockSlot.toolbar.getBoundingClientRect();
        const shellHeight = shell.offsetHeight || 120;
        const margin = 10;
        const edge = 12;
        const compactOffset = state.expanded ? 0 : 24;
        const right = Math.max(window.innerWidth - rect.right - compactOffset, edge);
        let top = dockSlot.toolbar.getBoundingClientRect().top - shellHeight - margin;
        if (top < edge) {
            top = dockSlot.toolbar.getBoundingClientRect().bottom + margin;
        }
        top = Math.min(Math.max(top, edge), window.innerHeight - shellHeight - edge);

        shell.style.left = "auto";
        shell.style.right = `${Math.round(right)}px`;
        shell.style.top = `${Math.round(top)}px`;
    });
}

function settleShellPosition() {
    positionShellNearCanvasToolbar();
    requestAnimationFrame(positionShellNearCanvasToolbar);
}

function scheduleCanvasToolbarSync() {
    if (canvasToolbarFrame) {
        return;
    }
    canvasToolbarFrame = requestAnimationFrame(() => {
        canvasToolbarFrame = 0;
        ensureCanvasToolbarDock();
        settleShellPosition();
    });
}

function renderDockButton() {
    if (!dockHost) {
        return;
    }
    const current = selectedStation(stations);
    const thumbnail = thumbnailForStation(current);
    const playLabel = state.playing ? UI_TEXT.pause : UI_TEXT.play;
    dockHost.innerHTML = `
        <button class="crs-dock" type="button" data-dock-action="toggle" data-open="${state.dockOpen}" data-playing="${state.playing}" data-playback-status="${state.playbackStatus}" title="${UI_TEXT.radioPlayer}" aria-label="${UI_TEXT.radioPlayer}">
            <span class="crs-dock-cover" aria-hidden="true">
                ${thumbnail ? `<img src="${escapeAttr(thumbnail)}" alt="" loading="lazy" />` : ""}
            </span>
            <span class="crs-dock-line" aria-hidden="true"><span></span></span>
        </button>
        <button class="crs-dock-play" type="button" data-dock-action="play" title="${playLabel}" aria-label="${playLabel}">
            ${icon(state.playing ? "pause" : "play")}
        </button>
    `;
}

function handleDockClick(event) {
    const dockAction = event.target.closest("[data-dock-action]");
    if (!dockAction) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const action = dockAction.dataset.dockAction;
    if (action === "play") {
        if (state.playing) {
            stopPlayback();
            saveState();
            syncPlaybackUi();
        } else {
            playCurrent();
        }
        return;
    }
    state.dockOpen = !state.dockOpen;
    if (!state.dockOpen) {
        state.volumeOpen = false;
        state.editingStation = "";
    }
    saveState();
    render();
}

function ensureCanvasToolbarDock(retryCount = 0) {
    const dockSlot = findCanvasToolbarDockSlot();
    if (!dockSlot) {
        if (retryCount < 80) {
            window.clearTimeout(canvasToolbarRetryTimer);
            canvasToolbarRetryTimer = window.setTimeout(() => ensureCanvasToolbarDock(retryCount + 1), 250);
        }
        return false;
    }

    if (!dockHost) {
        dockHost = document.createElement("span");
        dockHost.className = "crs-canvas-toolbar-host";
        dockHost.addEventListener("click", handleDockClick);
    }
    const needsAttach = !dockSlot.slot.contains(dockHost);
    if (needsAttach) {
        dockSlot.slot.appendChild(dockHost);
    }
    if (needsAttach || !dockHost.firstElementChild) {
        renderDockButton();
    }
    settleShellPosition();
    return true;
}

function observeCanvasToolbar() {
    if (canvasToolbarObserver) {
        return;
    }
    canvasToolbarObserver = new MutationObserver(scheduleCanvasToolbarSync);
    canvasToolbarObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", settleShellPosition);
    window.addEventListener("scroll", settleShellPosition, true);
}

function render() {
    if (!shell) {
        return;
    }

    const current = selectedStation(stations);
    const thumbnail = thumbnailForStation(current);
    const playLabel = state.playing ? UI_TEXT.pause : UI_TEXT.play;
    const muteLabel = state.muted ? UI_TEXT.unmute : UI_TEXT.mute;
    const expandLabel = UI_TEXT.stationList;
    shell.dataset.expanded = String(state.expanded);
    shell.dataset.playing = String(state.playing);
    shell.dataset.playbackStatus = state.playbackStatus;
    shell.dataset.muted = String(state.muted);
    shell.dataset.volumeOpen = String(state.volumeOpen);
    shell.dataset.open = String(state.dockOpen);
    shell.dataset.manage = String(state.stationManageOpen);
    shell.innerHTML = `
        <div class="crs-player">
            <div class="crs-compact">
                <div class="crs-art" aria-hidden="true">
                    ${thumbnail ? `<img class="crs-cover" src="${escapeAttr(thumbnail)}" alt="" loading="lazy" />` : ""}
                    <span class="crs-status-light"></span>
                </div>
                <div class="crs-meta">
                    <div class="crs-title" title="${escapeAttr(current.title)}">${escapeHtml(current.title)}</div>
                    <div class="crs-subtitle" title="${escapeAttr(current.channel)}">${escapeHtml(current.channel)}</div>
                </div>
                <div class="crs-controls">
                    <button class="crs-icon-btn crs-play" type="button" data-action="play" title="${playLabel}" aria-label="${playLabel}">${icon(state.playing ? "pause" : "play")}</button>
                    <div class="crs-volume-control">
                        <button class="crs-icon-btn" type="button" data-action="volume" title="${UI_TEXT.volume}" aria-label="${UI_TEXT.volumeSettings}">${icon(state.muted ? "muted" : "volume")}</button>
                        <div class="crs-volume-popover" role="group" aria-label="${UI_TEXT.volumeSettings}">
                            <button class="crs-icon-btn crs-volume-mute" type="button" data-action="mute" title="${muteLabel}" aria-label="${muteLabel}">${icon(state.muted ? "muted" : "volume")}</button>
                            <input class="crs-volume" type="range" min="0" max="100" value="${state.volume}" aria-label="${UI_TEXT.volume}" />
                        </div>
                    </div>
                    <button class="crs-icon-btn" type="button" data-action="expand" title="${expandLabel}" aria-label="${expandLabel}">${icon(state.expanded ? "chevronDown" : "chevronUp")}</button>
                </div>
                <div class="crs-signal" aria-hidden="true"><span></span></div>
            </div>
            <div class="crs-panel">
                <div class="crs-panel-inner">
                    <div class="crs-panel-head">
                        <span class="crs-panel-label">${UI_TEXT.stations}</span>
                        <button class="crs-icon-btn" type="button" data-action="toggleManage" data-active="${state.stationManageOpen}" title="${UI_TEXT.editStations}" aria-label="${UI_TEXT.editStations}">${icon("edit")}</button>
                        <button class="crs-icon-btn" type="button" data-action="resetStations" title="${UI_TEXT.refreshStations}" aria-label="${UI_TEXT.refreshStations}">${icon("refresh")}</button>
                    </div>
                    <div class="crs-stations">
                        ${stations.map(renderStationButton).join("")}
                    </div>
                    <form class="crs-custom">
                        <input class="crs-input" type="url" placeholder="YouTube live or stream URL" value="${escapeAttr(state.customUrl)}" aria-label="${UI_TEXT.customUrl}" />
                        <button class="crs-icon-btn" type="submit" title="${UI_TEXT.playLink}" aria-label="${UI_TEXT.playLink}">${icon("link")}</button>
                    </form>
                </div>
            </div>
        </div>
    `;
    renderDockButton();
    settleShellPosition();
}

function renderStationButton(station, index) {
    const active = isSelectedStation(station);
    const key = stationKey(station);
    const stationView = displayStation(station);
    if (state.editingStation === key) {
        return `
            <form class="crs-station-edit-form" data-edit-station="${escapeAttr(key)}">
                <input class="crs-input" name="title" type="text" value="${escapeAttr(station.title)}" aria-label="${UI_TEXT.stationTitle}" />
                <input class="crs-input" name="channel" type="text" value="${escapeAttr(station.channel)}" aria-label="${UI_TEXT.channelName}" />
                <input class="crs-input" name="url" type="url" value="${escapeAttr(station.url)}" aria-label="${UI_TEXT.stationUrl}" />
                <span class="crs-station-edit-actions">
                    <button class="crs-icon-btn" type="submit" title="${UI_TEXT.save}" aria-label="${UI_TEXT.save}">${icon("check")}</button>
                    <button class="crs-icon-btn" type="button" data-action="cancelEdit" title="${UI_TEXT.cancel}" aria-label="${UI_TEXT.cancel}">${icon("x")}</button>
                </span>
            </form>
        `;
    }
    return `
        <div class="crs-station-row">
            <button class="crs-station" type="button" data-station="${escapeAttr(station.url)}" data-active="${active}">
                <span class="crs-number">${index + 1}</span>
                <span>
                    <span class="crs-station-title">${escapeHtml(stationView.title)}</span>
                    <span class="crs-station-channel">${escapeHtml(stationView.channel)}</span>
                </span>
            </button>
            <span class="crs-station-tools">
                <button class="crs-icon-btn" type="button" data-action="editStation" data-station-key="${escapeAttr(key)}" title="${UI_TEXT.edit}" aria-label="${UI_TEXT.edit}">${icon("edit")}</button>
                <button class="crs-icon-btn" type="button" data-action="removeStation" data-station-key="${escapeAttr(key)}" title="${UI_TEXT.remove}" aria-label="${UI_TEXT.remove}">${icon("trash")}</button>
            </span>
        </div>
    `;
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
    }[char]));
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
}

async function refreshStations() {
    const refreshToken = nextStationRefreshToken();
    const wasPlaying = state.playing;
    if (state.stationsEdited && Array.isArray(state.customStations) && state.customStations.length) {
        stations = dedupeStations(state.customStations);
        const selectedChanged = ensureSelectedStation();
        saveState();
        if (wasPlaying && selectedChanged) {
            playCurrent({ refreshView: true });
        } else {
            render();
        }
        return;
    }

    try {
        const query = encodeURIComponent(DEFAULT_STATION_QUERY);
        const payload = await fetchComfyJson(`${STATIONS_ENDPOINT}?q=${query}`, { cache: "no-store" });
        if (!isActiveStationRefreshToken(refreshToken) || state.stationsEdited) {
            return;
        }
        stations = dedupeStations(payload.stations?.length ? payload.stations : FALLBACK_STATIONS);
    } catch (error) {
        if (!isActiveStationRefreshToken(refreshToken) || state.stationsEdited) {
            return;
        }
        console.warn("[RadioStation] Using fallback station list", error);
        stations = dedupeStations(FALLBACK_STATIONS);
    }

    const selectedChanged = ensureSelectedStation();
    saveState();
    if (wasPlaying && selectedChanged) {
        playCurrent({ refreshView: true });
    } else {
        render();
    }
}

function attachEvents() {
    shell.addEventListener("click", (event) => {
        const actionButton = event.target.closest("[data-action]");
        if (actionButton) {
            const action = actionButton.dataset.action;
            if (action === "expand") {
                state.expanded = !state.expanded;
                saveState();
                render();
            } else if (action === "play") {
                if (state.playing) {
                    stopPlayback();
                    saveState();
                    syncPlaybackUi();
                } else {
                    playCurrent();
                }
            } else if (action === "volume") {
                toggleVolumePanel();
            } else if (action === "mute") {
                toggleMute();
            } else if (action === "toggleManage") {
                state.stationManageOpen = !state.stationManageOpen;
                if (!state.stationManageOpen) {
                    state.editingStation = "";
                }
                state.expanded = true;
                saveState();
                render();
            } else if (action === "editStation") {
                state.stationManageOpen = true;
                state.editingStation = actionButton.dataset.stationKey || "";
                state.expanded = true;
                saveState();
                render();
            } else if (action === "cancelEdit") {
                state.editingStation = "";
                saveState();
                render();
            } else if (action === "removeStation") {
                removeStation(actionButton.dataset.stationKey || "");
            } else if (action === "resetStations") {
                state.customStations = null;
                state.stationsEdited = false;
                state.stationManageOpen = false;
                state.editingStation = "";
                saveState();
                refreshStations();
            }
            return;
        }

        const stationButton = event.target.closest("[data-station]");
        if (!stationButton) {
            return;
        }
        state.selectedUrl = stationButton.dataset.station;
        state.volumeOpen = false;
        saveState();
        if (state.playing) {
            playCurrent({ refreshView: true });
        } else {
            render();
        }
    });

    shell.addEventListener("submit", (event) => {
        const editForm = event.target.closest(".crs-station-edit-form");
        if (editForm) {
            event.preventDefault();
            const formData = new FormData(editForm);
            editStation(editForm.dataset.editStation || "", {
                title: formData.get("title"),
                channel: formData.get("channel"),
                url: formData.get("url"),
            });
            return;
        }

        const form = event.target.closest(".crs-custom");
        if (!form) {
            return;
        }
        event.preventDefault();
        const input = form.querySelector(".crs-input");
        const url = input.value.trim();
        if (!url) {
            return;
        }
        if (!addStation(url)) {
            return;
        }
        saveState();
        playCurrent({ refreshView: true });
    });

    shell.addEventListener("input", (event) => {
        if (event.target.matches(".crs-volume")) {
            setVolume(event.target.value);
        } else if (event.target.matches(".crs-custom .crs-input")) {
            state.customUrl = event.target.value;
            saveState();
        }
    });

    shell.addEventListener("change", (event) => {
        if (event.target.matches(".crs-volume")) {
            setVolume(event.target.value);
        }
    });

    shell.addEventListener("pointerup", (event) => {
        if (event.target.matches(".crs-volume")) {
            setVolume(event.target.value);
        }
    });
}

function mount() {
    if (document.querySelector(".crs-shell")) {
        return;
    }

    state = loadState();
    if (state.stationsEdited && Array.isArray(state.customStations) && state.customStations.length) {
        stations = dedupeStations(state.customStations);
    }
    ensureStylesheet();
    shell = document.createElement("aside");
    shell.className = "crs-shell";
    shell.dataset.expanded = String(state.expanded);
    document.body.appendChild(shell);
    attachEvents();
    render();
    ensureCanvasToolbarDock();
    observeCanvasToolbar();
    refreshStations();
}

app.registerExtension({
    name: EXTENSION_NAME,
    setup() {
        mount();
    },
});
