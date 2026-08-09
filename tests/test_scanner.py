import unittest

from ctv_server.scanner import parse_ffprobe


class ParseFfprobeTests(unittest.TestCase):
    def test_uses_video_stream_duration_when_format_duration_is_missing(self):
        info = parse_ffprobe({
            "format": {},
            "streams": [{
                "codec_type": "video",
                "codec_name": "h264",
                "duration": "53.5",
                "r_frame_rate": "25/1",
            }],
        })

        self.assertEqual(info["duration"], 53.5)
        self.assertEqual(info["fps"], 25.0)

    def test_uses_stream_time_base_when_duration_is_na(self):
        info = parse_ffprobe({
            "format": {"duration": "N/A"},
            "streams": [{
                "codec_type": "video",
                "duration": "N/A",
                "duration_ts": "90000",
                "time_base": "1/90000",
                "r_frame_rate": "N/A",
            }],
        })

        self.assertEqual(info["duration"], 1.0)
        self.assertEqual(info["fps"], 0.0)

    def test_invalid_duration_values_do_not_raise(self):
        info = parse_ffprobe({
            "format": {"duration": "inf"},
            "streams": [{
                "codec_type": "video",
                "duration_ts": "bad",
                "time_base": "bad",
                "r_frame_rate": "1/0",
            }],
        })

        self.assertEqual(info["duration"], 0.0)
        self.assertEqual(info["fps"], 0.0)


if __name__ == "__main__":
    unittest.main()
