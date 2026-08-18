"""Length-prefixed local standard-stream protocol."""

from __future__ import annotations

import io
import json
import struct
from typing import BinaryIO

from .contracts import AdapterContractError

MAXIMUM_FRAME_BYTES = 8 * 1024 * 1024


def read_frame(stream: BinaryIO, maximum_bytes: int = MAXIMUM_FRAME_BYTES) -> object | None:
    header = _read_exact(stream, 4, allow_eof=True)
    if header is None:
        return None
    length = struct.unpack(">I", header)[0]
    if length == 0 or length > maximum_bytes:
        raise AdapterContractError("INVALID_FRAME_LENGTH", "frame length is outside its bound")
    payload = _read_exact(stream, length, allow_eof=False)
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AdapterContractError("INVALID_FRAME_PAYLOAD", "frame payload is not valid JSON") from error


def write_frame(stream: BinaryIO, value: object, maximum_bytes: int = MAXIMUM_FRAME_BYTES) -> None:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > maximum_bytes:
        raise AdapterContractError("RESPONSE_TOO_LARGE", "response exceeds its frame bound")
    stream.write(struct.pack(">I", len(payload)))
    stream.write(payload)
    stream.flush()


def encode_frame(value: object) -> bytes:
    stream = io.BytesIO()
    write_frame(stream, value)
    return stream.getvalue()


def _read_exact(stream: BinaryIO, size: int, *, allow_eof: bool) -> bytes | None:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = stream.read(size - len(chunks))
        if not chunk:
            if allow_eof and not chunks:
                return None
            raise AdapterContractError("TRUNCATED_FRAME", "frame ended before its declared length")
        chunks.extend(chunk)
    return bytes(chunks)
