"""Build-time compatibility check for the pinned GraphRAG boundary."""

from __future__ import annotations

import json

from graphrag_adapter.contracts import REQUEST_SCHEMA_VERSION
from graphrag_adapter.normalize import canonical_manifest_hash
from graphrag_adapter.runtime import execute_request


def main() -> int:
    health = execute_request({
        "schemaVersion": REQUEST_SCHEMA_VERSION,
        "requestId": "build-health",
        "operation": "health",
    })
    _require_ok(health)

    chunks = [{"id": "chunk-1", "text": "Alpha connects to Beta."}]
    extraction = execute_request({
        "schemaVersion": REQUEST_SCHEMA_VERSION,
        "requestId": "build-extraction",
        "operation": "extract",
        "knowledgeBaseId": "compatibility-kb",
        "source": {
            "sourceFileId": "compatibility-file",
            "sourceRevisionId": "compatibility-revision",
            "canonicalInputHash": canonical_manifest_hash(chunks),
            "chunks": chunks,
        },
        "modelOutputs": [
            '("entity"<|>Alpha<|>CONCEPT<|>A first concept)##'
            '("entity"<|>Beta<|>CONCEPT<|>A second concept)##'
            '("relationship"<|>Alpha<|>Beta<|>Alpha connects to Beta<|>1)##'
            '<|COMPLETE|>'
        ],
    })
    _require_ok(extraction)
    result = extraction["result"]
    if (
        len(result.get("entities", [])) != 2
        or len(result.get("mentions", [])) != 2
        or len(result.get("relationships", [])) != 1
    ):
        raise RuntimeError("normalized extraction output shape changed")

    cluster = execute_request({
        "schemaVersion": REQUEST_SCHEMA_VERSION,
        "requestId": "build-cluster",
        "operation": "cluster",
        "knowledgeBaseId": "compatibility-kb",
        "partitionId": "compatibility-partition",
        "edges": [
            {"sourceEntityId": "entity-a", "targetEntityId": "entity-b", "weight": 1},
            {"sourceEntityId": "entity-b", "targetEntityId": "entity-c", "weight": 1},
        ],
    })
    _require_ok(cluster)
    if not cluster["result"].get("communities"):
        raise RuntimeError("normalized community output shape changed")

    print(json.dumps({
        "ok": True,
        "adapterVersion": health["result"]["adapterVersion"],
        "graphragVersion": health["result"]["compatibility"]["graphragVersion"],
        "entityCount": len(result["entities"]),
        "relationshipCount": len(result["relationships"]),
        "communityCount": len(cluster["result"]["communities"]),
    }, separators=(",", ":")))
    return 0


def _require_ok(response: dict) -> None:
    if not response.get("ok"):
        error = response.get("error", {})
        raise RuntimeError(f"{error.get('code', 'UNKNOWN')}: {error.get('message', 'adapter failed')}")


if __name__ == "__main__":
    raise SystemExit(main())
