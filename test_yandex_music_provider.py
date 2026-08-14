import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from yandex_music_provider import YandexMusicProvider


class YandexMusicProviderTests(unittest.TestCase):
    @patch.dict("os.environ", {"YANDEX_MUSIC_TOKEN": "test-token"})
    @patch("yandex_music_provider.Client")
    def test_search_maps_tracks(self, client_class: Mock) -> None:
        track = SimpleNamespace(
            id="123",
            title="Song",
            artists=[SimpleNamespace(name="Artist")],
            albums=[SimpleNamespace(id="456", title="Album")],
            duration_ms=201000,
            cover_uri="cover/%%",
            get_cover_url=Mock(return_value="https://cover/400x400"),
        )
        client = client_class.return_value.init.return_value
        client.search.return_value = SimpleNamespace(
            tracks=SimpleNamespace(results=[track])
        )

        provider = YandexMusicProvider()
        results = provider._search_sync("Song", 10)

        self.assertEqual(results[0]["id"], "123:456")
        self.assertEqual(results[0]["artist"], "Artist")
        self.assertEqual(results[0]["duration"], 201)

    @patch.dict("os.environ", {"YANDEX_MUSIC_TOKEN": "test-token"})
    @patch("yandex_music_provider.Client")
    def test_stream_url_prefers_high_bitrate_mp3(self, client_class: Mock) -> None:
        low = SimpleNamespace(codec="mp3", bitrate_in_kbps=192, direct_link="low")
        high = SimpleNamespace(codec="mp3", bitrate_in_kbps=320, direct_link="high")
        track = Mock()
        track.get_download_info.return_value = [low, high]
        client = client_class.return_value.init.return_value
        client.tracks.return_value = [track]

        provider = YandexMusicProvider()

        self.assertEqual(provider._get_stream_url_sync("123:456"), "high")
        track.get_download_info.assert_called_once_with(get_direct_links=True)


if __name__ == "__main__":
    unittest.main()
