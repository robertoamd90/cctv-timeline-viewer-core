import tempfile
import unittest
from unittest.mock import patch

from ctv_server import thumbnailer


class ThumbnailCommandTests(unittest.TestCase):
    def test_thumbnail_generation_uses_one_decoder_filter_and_encoder_thread(self):
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(thumbnailer, "THUMBNAIL_DIR", tmp), \
             patch.object(thumbnailer.subprocess, "run") as run:
            thumbnailer.generate_thumbnail(7, "/video/input.mp4")

        command = run.call_args.args[0]
        self.assertEqual(command[command.index("-filter_threads") + 1], "1")
        self.assertEqual(command.count("-threads"), 2)
        self.assertTrue(all(
            command[index + 1] == "1"
            for index, value in enumerate(command) if value == "-threads"
        ))
        self.assertLess(command.index("-filter_threads"), command.index("-i"))
        self.assertLess(command.index("-threads"), command.index("-i"))


if __name__ == "__main__":
    unittest.main()
