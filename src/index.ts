import SparkMD5 from "spark-md5";
import { DurableObject } from "cloudflare:workers";
import { CronExpressionParser } from "cron-parser";
import { exchangeRate } from "./apis/exchange";
import { bsuirSchedule } from "./apis/bsuir";
import { rainForecast, weather } from "./apis/weather";
import { textResult } from "./apis/common";

type Env = Cloudflare.Env & {
  YANDEX_MUSIC_TOKEN: string;
  YANDEX_WEATHER_API_KEY: string;
  MCP_ACCESS_TOKEN: string;
  XIAOZHI_MCP_ENDPOINT: string;
};

interface Artist {
  name: string;
}

interface Album {
  id: string | number;
  title: string;
}

interface YandexTrack {
  id: string | number;
  title: string;
  durationMs?: number;
  coverUri?: string;
  artists?: Artist[];
  albums?: Album[];
}

interface DownloadInfo {
  bitrateInKbps: number;
  codec: string;
  downloadInfoUrl: string;
}

interface Song {
  id: number;
  source_id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  cover_url: string | null;
  url?: string;
}

interface PlaybackState {
  current_song: Song | null;
  playlist: Song[];
  is_playing: boolean;
  volume: number;
  position: number;
  next_id: number;
  shuffle: boolean;
}

interface PassthroughServer { id: string; name: string; url: string; }

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    uri?: string;
  };
}

type DeviceToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;
type PlaybackEnqueuer = (url: string) => Promise<number>;

interface NotificationSchedule {
  id: string;
  cron?: string;
  delay_seconds?: number;
  at?: string;
  one_shot?: boolean;
  text: string;
  timezone: string;
  reference_id: string;
  next_run_at: number;
  created_at: number;
}

interface NotificationOccurrence {
  id: string;
  text: string;
  reference_id: string;
  created_at: number;
  expires_at: number;
}

interface AdminLogEntry {
  id: string;
  at: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  detail?: string;
}

const tools = [
  {
    name: "get_bsuir_schedule",
    description: "Get the BSUIR class schedule for a student group. Always use this tool for questions about today's or tomorrow's classes.",
    inputSchema: {
      type: "object",
      properties: {
        group_number: { type: "integer", minimum: 1, description: "BSUIR student group number" },
        day: { type: "string", enum: ["today", "tomorrow"], description: "Which day's classes to return; defaults to tomorrow" },
      },
      required: ["group_number"],
    },
  },
  {
    name: "get_exchange",
    description: "Get today's Belarusian National Bank exchange rate for one currency. Pass a three-letter code such as USD, EUR, or RUB.",
    inputSchema: {
      type: "object",
      properties: { currency: { type: "string", description: "ISO currency code, for example USD" } },
      required: ["currency"],
    },
  },
  {
    name: "get_rain_forecast",
    description: "Find the next hours when rain or snow is expected from Yandex Weather. Requires latitude and longitude.",
    inputSchema: {
      type: "object",
      properties: {
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
      },
      required: ["latitude", "longitude"],
    },
  },
  {
    name: "get_weather",
    description: "Get a Yandex Weather forecast for latitude and longitude.",
    inputSchema: {
      type: "object",
      properties: {
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
        language: { type: "string", description: "Yandex language, for example ru_RU or en_US" },
        limit: { type: "integer", minimum: 1, maximum: 7, description: "Number of forecast days" },
      },
      required: ["latitude", "longitude"],
    },
  },
  {
    name: "search_music",
    description: "Search Yandex Music",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional song, artist, or album; omit for recommendations" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
    },
  },
  {
    name: "search_web",
    description: "Search the web with Exa. Use domain filters for authoritative wikis such as minecraft.wiki or terraria.wiki.gg.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        domains: { type: "array", items: { type: "string" }, description: "Optional allowed domains" },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "search_onliner_prices",
    description: "Search Onliner.by catalog prices in Belarusian rubles (BYN). Returns matching products, price ranges, offer counts, and catalog links.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product name or model, for example iPhone 17e" },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "create_notification",
    description: "Create a spoken notification using OpenRouter Deepgram Flux TTS. Use cron for recurring reminders, delay_seconds for relative one-shot reminders, or at for a one-shot local clock time such as 20:55.",
    inputSchema: {
      type: "object",
      properties: {
        cron: { type: "string", description: "Optional five-field cron expression for recurring reminders: minute hour day-of-month month day-of-week" },
        delay_seconds: { type: "number", minimum: 1, maximum: 31536000, description: "Optional one-shot delay in seconds. Round fractional values to the nearest whole second. Do not use with cron." },
        at: { type: "string", pattern: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$", description: "Optional one-shot local time HH:MM, for example 20:55." },
        text: { type: "string", description: "Text to speak with Deepgram Flux TTS" },
        timezone: { type: "string", description: "IANA timezone, for example Europe/Minsk", default: "Europe/Minsk" },
        reference_id: { type: "string", description: "Legacy voice field; ignored by OpenRouter TTS" },
      },
      required: ["text"],
    },
  },
  {
    name: "list_notifications",
    description: "List scheduled spoken notifications and their next run times.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cancel_notification",
    description: "Cancel a scheduled spoken notification.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Notification ID returned by create_notification" } },
      required: ["id"],
    },
  },
  {
    name: "play_music",
    description: "Resolve a track returned by search_music and route its playable URL directly to the device's self.audio.play_stream tool.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Numeric track ID from search_music" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_stream_url",
    description: "Get a temporary playable audio URL",
    inputSchema: {
      type: "object",
      properties: { song_id: { type: "string" } },
      required: ["song_id"],
    },
  },
  {
    name: "load_playlist",
    description: "Load a Yandex Music playlist into the playback queue. Accepts a playlist URL or user/playlist-slug.",
    inputSchema: {
      type: "object",
      properties: {
        playlist: { type: "string", description: "Yandex playlist URL or user/playlist-slug" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
      },
      required: ["playlist"],
    },
  },
  {
    name: "play_playlist",
    description: "Find a Yandex Music playlist by its name and load it into the playback queue.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Playlist name, for example Experimental" } },
      required: ["name"],
    },
  },
  {
    name: "list_playlists",
    description: "List the authenticated Yandex Music user's playlists with their names and IDs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "play_liked_songs",
    description: "Load the authenticated Yandex Music user's liked songs into the playback queue.",
    inputSchema: { type: "object", properties: {} },
  },
  ...["pause_music", "resume_music", "stop_music", "get_playlist", "clear_playlist", "next_song", "previous_song"].map(
    (name) => ({ name, description: name.replaceAll("_", " "), inputSchema: { type: "object", properties: {} } }),
  ),
  {
    name: "shuffle_music",
    description: "Enable or disable shuffled playlist playback on the device.",
    inputSchema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
  },
  {
    name: "set_volume",
    description: "Set playback volume",
    inputSchema: {
      type: "object",
      properties: { volume: { type: "integer", minimum: 0, maximum: 100 } },
      required: ["volume"],
    },
  },
  {
    name: "add_to_playlist",
    description: "Add a track to the playlist",
    inputSchema: {
      type: "object",
      properties: {
        song_id: { type: "string" },
        song_name: { type: "string" },
        artist: { type: "string" },
      },
      required: ["song_id"],
    },
  },
];

let runtimeYandex = { uid: "", token: "" };

function yandexHeaders(env: Env): HeadersInit {
  return { Authorization: `OAuth ${runtimeYandex.token || env.YANDEX_MUSIC_TOKEN}` };
}

async function yandexJson<T>(url: string, env: Env): Promise<T> {
  // Do not leave an MCP tools/call request hanging indefinitely when the
  // Yandex API or the OAuth token endpoint is unavailable.
  const response = await fetch(url, {
    headers: yandexHeaders(env),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Yandex Music returned HTTP ${response.status}`);
  return response.json<T>();
}

async function searchWeb(query: string, domains: string[], limit: number, env: Env): Promise<object> {
  const apiKey = (env as Env & { EXA_API_KEY?: string }).EXA_API_KEY;
  if (!apiKey) throw new Error("EXA_API_KEY is not configured");
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: Math.max(1, Math.min(limit, 10)),
      ...(domains.length ? { includeDomains: domains.slice(0, 20) } : {}),
      contents: { highlights: { maxCharacters: 1200 } },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Exa returned HTTP ${response.status}`);
  const data = await response.json<{ results?: Array<{ title?: string; url?: string; publishedDate?: string; highlights?: string[] }> }>();
  return textResult(JSON.stringify({
    query,
    results: (data.results ?? []).map((item) => ({
      title: item.title ?? "",
      url: item.url ?? "",
      published_date: item.publishedDate ?? null,
      highlights: item.highlights ?? [],
    })),
  }));
}

async function searchOnlinerPrices(query: string, limit: number): Promise<object> {
  const params = new URLSearchParams({ query, limit: String(Math.max(1, Math.min(limit, 10))) });
  const response = await fetch(`https://catalog.api.onliner.by/search/products?${params}`, {
    headers: { accept: "application/json", "user-agent": "xiaozhi-music-mcp/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Onliner catalog returned HTTP ${response.status}`);
  const data = await response.json<{ products?: Array<{
    id?: number; key?: string; name?: string; full_name?: string; html_url?: string;
    prices?: { price_min?: { amount?: string; currency?: string }; price_max?: { amount?: string; currency?: string }; offers?: { count?: number } };
  }> }>();
  const products = (data.products ?? []).map((product) => ({
    name: product.full_name ?? product.name ?? "",
    url: product.html_url ?? (product.key ? `https://catalog.onliner.by/product/${product.key}` : ""),
    price_min: product.prices?.price_min?.amount ?? null,
    price_max: product.prices?.price_max?.amount ?? null,
    currency: product.prices?.price_min?.currency ?? "BYN",
    offers: product.prices?.offers?.count ?? 0,
  }));
  return textResult(JSON.stringify({ query, source: "Onliner.by", products }));
}

function serializeTrack(track: YandexTrack, id: number): Song {
  const album = track.albums?.[0];
  return {
    id,
    source_id: album ? `${track.id}:${album.id}` : String(track.id),
    name: track.title,
    artist: track.artists?.map((artist) => artist.name).join(", ") ?? "",
    album: album?.title ?? "",
    duration: Math.round((track.durationMs ?? 0) / 1000),
    cover_url: track.coverUri ? `https://${track.coverUri.replace("%%", "400x400")}` : null,
  };
}

async function searchMusic(query: string, limit: number, state: PlaybackState, env: Env): Promise<Song[]> {
  const params = new URLSearchParams({ text: query, type: "track", page: "0", nocorrect: "false" });
  const data = await yandexJson<{ result?: { tracks?: { results?: YandexTrack[] } } }>(
    `https://api.music.yandex.net/search?${params}`,
    env,
  );
  return (data.result?.tracks?.results ?? [])
    .slice(0, Math.max(1, Math.min(limit, 50)))
    .map((track) => serializeTrack(track, state.next_id++));
}

function parsePlaylistReference(reference: string): { user: string; kind: string } {
  const value = reference.trim();
  const urlMatch = value.match(/music\.yandex\.(?:ru|com)\/users\/([^/]+)\/playlists\/([^/?#]+)/i);
  const path = urlMatch ? urlMatch.slice(1) : value.split("/").filter(Boolean);
  if (path.length !== 2 || !path[0] || !path[1]) {
    throw new Error("playlist must be a Yandex playlist URL or user/playlist-slug");
  }
  return { user: decodeURIComponent(path[0]), kind: decodeURIComponent(path[1]) };
}

async function loadPlaylist(reference: string, limit: number, state: PlaybackState, env: Env): Promise<Song[]> {
  const { user, kind } = parsePlaylistReference(reference);
  const data = await yandexJson<{
    result?: { tracks?: Array<{ track?: YandexTrack }> };
  }>(`https://api.music.yandex.net/users/${encodeURIComponent(user)}/playlists/${encodeURIComponent(kind)}`, env);
  const tracks = (data.result?.tracks ?? [])
    .map((entry) => entry.track)
    .filter((track): track is YandexTrack => Boolean(track))
    .slice(0, Math.max(1, Math.min(limit, 100)));
  if (!tracks.length) throw new Error("Yandex playlist is empty or unavailable");
  return tracks.map((track) => serializeTrack(track, state.next_id++));
}

function yandexUser(env: Env): string {
  const user = (env as Env & { YANDEX_MUSIC_USER?: string }).YANDEX_MUSIC_USER;
  return runtimeYandex.uid || user || "1400698515";
}

async function loadNamedPlaylist(name: string, limit: number, state: PlaybackState, env: Env): Promise<Song[]> {
  const normalizedName = name.trim().toLocaleLowerCase();
  if (["мне нравится", "понравившиеся", "понравившиеся песни", "liked songs", "likes", "избранное"].includes(normalizedName)) {
    return loadLikedSongs(limit, state, env);
  }
  const user = yandexUser(env);
  const data = await yandexJson<{ result?: Array<{ uid?: string | number; kind?: string | number; title?: string }> }>(
    `https://api.music.yandex.net/users/${encodeURIComponent(user)}/playlists/list`, env);
  const wanted = normalizedName;
  const playlist = (data.result ?? []).find((item) => item.title?.trim().toLocaleLowerCase() === wanted)
    ?? (data.result ?? []).find((item) => item.title?.toLocaleLowerCase().includes(wanted));
  if (!playlist?.kind) throw new Error(`Yandex playlist not found: ${name}`);
  return loadPlaylist(`${playlist.uid ?? user}/${playlist.kind}`, limit, state, env);
}

async function listPlaylists(env: Env): Promise<object> {
  const user = yandexUser(env);
  const data = await yandexJson<{ result?: Array<{ uid?: string | number; kind?: string | number; title?: string; trackCount?: number }> }>(
    `https://api.music.yandex.net/users/${encodeURIComponent(user)}/playlists/list`, env);
  const playlists = (data.result ?? []).map((item) => ({
    name: item.title ?? "",
    id: item.kind ?? null,
    user: item.uid ?? user,
    track_count: item.trackCount ?? null,
  }));
  playlists.unshift({ name: "Мне нравится", id: "liked", user, track_count: null });
  return textResult(JSON.stringify({ user, playlists, count: playlists.length }));
}

async function loadLikedSongs(limit: number, state: PlaybackState, env: Env): Promise<Song[]> {
  const user = yandexUser(env);
  const data = await yandexJson<{ result?: { library?: { tracks?: Array<{ track?: YandexTrack } | YandexTrack> }; tracks?: Array<{ track?: YandexTrack } | YandexTrack> } }>(
    `https://api.music.yandex.net/users/${encodeURIComponent(user)}/likes/tracks`, env);
  const entries = data.result?.library?.tracks ?? data.result?.tracks ?? [];
  const tracks = entries
    .map((entry) => ("track" in entry ? entry.track : entry))
    .filter((track): track is YandexTrack => Boolean(track))
    .slice(0, Math.max(1, Math.min(limit, 100)));
  if (!tracks.length) throw new Error("No liked Yandex tracks were found");
  return tracks.map((track) => serializeTrack(track, state.next_id++));
}

function xmlValue(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  if (!match) throw new Error(`Missing ${tag} in Yandex download response`);
  return match[1];
}

async function getStreamUrl(songId: string, env: Env): Promise<string> {
  const data = await yandexJson<{ result?: DownloadInfo[] }>(
    `https://api.music.yandex.net/tracks/${encodeURIComponent(songId)}/download-info?can_use_streaming=true`,
    env,
  );
  const choices = data.result ?? [];
  const info = choices.sort((a, b) => {
    const codec = Number(b.codec === "mp3") - Number(a.codec === "mp3");
    // The ESP32's TLS path cannot sustain Yandex's highest bitrate reliably.
    // Prefer MP3 for compatibility, then choose the lowest bitrate to keep
    // the downloader ahead of real-time playback.
    return codec || a.bitrateInKbps - b.bitrateInKbps;
  })[0];
  if (!info) throw new Error("No downloadable audio is available for this track");

  const response = await fetch(info.downloadInfoUrl, {
    headers: yandexHeaders(env),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Yandex download metadata returned HTTP ${response.status}`);
  const xml = await response.text();
  const host = xmlValue(xml, "host");
  const path = xmlValue(xml, "path");
  const timestamp = xmlValue(xml, "ts");
  const salt = xmlValue(xml, "s");
  const signature = SparkMD5.hash(`XGRlBW9FXlekgbPrRHuSiA${path.slice(1)}${salt}`);
  return `https://${host}/get-mp3/${signature}/${timestamp}${path}`;
}

/* External API implementations live under src/apis. */
/*
  const response = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`API returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response.json();
}

async function bsuirApi(path: string, groupNumber?: unknown): Promise<object> {
  const normalized = path.trim().replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || normalized.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    throw new Error("path must be a relative BSUIR API path");
  }
  let url = `https://iis.bsuir.by/api/${normalized}`;
  const schedulePath = /^v1\/(?:schedule|studentGroup(?:s)?\/[^/]+\/schedule|studentGroup\/schedule(?:\/[^/]+)?)\/?(?:\?.*)?$/i.test(normalized);
  if (schedulePath) {
    const embedded = normalized.match(/(?:studentGroup(?:s)?\/|schedule\/)(\d+)/i)?.[1]
      ?? new URLSearchParams(normalized.split("?")[1] ?? "").get("groupNumber")
      ?? new URLSearchParams(normalized.split("?")[1] ?? "").get("studentGroup");
    const number = groupNumber ?? (embedded ? Number(embedded) : undefined);
    if (!Number.isInteger(number) || (number as number) < 1) {
      throw new Error("group_number is required for v1/schedule");
    }
    url = `https://iis.bsuir.by/api/v1/schedule?studentGroup=${number}`;
  }
  return textResult(JSON.stringify(await fetchJsonApi(url)));
}


async function exchangeRate(currency: string): Promise<object> {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("currency must be a three-letter ISO code, for example USD");
  const fallback = await fetchJsonApi("https://api.exchangerate-api.com/v4/latest/USD", {}, 5_000) as { rates?: Record<string, number>; date?: string };
  const byn = fallback.rates?.BYN;
  const sourceRate = code === "USD" ? 1 : fallback.rates?.[code];
  if (!byn || !sourceRate) throw new Error(`Exchange rate unavailable for ${code}`);
  return textResult(JSON.stringify({ source: "ExchangeRate-API", currency: code, rate: byn / sourceRate, date: fallback.date ?? null }));
}

async function bsuirSchedule(groupNumber: unknown, day: unknown): Promise<object> {
  if (!Number.isInteger(groupNumber) || (groupNumber as number) < 1) throw new Error("group_number must be a positive integer");
  const selected = day === "today" || day === "tomorrow" ? day : "tomorrow";
  const now = new Date();
  const target = new Date(now.getTime() + (selected === "tomorrow" ? 86_400_000 : 0));
  const weekdays = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
  const weekday = weekdays[target.getDay()];
  const iso = target.toISOString().slice(0, 10);
  const data = await fetchJsonApi(`https://iis.bsuir.by/api/v1/schedule?studentGroup=${groupNumber}`, {}, 20_000) as {
    startDate?: string; schedules?: Record<string, Array<Record<string, unknown>>>;
  };
  const start = data.startDate ? data.startDate.split(".").reverse().join("-") : iso;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const week = Math.floor((Date.parse(`${iso}T00:00:00Z`) - startMs) / 604_800_000) + 1;
  const lessons = (data.schedules?.[weekday] ?? []).filter((lesson) => {
    const weeks = Array.isArray(lesson.weekNumber) ? lesson.weekNumber as unknown[] : [];
    return weeks.length === 0 || weeks.includes(week);
  }).map((lesson) => ({
    time: `${lesson.startLessonTime ?? ""}-${lesson.endLessonTime ?? ""}`,
    subject: lesson.subjectFullName ?? lesson.subject ?? "",
    type: lesson.lessonTypeAbbrev ?? "",
    room: Array.isArray(lesson.auditories) ? lesson.auditories.join(", ") : "",
  }));
  return textResult(JSON.stringify({ group_number: groupNumber, day: selected, date: iso, weekday, lessons }));
}

async function weather(args: Record<string, unknown>, env: Env): Promise<object> {
  const latitude = args.latitude;
  const longitude = args.longitude;
  if (typeof latitude !== "number" || latitude < -90 || latitude > 90) throw new Error("latitude must be between -90 and 90");
  if (typeof longitude !== "number" || longitude < -180 || longitude > 180) throw new Error("longitude must be between -180 and 180");
  if (!env.YANDEX_WEATHER_API_KEY) throw new Error("YANDEX_WEATHER_API_KEY is not configured");
  const params = new URLSearchParams({ lat: String(latitude), lon: String(longitude) });
  if (typeof args.language === "string" && args.language.trim()) params.set("lang", args.language.trim());
  if (Number.isInteger(args.limit)) params.set("limit", String(Math.max(1, Math.min(7, args.limit as number))));
  const data = await fetchJsonApi(`https://api.weather.yandex.ru/v2/forecast?${params}`, {
    "X-Yandex-API-Key": env.YANDEX_WEATHER_API_KEY,
  });
  return textResult(JSON.stringify({ source: "Yandex Weather", latitude, longitude, data }));
}

async function rainForecast(args: Record<string, unknown>, env: Env): Promise<object> {
  const latitude = args.latitude;
  const longitude = args.longitude;
  if (typeof latitude !== "number" || latitude < -90 || latitude > 90) throw new Error("latitude must be between -90 and 90");
  if (typeof longitude !== "number" || longitude < -180 || longitude > 180) throw new Error("longitude must be between -180 and 180");
  if (!env.YANDEX_WEATHER_API_KEY) throw new Error("YANDEX_WEATHER_API_KEY is not configured");
  const data = await fetchJsonApi(`https://api.weather.yandex.ru/v2/forecast?lat=${latitude}&lon=${longitude}&limit=2`, {
    "X-Yandex-API-Key": env.YANDEX_WEATHER_API_KEY,
  }) as { forecast?: { hours?: Array<Record<string, unknown>> } };
  const hours = (data.forecast?.hours ?? []).filter((hour) => {
    const condition = String(hour.condition ?? "").toLowerCase();
    return condition.includes("rain") || condition.includes("drizzle") || condition.includes("shower") || condition.includes("snow") || Number(hour.prec_prob ?? 0) > 0;
  }).slice(0, 12).map((hour) => ({
    hour: hour.hour ?? null,
    condition: hour.condition ?? null,
    precipitation_probability: hour.prec_prob ?? null,
    precipitation_mm: hour.prec_mm ?? null,
  }));
  return textResult(JSON.stringify({ latitude, longitude, precipitation_hours: hours, message: hours.length ? "Precipitation is expected during the listed hours." : "No precipitation is expected in the next forecast period." }));
}

function textResult(text: string): object {
  return { content: [{ type: "text", text }] };
}
*/

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function requiredInteger(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value as number;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  state: PlaybackState,
  env: Env,
  callDeviceTool?: DeviceToolCaller,
  enqueuePlayback?: PlaybackEnqueuer,
): Promise<object> {
  if (name === "get_bsuir_schedule") return bsuirSchedule(args.group_number, args.day);
  if (name === "get_exchange") return exchangeRate(requiredString(args, "currency"));
  if (name === "get_rain_forecast") return rainForecast(args, env);
  if (name === "get_weather") return weather(args, env);
  if (name === "search_web") {
    const query = requiredString(args, "query");
    const domains = Array.isArray(args.domains)
      ? args.domains.filter((domain): domain is string => typeof domain === "string" && domain.trim().length > 0)
      : [];
    const limit = typeof args.limit === "number" ? args.limit : 5;
    return searchWeb(query, domains, limit, env);
  }
  if (name === "search_onliner_prices") {
    const query = requiredString(args, "query");
    const limit = typeof args.limit === "number" ? args.limit : 5;
    return searchOnlinerPrices(query, limit);
  }
  if (name === "create_notification") {
    const cron = typeof args.cron === "string" && args.cron.trim() ? args.cron.trim() : undefined;
    const rawDelay = typeof args.delay_seconds === "number" ? args.delay_seconds : undefined;
    const at = typeof args.at === "string" && args.at.trim() ? args.at.trim() : undefined;
    if ([cron, rawDelay !== undefined ? "delay" : undefined, at].filter(Boolean).length !== 1) {
      throw new Error("provide exactly one of cron, delay_seconds, or at");
    }
    const delaySeconds = rawDelay === undefined ? undefined : Math.round(rawDelay);
    if (delaySeconds !== undefined && (delaySeconds < 1 || delaySeconds > 31_536_000)) {
      throw new Error("delay_seconds must round to a value from 1 to 31536000");
    }
    const text = requiredString(args, "text");
    const timezone = typeof args.timezone === "string" && args.timezone.trim() ? args.timezone.trim() : "Europe/Minsk";
    const referenceId = typeof args.reference_id === "string" && args.reference_id.trim()
      ? args.reference_id.trim()
      : "f8e63f33b3704ee38bb787b63777cc72";
    if (text.length > 1000) throw new Error("notification text must be at most 1000 characters");
    if (!/^[a-f0-9]{32}$/i.test(referenceId)) throw new Error("reference_id must be a 32-character hexadecimal Fish Audio ID");
    const schedule = await env.NOTIFICATIONS.getByName("primary").createNotification(cron, delaySeconds, at, text, timezone, referenceId);
    return textResult(JSON.stringify({ success: true, notification: schedule }));
  }
  if (name === "list_notifications") {
    const schedules = await env.NOTIFICATIONS.getByName("primary").listNotifications();
    return textResult(JSON.stringify({ success: true, notifications: schedules }));
  }
  if (name === "cancel_notification") {
    const id = requiredString(args, "id");
    const cancelled = await env.NOTIFICATIONS.getByName("primary").cancelNotification(id);
    return textResult(JSON.stringify({ success: cancelled, id }));
  }
  if (name === "search_music") {
    const query = typeof args.query === "string" && args.query.trim() ? args.query.trim() : "popular music";
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const results = await searchMusic(query, limit, state, env);
    state.playlist = results;
    return textResult(JSON.stringify({
      result: {
        success: true,
        results: results.map((song) => ({
          id: song.id,
          title: song.name,
          category: song.album || "Yandex Music",
          description: song.artist,
        })),
        count: results.length,
        message: `Found ${results.length} songs, please use the play_music tool to play the music`,
      },
    }));
  }
  if (name === "get_stream_url") {
    const songId = requiredString(args, "song_id");
    const url = await getStreamUrl(songId, env);
    return textResult(JSON.stringify({ song_id: songId, url }));
  }
  if (name === "load_playlist") {
    const reference = requiredString(args, "playlist");
    const limit = typeof args.limit === "number" ? args.limit : 100;
    state.playlist = await loadPlaylist(reference, limit, state, env);
    state.current_song = null;
    state.is_playing = false;
    state.position = 0;
    let command_id: number | undefined;
    let first_url: string | undefined;
    if (enqueuePlayback && state.playlist[0]) {
      first_url = await getStreamUrl(state.playlist[0].source_id, env);
      command_id = await enqueuePlayback(first_url);
      state.current_song = { ...state.playlist[0], url: first_url };
      state.is_playing = true;
    }
    return textResult(JSON.stringify({
      loaded: state.playlist.length,
      playlist: state.playlist,
      command_id,
      device_tool: first_url ? { name: "self.audio.play_stream", arguments: { url: first_url } } : undefined,
      message: `Loaded ${state.playlist.length} tracks from the Yandex playlist`,
    }));
  }
  if (name === "play_playlist" || name === "play_liked_songs") {
    const limit = typeof args.limit === "number" ? args.limit : 100;
    state.playlist = name === "play_playlist"
      ? await loadNamedPlaylist(requiredString(args, "name"), limit, state, env)
      : await loadLikedSongs(limit, state, env);
    state.current_song = null;
    state.is_playing = false;
    state.position = 0;
    let command_id: number | undefined;
    if (enqueuePlayback && state.playlist[0]) {
      const url = await getStreamUrl(state.playlist[0].source_id, env);
      command_id = await enqueuePlayback(url);
      state.current_song = { ...state.playlist[0], url };
      state.is_playing = true;
    }
    return textResult(JSON.stringify({
      loaded: state.playlist.length,
      playlist: state.playlist,
      command_id,
      message: name === "play_playlist"
        ? `Loaded playlist ${requiredString(args, "name")}`
        : "Loaded liked songs",
    }));
  }
  if (name === "list_playlists") return listPlaylists(env);
  if (name === "play_music") {
    const id = requiredInteger(args, "id");
    const song = state.playlist.find((candidate) => candidate.id === id);
    if (!song) throw new Error(`Unknown track id: ${id}; call search_music first`);
    const url = await getStreamUrl(song.source_id, env);
    if (!enqueuePlayback) throw new Error("Playback command queue is unavailable");
    const command_id = await enqueuePlayback(url);
    // Xiaozhi's cloud MCP bridge does not reliably relay a server-initiated
    // JSON-RPC request. Keep the direct request for endpoints that support
    // it, but also make the device action part of the returned MCP payload so
    // the Xiaozhi tool runner can execute it deterministically.
    const device_route = { queued: true, command_id };
    state.current_song = { ...song, url };
    state.is_playing = true;
    state.position = 0;
    // Match the plain JSON text contract used by the working Kuwo MCP. The
    // official Xiaozhi endpoint recognizes this result and routes `url` to
    // the device playback path.
    return textResult(JSON.stringify({
      message: `正在播放: ${song.name} - ${song.artist}`,
      song_id: song.source_id,
      song_name: song.name,
      artist: song.artist,
      url,
      device_tool: { name: "self.audio.play_stream", arguments: { url } },
      device_route,
      command_id,
    }));
  }
  if (name === "pause_music") state.is_playing = false;
  else if (name === "resume_music") state.is_playing = state.current_song !== null;
  else if (name === "stop_music") {
    if (callDeviceTool) await callDeviceTool("self.audio.stop_stream", {});
    state.is_playing = false;
    state.current_song = null;
    state.position = 0;
  } else if (name === "set_volume") {
    const volume = args.volume;
    if (typeof volume !== "number" || volume < 0 || volume > 100) throw new Error("volume must be between 0 and 100");
    state.volume = volume;
  } else if (name === "add_to_playlist") {
    state.playlist.push({
      id: state.next_id++,
      source_id: requiredString(args, "song_id"),
      name: typeof args.song_name === "string" ? args.song_name : "Unknown track",
      artist: typeof args.artist === "string" ? args.artist : "Unknown artist",
      album: "",
      duration: 0,
      cover_url: null,
    });
  } else if (name === "clear_playlist") state.playlist = [];
  else if (name === "shuffle_music") {
    if (typeof args.enabled !== "boolean") throw new Error("enabled must be a boolean");
    state.shuffle = args.enabled;
    return textResult(JSON.stringify({ shuffle: state.shuffle }));
  } else if (name === "next_song" || name === "previous_song") {
    if (!state.playlist.length) throw new Error("Playlist is empty");
    const currentIndex = state.current_song ? state.playlist.findIndex((song) => song.id === state.current_song?.id) : -1;
    let index: number;
    if (name === "next_song" && state.shuffle && state.playlist.length > 1) {
      do { index = Math.floor(Math.random() * state.playlist.length); } while (index === currentIndex);
    } else {
      const delta = name === "next_song" ? 1 : -1;
      index = (currentIndex + delta + state.playlist.length) % state.playlist.length;
    }
    const song = state.playlist[index];
    if (enqueuePlayback) {
      const url = await getStreamUrl(song.source_id, env);
      const command_id = await enqueuePlayback(url);
      state.current_song = { ...song, url };
      state.is_playing = true;
      state.position = 0;
      return textResult(JSON.stringify({
        message: `正在播放: ${song.name} - ${song.artist}`,
        song_id: song.source_id,
        song_name: song.name,
        artist: song.artist,
        url,
        device_tool: { name: "self.audio.play_stream", arguments: { url } },
        device_route: { queued: true, command_id },
        command_id,
      }));
    }
    state.current_song = song;
    state.is_playing = true;
  } else if (name !== "get_playlist") throw new Error(`Unknown tool: ${name}`);

  return textResult(JSON.stringify({ ...state, playlist: state.playlist }));
}

async function handleRpc(
  request: RpcRequest,
  state: PlaybackState,
  env: Env,
  callDeviceTool?: DeviceToolCaller,
  enqueuePlayback?: PlaybackEnqueuer,
): Promise<object | null> {
  if (!request.id && request.method === "notifications/initialized") return null;
  if (request.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
      serverInfo: { name: "xiaozhi-music-mcp", version: "2.0.0" },
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (!name) throw new Error("Tool name is required");
    return callTool(name, request.params?.arguments ?? {}, state, env, callDeviceTool, enqueuePlayback);
  }
  if (request.method === "resources/list") {
    return {
      resources: [
        { uri: "music://current_playlist", name: "Current playlist", mimeType: "application/json" },
        { uri: "music://current_playing", name: "Current track", mimeType: "application/json" },
      ],
    };
  }
  if (request.method === "resources/read") {
    const value = request.params?.uri === "music://current_playlist" ? state.playlist : state.current_song;
    return { contents: [{ uri: request.params?.uri, mimeType: "application/json", text: JSON.stringify(value) }] };
  }
  throw new Error(`Unknown method: ${request.method ?? "missing"}`);
}

function newState(): PlaybackState {
  return { current_song: null, playlist: [], is_playing: false, volume: 50, position: 0, next_id: 1, shuffle: false };
}

async function secretsEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

function adminPage(): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MCP Admin</title>
<style>body{font:15px system-ui;background:#f4f6f8;color:#17202a;max-width:900px;margin:0 auto;padding:28px 18px}section{background:white;border:1px solid #dce2e8;border-radius:8px;padding:20px;margin:16px 0}h1{margin:0 0 6px}h2{margin-top:0}input,button{font:inherit;padding:9px 10px;margin:4px 4px 4px 0;border:1px solid #b8c2cc;border-radius:5px}button{background:#1769aa;color:white;border:0;cursor:pointer}button.danger{background:#b42318}.muted{color:#667085}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.server{padding:12px 0;border-top:1px solid #edf0f2}.server code{color:#475467}</style>
<h1>MCP Admin</h1><p class="muted">Manage Yandex Music and connected MCP passthrough servers.</p>
<main><section><h2>Yandex Music</h2><div class="row"><input id="uid" inputmode="numeric" placeholder="Yandex numeric UID"><input id="token" type="password" placeholder="Yandex OAuth token" size="34"><button onclick="saveSettings()">Save settings</button><span id="yandexStatus"></span></div></section>
<section><h2>Connected MCP servers</h2><form onsubmit="add(event)" class="row"><input id="name" placeholder="Display name" required><input id="url" placeholder="https://mcp.example.com" required size="42"><button>Add server</button></form><div id="list" class="muted">Loading...</div></section>
<section><h2>Connection status</h2><button onclick="refreshStatus()">Refresh status</button><pre id="statusOutput" class="muted"></pre></section>
<section><h2>Logs</h2><button onclick="loadLogs()">Refresh logs</button><label><input id="autoLogs" type="checkbox" checked> Auto-refresh</label><pre id="logsOutput" class="muted" style="max-height:360px;overflow:auto"></pre></section></main>
<script>async function api(path,opt){const r=await fetch(path,{...opt,headers:{'Content-Type':'application/json',...(opt&&opt.headers||{})}});if(!r.ok)throw Error(await r.text());return r.status===204?null:r.json()}async function load(){try{const [s,y]=await Promise.all([api('/admin/servers'),api('/admin/settings')]);user.value=y.username||'';yandexStatus.textContent=y.tokenConfigured?'Token configured':'Token missing';render(s);refreshStatus();loadLogs()}catch(e){document.querySelector('#list').textContent=e.message}}function render(xs){list.innerHTML=xs.length?xs.map(s=>'<div class="server"><b>'+esc(s.name)+'</b><br><code>'+esc(s.url)+'</code> <button class="danger" onclick="del(\\''+s.id+'\\')">Remove</button></div>').join(''):'<p class="muted">No connected servers.</p>'}function esc(x){return String(x).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]))}async function add(e){e.preventDefault();await api('/admin/servers',{method:'POST',body:JSON.stringify({name:name.value,url:url.value})});name.value='';url.value='';load()}async function del(id){await api('/admin/servers/'+id,{method:'DELETE'});load()}async function saveSettings(){const r=await api('/admin/settings',{method:'PUT',body:JSON.stringify({username:user.value})});yandexStatus.textContent=r.tokenConfigured?'Saved; token configured':'Saved; token missing'}async function refreshStatus(){statusOutput.textContent=JSON.stringify(await api('/admin/status'),null,2)}async function loadLogs(){logsOutput.textContent=JSON.stringify(await api('/admin/logs'),null,2)}setInterval(()=>{if(autoLogs.checked)loadLogs()},5000);load()</script>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function nextCronRun(cron: string, timezone: string, after = Date.now()): number {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new Error("cron must contain exactly 5 fields: minute hour day-of-month month day-of-week");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`invalid IANA timezone: ${timezone}`);
  }
  try {
    return CronExpressionParser.parse(cron, { currentDate: new Date(after), tz: timezone }).next().getTime();
  } catch (error) {
    throw new Error(`invalid cron expression: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export class NotificationScheduler extends DurableObject<Env> {
  async createNotification(cron: string | undefined, delaySeconds: number | undefined, at: string | undefined, text: string, timezone: string, referenceId: string): Promise<NotificationSchedule> {
    const now = Date.now();
    let nextRun = cron ? nextCronRun(cron, timezone, now) : now + (delaySeconds ?? 1) * 1000;
    if (at) {
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error("at must use HH:MM format");
      const [hour, minute] = at.split(":").map(Number);
      // Use cron-parser's timezone handling instead of treating local wall time as UTC.
      nextRun = nextCronRun(`${minute} ${hour} * * *`, timezone, now);
    }
    const schedule: NotificationSchedule = {
      id: crypto.randomUUID(),
      ...(cron ? { cron } : at ? { at, one_shot: true } : { delay_seconds: delaySeconds, one_shot: true }),
      text: text.trim(),
      timezone,
      reference_id: referenceId,
      next_run_at: nextRun,
      created_at: now,
    };
    const schedules = await this.listNotifications();
    schedules.push(schedule);
    await this.ctx.storage.put("notification_schedules", schedules);
    await this.scheduleNextAlarm(schedules);
    return schedule;
  }

  async listNotifications(): Promise<NotificationSchedule[]> {
    return (await this.ctx.storage.get<NotificationSchedule[]>("notification_schedules")) ?? [];
  }

  async cancelNotification(id: string): Promise<boolean> {
    const schedules = await this.listNotifications();
    const remaining = schedules.filter((schedule) => schedule.id !== id);
    if (remaining.length === schedules.length) return false;
    await this.ctx.storage.put("notification_schedules", remaining);
    await this.scheduleNextAlarm(remaining);
    return true;
  }

  async getOccurrence(id: string): Promise<NotificationOccurrence | null> {
    const occurrence = await this.ctx.storage.get<NotificationOccurrence>(`occurrence:${id}`);
    if (!occurrence || occurrence.expires_at < Date.now()) return null;
    return occurrence;
  }

  async getAudio(id: string): Promise<ArrayBuffer | null> {
    return (await this.ctx.storage.get<ArrayBuffer>(`audio:${id}`)) ?? null;
  }

  async generateAudio(id: string): Promise<boolean> {
    const occurrence = await this.getOccurrence(id);
    if (!occurrence) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch("https://tts.13806490.xyz/v1/audio/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "audio/mpeg", "User-Agent": "xiaozhi-notification-worker/1.0" },
          body: JSON.stringify({ model: "kokoro", input: occurrence.text, voice: "sveta", response_format: "mp3", speed: 1, volume_multiplier: 3.0 }),
          signal: AbortSignal.timeout(60_000),
        });
        if (response.ok) {
          const audio = await response.arrayBuffer();
          await this.ctx.storage.put(`audio:${id}`, audio);
          console.log(JSON.stringify({ event: "notification_audio_cached", occurrenceId: id, bytes: audio.byteLength }));
          return true;
        }
        console.error(JSON.stringify({ event: "notification_audio_generation_http_error", occurrenceId: id, attempt: attempt + 1, status: response.status }));
      } catch (error) {
        console.error(JSON.stringify({ event: "notification_audio_generation_exception", occurrenceId: id, attempt: attempt + 1, error: error instanceof Error ? error.message : String(error) }));
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    return false;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const schedules = await this.listNotifications();
    const connector = this.env.CONNECTOR.getByName("primary");
    for (const schedule of schedules) {
      if (schedule.next_run_at > now + 1_000) continue;
      const occurrence: NotificationOccurrence = {
        id: crypto.randomUUID(),
        text: schedule.text,
        reference_id: schedule.reference_id,
        created_at: now,
        expires_at: now + 15 * 60_000,
      };
      await this.ctx.storage.put(`occurrence:${occurrence.id}`, occurrence);
      try {
        await this.generateAudio(occurrence.id);
      } catch (error) {
        console.error(JSON.stringify({ event: "notification_audio_generation_error", error: error instanceof Error ? error.message : String(error), occurrenceId: occurrence.id }));
      }
      const audioUrl = `${this.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/notifications/audio/${occurrence.id}`;
      await connector.enqueuePlayback(audioUrl, 0);
      if (schedule.cron) {
        schedule.next_run_at = nextCronRun(schedule.cron, schedule.timezone, now + 1_000);
      } else {
        schedules.splice(schedules.indexOf(schedule), 1);
      }
      console.log(JSON.stringify({ event: "notification_enqueued", scheduleId: schedule.id, occurrenceId: occurrence.id }));
    }
    await this.ctx.storage.put("notification_schedules", schedules);
    const occurrences = await this.ctx.storage.list<NotificationOccurrence>({ prefix: "occurrence:" });
    await Promise.all([...occurrences.entries()]
      .filter(([, occurrence]) => occurrence.expires_at < now)
      .flatMap(([key]) => [this.ctx.storage.delete(key), this.ctx.storage.delete(`audio:${key.slice("occurrence:".length)}`)]));
    await this.scheduleNextAlarm(schedules);
  }

  private async scheduleNextAlarm(schedules: NotificationSchedule[]): Promise<void> {
    if (!schedules.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...schedules.map((schedule) => schedule.next_run_at)));
  }
}

export class XiaozhiConnector extends DurableObject<Env> {
  private socket: WebSocket | null = null;
  private state: PlaybackState = newState();
  private connectedAt: string | null = null;
  private lastError: string | null = null;
  private lastMessageAt: string | null = null;
  private messageCount = 0;
  private lastClose: { code: number; reason: string } | null = null;
  private pingSequence = 0;
  private requestSequence = 0;
  private pendingDeviceCalls = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    });
  }

  async ensureConnected(): Promise<ReturnType<XiaozhiConnector["status"]>> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.status();

    try {
      const endpoint = new URL(this.env.XIAOZHI_MCP_ENDPOINT);
      endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
      const response = await fetch(endpoint, { headers: { Upgrade: "websocket" } });
      const socket = response.webSocket;
      if (response.status !== 101 || !socket) throw new Error(`Xiaozhi WebSocket returned HTTP ${response.status}`);

      socket.accept();
      this.socket = socket;
      this.connectedAt = new Date().toISOString();
      this.lastError = null;
      this.lastClose = null;
      console.log(JSON.stringify({ event: "xiaozhi_connected", connectedAt: this.connectedAt }));
      socket.addEventListener("message", (event) => this.ctx.waitUntil(this.handleMessage(event)));
      socket.addEventListener("close", (event) => {
        this.lastClose = { code: event.code, reason: event.reason };
        console.log(JSON.stringify({ event: "xiaozhi_closed", code: event.code, reason: event.reason }));
        this.ctx.waitUntil(this.scheduleReconnect(`Connection closed (${event.code})`));
      });
      socket.addEventListener("error", () => {
        console.error(JSON.stringify({ event: "xiaozhi_socket_error" }));
        this.ctx.waitUntil(this.scheduleReconnect("WebSocket error"));
      });
      await this.ctx.storage.setAlarm(Date.now() + 25_000);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown connection error";
      this.lastError = detail.replaceAll(this.env.XIAOZHI_MCP_ENDPOINT, "[XIAOZHI_MCP_ENDPOINT]");
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
    return this.status();
  }

  async enqueuePlayback(url: string, delayMs = 10_000): Promise<number> {
    const commandId = Date.now();
    // Let Xiaozhi finish its confirmation TTS before the device starts music;
    // otherwise the first TTS packet intentionally interrupts external audio.
    await this.ctx.storage.put("playback_command", { id: commandId, url, created_at: commandId, not_before: commandId + delayMs });
    console.log(JSON.stringify({ event: "playback_enqueued", commandId }));
    return commandId;
  }

  async listPassthroughServers(): Promise<PassthroughServer[]> {
    return (await this.ctx.storage.get<PassthroughServer[]>("passthrough_servers")) ?? [];
  }

  async savePassthroughServer(name: string, upstream: string): Promise<PassthroughServer> {
    const url = new URL(upstream);
    if (url.protocol !== "https:") throw new Error("MCP upstream must use HTTPS");
    const servers = await this.listPassthroughServers();
    const server = { id: crypto.randomUUID(), name: name.trim().slice(0, 80), url: url.toString() };
    if (!server.name) throw new Error("Server name is required");
    servers.push(server);
    await this.ctx.storage.put("passthrough_servers", servers);
    return server;
  }

  async removePassthroughServer(id: string): Promise<void> {
    await this.ctx.storage.put("passthrough_servers", (await this.listPassthroughServers()).filter((server) => server.id !== id));
  }

  async getAdminSettings(env: Env): Promise<{ username: string; tokenConfigured: boolean }> {
    return { username: "", tokenConfigured: false };
  }

  async saveAdminSettings(username: string): Promise<void> {
    await this.ctx.storage.put("yandex_user", username.trim().slice(0, 128));
  }

  async passthrough(id: string, body: string, headers: Headers): Promise<Response> {
    const server = (await this.listPassthroughServers()).find((item) => item.id === id);
    if (!server) return new Response("Unknown MCP server", { status: 404 });
    const upstream = await fetch(server.url, {
      method: "POST", body,
      headers: { "Content-Type": headers.get("Content-Type") ?? "application/json", Accept: "application/json, text/event-stream" },
    });
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  }

  async getPlayback(after: number): Promise<{ id: number; url: string } | null> {
    const command = await this.ctx.storage.get<{ id: number; url: string; not_before?: number }>("playback_command");
    return command && command.id > after && Date.now() >= (command.not_before ?? 0) ? command : null;
  }

  async claimPlayback(id: number): Promise<boolean> {
    const command = await this.ctx.storage.get<{ id: number }>("playback_command");
    if (!command || command.id !== id) return false;
    await this.ctx.storage.delete("playback_command");
    return true;
  }

  status(): {
    connected: boolean;
    connectedAt: string | null;
    error: string | null;
    lastMessageAt: string | null;
    messageCount: number;
    lastClose: { code: number; reason: string } | null;
  } {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      connectedAt: this.connectedAt,
      error: this.lastError,
      lastMessageAt: this.lastMessageAt,
      messageCount: this.messageCount,
      lastClose: this.lastClose,
    };
  }

  async alarm(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: `keepalive-${++this.pingSequence}`,
        method: "ping",
      }));
      await this.ctx.storage.setAlarm(Date.now() + 25_000);
      return;
    }
    await this.ensureConnected();
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    let rpc: RpcRequest | undefined;
    try {
      const parsed: unknown = JSON.parse(
        typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer),
      );
      if (typeof parsed !== "object" || parsed === null) throw new Error("JSON-RPC request must be an object");
      rpc = parsed as RpcRequest;
      // Responses to keepalive pings have an id but no method. They are not
      // tool requests and must not be answered with an "unknown method" error.
      if (!rpc.method && rpc.id !== undefined) {
        const pending = this.pendingDeviceCalls.get(String(rpc.id));
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingDeviceCalls.delete(String(rpc.id));
          if (parsed && typeof parsed === "object" && "error" in parsed) {
            pending.reject(new Error(String((parsed as { error?: { message?: string } }).error?.message ?? "Device MCP call failed")));
          } else {
            pending.resolve((parsed as { result?: unknown }).result);
          }
        }
        return;
      }
      this.lastMessageAt = new Date().toISOString();
      this.messageCount += 1;
      console.log(JSON.stringify({ event: "xiaozhi_message", method: rpc.method, id: rpc.id ?? null }));
      const result = await handleRpc(
        rpc,
        this.state,
        this.env,
        (name, args) => this.callDeviceTool(name, args),
        (url) => this.enqueuePlayback(url),
      );
      if (result !== null) socket.send(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: rpc?.id ?? null, error: { code: -32603, message } }));
    }
  }

  private callDeviceTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Xiaozhi MCP endpoint is not connected"));
    }

    const id = `device-${Date.now()}-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDeviceCalls.delete(id);
        reject(new Error(`Device MCP call timed out: ${name}`));
      }, 15_000);
      this.pendingDeviceCalls.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }));
      } catch (error) {
        clearTimeout(timer);
        this.pendingDeviceCalls.delete(id);
        reject(error);
      }
    });
  }

  private async scheduleReconnect(reason: string): Promise<void> {
    this.socket = null;
    this.lastError = reason;
    await this.ctx.storage.setAlarm(Date.now() + 5_000);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/admin/settings" && request.method === "GET") return Response.json({ uid: runtimeYandex.uid, tokenConfigured: Boolean(runtimeYandex.token || env.YANDEX_MUSIC_TOKEN) });
    const connector = env.CONNECTOR.getByName("primary");
    if (url.pathname === "/admin" || url.pathname === "/admin/") return adminPage();
    if (url.pathname === "/admin/servers") {
      if (request.method === "GET") return Response.json(await connector.listPassthroughServers());
      if (request.method === "POST") {
        const body = await request.json<{ name?: string; url?: string }>();
        if (!body.name || !body.url) return Response.json({ error: "name and url are required" }, { status: 400 });
        try { return Response.json(await connector.savePassthroughServer(body.name, body.url), { status: 201 }); }
        catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid server" }, { status: 400 }); }
      }
    }
    if (url.pathname === "/admin/settings") {
      if (request.method === "PUT") {
        const body = await request.json<{ uid?: string; token?: string }>();
        if (!body.uid || !/^\d+$/.test(body.uid) || !body.token) return Response.json({ error: "numeric uid and token are required" }, { status: 400 });
        runtimeYandex = { uid: body.uid, token: body.token };
        return Response.json({ uid: runtimeYandex.uid, tokenConfigured: true });
      }
    }
    if (url.pathname === "/admin/status" && request.method === "GET") {
      return Response.json({ service: "xiaozhi-music-mcp", ...await connector.status(), servers: (await connector.listPassthroughServers()).length });
    }
    const deleteMatch = url.pathname.match(/^\/admin\/servers\/([^/]+)$/);
    if (deleteMatch && request.method === "DELETE") {
      await connector.removePassthroughServer(deleteMatch[1]);
      return new Response(null, { status: 204 });
    }
    const proxyMatch = url.pathname.match(/^\/mcp\/passthrough\/([^/]+)$/);
    if (proxyMatch && request.method === "POST") {
      return connector.passthrough(proxyMatch[1], await request.text(), request.headers);
    }
    if (url.pathname === "/device/ostb-2st-wifi-double-mic-en/playback") {
      const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
      const command = await connector.getPlayback(after);
      if (!command) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      await connector.claimPlayback(command.id);
      // Notification audio is already served by this Worker. Avoid a
      // recursive same-Worker fetch through /stream, which can return 502.
      if (command.url.startsWith(`${url.origin}/notifications/audio/`)) {
        return new Response(command.url, {
          headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", "X-Command-Id": String(command.id) },
        });
      }
      const proxy = new URL("/device/ostb-2st-wifi-double-mic-en/stream", url.origin);
      proxy.searchParams.set("url", command.url);
      return new Response(proxy.toString(), {
        headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", "X-Command-Id": String(command.id) },
      });
    }
    if (url.pathname === "/device/ostb-2st-wifi-double-mic-en/stream") {
      const source = url.searchParams.get("url");
      if (!source || !(source.startsWith("https://") || source.startsWith("http://"))) {
        return new Response("invalid stream URL", { status: 400 });
      }
      const headers = new Headers();
      const range = request.headers.get("Range");
      if (range) headers.set("Range", range);
      let upstream: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          upstream = await fetch(source, { headers, signal: AbortSignal.timeout(60_000) });
        } catch {
          upstream = null;
        }
        if (upstream?.ok || upstream?.status === 206) break;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
      if (!upstream) return new Response("upstream connection failed", { status: 502 });
      if (!upstream.ok && upstream.status !== 206) {
        return new Response(`upstream HTTP ${upstream.status}`, { status: 502 });
      }
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set("Cache-Control", "no-store");
      responseHeaders.set("Accept-Ranges", "bytes");
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    }
    const notificationAudioMatch = url.pathname.match(/^\/notifications\/audio\/([a-f0-9-]+)$/i);
    if (notificationAudioMatch && request.method === "GET") {
      const occurrence = await env.NOTIFICATIONS.getByName("primary").getOccurrence(notificationAudioMatch[1]);
      if (!occurrence) return new Response("notification audio expired", { status: 404 });
      const cachedAudio = await env.NOTIFICATIONS.getByName("primary").getAudio(notificationAudioMatch[1]);
      if (cachedAudio) {
        console.log(JSON.stringify({ event: "notification_audio_served_cached", occurrenceId: notificationAudioMatch[1], bytes: cachedAudio.byteLength }));
        return new Response(cachedAudio, { headers: { "Content-Type": "audio/mpeg", "Content-Length": String(cachedAudio.byteLength), "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300" } });
      }
      console.error(JSON.stringify({ event: "notification_audio_cache_miss", occurrenceId: notificationAudioMatch[1] }));
      const request = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
          "User-Agent": "xiaozhi-notification-worker/1.0",
        },
        body: JSON.stringify({ model: "kokoro", input: occurrence.text, voice: "sveta", response_format: "mp3", speed: 1, volume_multiplier: 3.0 }),
        signal: AbortSignal.timeout(60_000),
      } satisfies RequestInit;
      let tts: Response | null = null;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          tts = await fetch("https://tts.13806490.xyz/v1/audio/speech", request);
          if (tts.ok || ![429, 500, 502, 503, 504].includes(tts.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      } catch (error) {
        console.error(JSON.stringify({ event: "public_tts_exception", error: error instanceof Error ? error.message : String(error), occurrenceId: occurrence.id }));
        return new Response("Public TTS connection failed", { status: 502 });
      }
      if (!tts) return new Response("Public TTS request failed", { status: 502 });
      if (!tts.ok) {
        console.error(JSON.stringify({ event: "public_tts_error", status: tts.status, occurrenceId: occurrence.id }));
        return new Response(`Public TTS returned HTTP ${tts.status}`, { status: 502 });
      }
      const responseHeaders = new Headers(tts.headers);
      responseHeaders.set("Content-Type", tts.headers.get("Content-Type") ?? "audio/mpeg");
      responseHeaders.set("Cache-Control", "private, max-age=300");
      return new Response(tts.body, { headers: responseHeaders });
    }
    const accessToken = url.searchParams.get("access_token") ?? "";
    if (!(await secretsEqual(accessToken, env.MCP_ACCESS_TOKEN))) return new Response("Unauthorized", { status: 401 });
    const status = url.pathname === "/connect" ? await connector.ensureConnected() : await connector.status();
    return Response.json({ service: "xiaozhi-music-mcp", ...status });
  },
} satisfies ExportedHandler<Env>;
