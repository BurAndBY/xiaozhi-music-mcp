import asyncio
import os
from typing import Any, Dict, List, Optional

from yandex_music import Client


class YandexMusicProvider:
    """Async wrapper around the synchronous yandex-music client."""

    def __init__(self) -> None:
        self._client: Optional[Client] = None
        self._tracks: Dict[str, Any] = {}

    def _get_client(self) -> Client:
        if self._client is None:
            token = os.getenv("YANDEX_MUSIC_TOKEN")
            if not token:
                raise RuntimeError(
                    "YANDEX_MUSIC_TOKEN is not configured. See https://ym.marshal.dev/token/."
                )
            self._client = Client(token).init()
        return self._client

    @staticmethod
    def _track_key(track: Any) -> str:
        album_id = track.albums[0].id if getattr(track, "albums", None) else None
        return f"{track.id}:{album_id}" if album_id else str(track.id)

    @classmethod
    def _serialize_track(cls, track: Any) -> Dict[str, Any]:
        artists = ", ".join(artist.name for artist in (track.artists or []))
        album = track.albums[0].title if getattr(track, "albums", None) else ""
        duration_ms = track.duration_ms or 0
        return {
            "id": cls._track_key(track),
            "name": track.title,
            "artist": artists,
            "album": album,
            "duration": round(duration_ms / 1000),
            "cover_url": track.get_cover_url("400x400") if track.cover_uri else None,
        }

    def _search_sync(self, query: str, limit: int) -> List[Dict[str, Any]]:
        result = self._get_client().search(query, type_="track")
        tracks = result.tracks.results if result and result.tracks else []
        selected = tracks[:limit]
        for track in selected:
            self._tracks[self._track_key(track)] = track
        return [self._serialize_track(track) for track in selected]

    async def search(self, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        return await asyncio.to_thread(self._search_sync, query, max(1, min(limit, 50)))

    def _get_stream_url_sync(self, track_id: str) -> str:
        track = self._tracks.get(track_id)
        if track is None:
            tracks = self._get_client().tracks([track_id])
            if not tracks:
                raise RuntimeError(f"Yandex Music track not found: {track_id}")
            track = tracks[0]
            self._tracks[track_id] = track

        infos = track.get_download_info(get_direct_links=True)
        if not infos:
            raise RuntimeError("No downloadable audio is available for this track")

        info = max(
            infos,
            key=lambda item: (
                item.codec == "mp3",
                item.bitrate_in_kbps or 0,
            ),
        )
        if not info.direct_link:
            raise RuntimeError("Yandex Music did not return a direct audio URL")
        return info.direct_link

    async def get_stream_url(self, track_id: str) -> str:
        return await asyncio.to_thread(self._get_stream_url_sync, track_id)


provider = YandexMusicProvider()
