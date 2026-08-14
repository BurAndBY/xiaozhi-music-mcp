import SparkMD5 from "spark-md5";
import { DurableObject } from "cloudflare:workers";

type Env = Cloudflare.Env;

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
  id: string;
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
}

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

const tools = [
  {
    name: "search_music",
    description: "Search Yandex Music",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Song, artist, or album" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "play_music",
    description: "Resolve and play a Yandex Music track",
    inputSchema: {
      type: "object",
      properties: {
        song_id: { type: "string", description: "Track ID from search results" },
        song_name: { type: "string" },
        artist: { type: "string" },
      },
      required: ["song_id"],
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
  ...["pause_music", "resume_music", "stop_music", "get_playlist", "clear_playlist", "next_song", "previous_song"].map(
    (name) => ({ name, description: name.replaceAll("_", " "), inputSchema: { type: "object", properties: {} } }),
  ),
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

function yandexHeaders(env: Env): HeadersInit {
  return { Authorization: `OAuth ${env.YANDEX_MUSIC_TOKEN}` };
}

async function yandexJson<T>(url: string, env: Env): Promise<T> {
  const response = await fetch(url, { headers: yandexHeaders(env) });
  if (!response.ok) throw new Error(`Yandex Music returned HTTP ${response.status}`);
  return response.json<T>();
}

function serializeTrack(track: YandexTrack): Song {
  const album = track.albums?.[0];
  return {
    id: album ? `${track.id}:${album.id}` : String(track.id),
    name: track.title,
    artist: track.artists?.map((artist) => artist.name).join(", ") ?? "",
    album: album?.title ?? "",
    duration: Math.round((track.durationMs ?? 0) / 1000),
    cover_url: track.coverUri ? `https://${track.coverUri.replace("%%", "400x400")}` : null,
  };
}

async function searchMusic(query: string, limit: number, env: Env): Promise<Song[]> {
  const params = new URLSearchParams({ text: query, type: "track", page: "0", nocorrect: "false" });
  const data = await yandexJson<{ result?: { tracks?: { results?: YandexTrack[] } } }>(
    `https://api.music.yandex.net/search?${params}`,
    env,
  );
  return (data.result?.tracks?.results ?? []).slice(0, Math.max(1, Math.min(limit, 50))).map(serializeTrack);
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
    return codec || b.bitrateInKbps - a.bitrateInKbps;
  })[0];
  if (!info) throw new Error("No downloadable audio is available for this track");

  const response = await fetch(info.downloadInfoUrl);
  if (!response.ok) throw new Error(`Yandex download metadata returned HTTP ${response.status}`);
  const xml = await response.text();
  const host = xmlValue(xml, "host");
  const path = xmlValue(xml, "path");
  const timestamp = xmlValue(xml, "ts");
  const salt = xmlValue(xml, "s");
  const signature = SparkMD5.hash(`XGRlBW9FXlekgbPrRHuSiA${path.slice(1)}${salt}`);
  return `https://${host}/get-mp3/${signature}/${timestamp}${path}`;
}

function textResult(text: string): object {
  return { content: [{ type: "text", text }] };
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

async function callTool(name: string, args: Record<string, unknown>, state: PlaybackState, env: Env): Promise<object> {
  if (name === "search_music") {
    const query = requiredString(args, "query");
    const limit = typeof args.limit === "number" ? args.limit : 10;
    return textResult(JSON.stringify(await searchMusic(query, limit, env)));
  }
  if (name === "get_stream_url" || name === "play_music") {
    const songId = requiredString(args, "song_id");
    const url = await getStreamUrl(songId, env);
    if (name === "play_music") {
      state.current_song = {
        id: songId,
        name: typeof args.song_name === "string" ? args.song_name : "Unknown track",
        artist: typeof args.artist === "string" ? args.artist : "Unknown artist",
        album: "",
        duration: 0,
        cover_url: null,
        url,
      };
      state.is_playing = true;
      state.position = 0;
    }
    return textResult(JSON.stringify({ song_id: songId, url }));
  }
  if (name === "pause_music") state.is_playing = false;
  else if (name === "resume_music") state.is_playing = state.current_song !== null;
  else if (name === "stop_music") {
    state.is_playing = false;
    state.current_song = null;
    state.position = 0;
  } else if (name === "set_volume") {
    const volume = args.volume;
    if (typeof volume !== "number" || volume < 0 || volume > 100) throw new Error("volume must be between 0 and 100");
    state.volume = volume;
  } else if (name === "add_to_playlist") {
    state.playlist.push({
      id: requiredString(args, "song_id"),
      name: typeof args.song_name === "string" ? args.song_name : "Unknown track",
      artist: typeof args.artist === "string" ? args.artist : "Unknown artist",
      album: "",
      duration: 0,
      cover_url: null,
    });
  } else if (name === "clear_playlist") state.playlist = [];
  else if (name === "next_song" || name === "previous_song") {
    if (!state.playlist.length) throw new Error("Playlist is empty");
    const currentIndex = state.current_song ? state.playlist.findIndex((song) => song.id === state.current_song?.id) : -1;
    const delta = name === "next_song" ? 1 : -1;
    const index = (currentIndex + delta + state.playlist.length) % state.playlist.length;
    state.current_song = state.playlist[index];
    state.is_playing = true;
  } else if (name !== "get_playlist") throw new Error(`Unknown tool: ${name}`);

  return textResult(JSON.stringify({ ...state, playlist: state.playlist }));
}

async function handleRpc(request: RpcRequest, state: PlaybackState, env: Env): Promise<object | null> {
  if (!request.id && request.method === "notifications/initialized") return null;
  if (request.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
      serverInfo: { name: "xiaozhi-music-mcp", version: "2.0.0" },
    };
  }
  if (request.method === "tools/list") return { tools };
  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (!name) throw new Error("Tool name is required");
    return callTool(name, request.params?.arguments ?? {}, state, env);
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
  return { current_song: null, playlist: [], is_playing: false, volume: 50, position: 0 };
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

export class XiaozhiConnector extends DurableObject<Env> {
  private socket: WebSocket | null = null;
  private state: PlaybackState = newState();
  private connectedAt: string | null = null;
  private lastError: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    });
  }

  async ensureConnected(): Promise<{ connected: boolean; connectedAt: string | null; error: string | null }> {
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
      socket.addEventListener("message", (event) => this.ctx.waitUntil(this.handleMessage(event)));
      socket.addEventListener("close", () => this.ctx.waitUntil(this.scheduleReconnect("Connection closed")));
      socket.addEventListener("error", () => this.ctx.waitUntil(this.scheduleReconnect("WebSocket error")));
      await this.ctx.storage.deleteAlarm();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown connection error";
      this.lastError = detail.replaceAll(this.env.XIAOZHI_MCP_ENDPOINT, "[XIAOZHI_MCP_ENDPOINT]");
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
    return this.status();
  }

  status(): { connected: boolean; connectedAt: string | null; error: string | null } {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      connectedAt: this.connectedAt,
      error: this.lastError,
    };
  }

  async alarm(): Promise<void> {
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
      const result = await handleRpc(rpc, this.state, this.env);
      if (result !== null) socket.send(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: rpc?.id ?? null, error: { code: -32603, message } }));
    }
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
    const accessToken = url.searchParams.get("access_token") ?? "";
    if (!(await secretsEqual(accessToken, env.MCP_ACCESS_TOKEN))) return new Response("Unauthorized", { status: 401 });
    const connector = env.CONNECTOR.getByName("primary");
    const status = url.pathname === "/connect" ? await connector.ensureConnected() : await connector.status();
    return Response.json({ service: "xiaozhi-music-mcp", ...status });
  },
} satisfies ExportedHandler<Env>;
