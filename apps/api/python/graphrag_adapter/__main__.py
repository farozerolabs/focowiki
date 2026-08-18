"""Persistent adapter process entry point."""

from __future__ import annotations

import sys

from .contracts import RESPONSE_SCHEMA_VERSION, AdapterContractError
from .protocol import read_frame, write_frame
from .runtime import execute_request


def main() -> int:
    while True:
        try:
            request = read_frame(sys.stdin.buffer)
            if request is None:
                return 0
            response = execute_request(request)
        except AdapterContractError as error:
            response = {
                "schemaVersion": RESPONSE_SCHEMA_VERSION,
                "requestId": "unknown",
                "ok": False,
                "error": {"code": error.code, "message": str(error)},
            }
        try:
            write_frame(sys.stdout.buffer, response)
        except AdapterContractError:
            return 2


if __name__ == "__main__":
    raise SystemExit(main())
