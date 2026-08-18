import io
import json
import struct
import unittest

from graphrag_adapter.contracts import AdapterContractError
from graphrag_adapter.protocol import encode_frame, read_frame


class ProtocolTest(unittest.TestCase):
    def test_round_trips_a_length_prefixed_message(self):
        payload = {"schemaVersion": "test", "value": "knowledge"}
        self.assertEqual(read_frame(io.BytesIO(encode_frame(payload))), payload)

    def test_rejects_oversized_and_truncated_frames(self):
        with self.assertRaisesRegex(AdapterContractError, "outside its bound"):
            read_frame(io.BytesIO(struct.pack(">I", 33)), maximum_bytes=32)
        with self.assertRaisesRegex(AdapterContractError, "declared length"):
            read_frame(io.BytesIO(struct.pack(">I", 4) + b"{}"))

    def test_rejects_malformed_json_without_echoing_payload(self):
        secret = b'{"apiKey":"secret-value"'
        with self.assertRaises(AdapterContractError) as caught:
            read_frame(io.BytesIO(struct.pack(">I", len(secret)) + secret))
        self.assertNotIn("secret-value", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
