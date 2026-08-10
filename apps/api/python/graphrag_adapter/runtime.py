"""Execute bounded adapter requests against selected GraphRAG primitives."""

from __future__ import annotations

import hashlib
from typing import Any

from .compatibility import assert_graphrag_compatible
from .contracts import (
    ADAPTER_VERSION,
    REQUEST_SCHEMA_VERSION,
    RESPONSE_SCHEMA_VERSION,
    AdapterContractError,
    AdapterLimits,
)
from .normalize import normalize_extraction, prepare_extraction
from .prompt import ENTITY_TYPES, PROMPT_REVISION


def execute_request(request: object) -> dict[str, Any]:
    request_id = "unknown"
    try:
        if not isinstance(request, dict):
            raise AdapterContractError("INVALID_REQUEST", "request must be an object")
        request_id = _request_id(request.get("requestId"))
        if request.get("schemaVersion") != REQUEST_SCHEMA_VERSION:
            raise AdapterContractError("UNSUPPORTED_REQUEST_SCHEMA", "request schema is unsupported")
        operation = request.get("operation")
        limits = AdapterLimits.from_request(request.get("limits"))
        if operation == "health":
            compatibility = assert_graphrag_compatible()
            result = {
                "adapterVersion": ADAPTER_VERSION,
                "promptRevision": PROMPT_REVISION,
                "entityTypes": ENTITY_TYPES,
                "compatibility": compatibility,
            }
        elif operation == "prepare":
            assert_graphrag_compatible()
            result = prepare_extraction(request, limits)
        elif operation == "extract":
            result = normalize_extraction(request, _parse_extraction, limits)
        elif operation == "cluster":
            result = _cluster(request, limits)
        else:
            raise AdapterContractError("UNSUPPORTED_OPERATION", "operation is unsupported")
        return _response(request_id, True, result=result)
    except AdapterContractError as error:
        return _response(
            request_id,
            False,
            error={"code": error.code, "message": str(error)},
        )
    except Exception:
        return _response(
            request_id,
            False,
            error={"code": "ADAPTER_INTERNAL_ERROR", "message": "adapter request failed"},
        )


def _parse_extraction(output: str, source_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    from graphrag.index.operations.extract_graph.graph_extractor import (
        GraphExtractor,
        RECORD_DELIMITER,
        TUPLE_DELIMITER,
    )

    parser = object.__new__(GraphExtractor)
    entities, relationships = GraphExtractor._process_result(
        parser, output, source_id, TUPLE_DELIMITER, RECORD_DELIMITER
    )
    return entities.to_dict(orient="records"), relationships.to_dict(orient="records")


def _cluster(request: dict[str, Any], limits: AdapterLimits) -> dict[str, Any]:
    import pandas as pd
    from graphrag.index.operations.cluster_graph import cluster_graph

    knowledge_base_id = _request_id(request.get("knowledgeBaseId"))
    partition_id = _request_id(request.get("partitionId"))
    raw_edges = request.get("edges")
    if not isinstance(raw_edges, list) or len(raw_edges) > limits.maximum_edges_for_community:
        raise AdapterContractError("INVALID_COMMUNITY_EDGES", "community edges exceed their bound")
    edges = []
    for item in raw_edges:
        if not isinstance(item, dict):
            raise AdapterContractError("INVALID_COMMUNITY_EDGE", "community edge must be an object")
        source = _request_id(item.get("sourceEntityId"))
        target = _request_id(item.get("targetEntityId"))
        weight = item.get("weight", 1.0)
        if not isinstance(weight, (int, float)) or isinstance(weight, bool):
            raise AdapterContractError("INVALID_COMMUNITY_EDGE", "community edge weight is invalid")
        edges.append({"source": source, "target": target, "weight": float(weight)})
    if not edges:
        return {"communities": [], "usage": {"edgeCount": 0, "communityCount": 0}, "diagnostics": []}
    raw = cluster_graph(
        pd.DataFrame(sorted(edges, key=lambda item: (item["source"], item["target"]))),
        max_cluster_size=limits.maximum_community_size,
        use_lcc=False,
        seed=0,
    )
    communities = []
    for level, cluster_id, parent_id, members in raw:
        sorted_members = sorted(str(member) for member in members)
        identity = hashlib.sha256(
            "\x1f".join([knowledge_base_id, partition_id, str(level), *sorted_members]).encode("utf-8")
        ).hexdigest()
        communities.append({
            "communityId": identity,
            "level": int(level),
            "parentCluster": int(parent_id),
            "members": sorted_members,
        })
    communities.sort(key=lambda item: (item["level"], item["communityId"]))
    return {
        "communities": communities,
        "usage": {"edgeCount": len(edges), "communityCount": len(communities)},
        "diagnostics": [],
    }


def _request_id(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 256:
        raise AdapterContractError("INVALID_REQUEST_ID", "request identifier is invalid")
    return value


def _response(
    request_id: str,
    ok: bool,
    *,
    result: dict[str, Any] | None = None,
    error: dict[str, str] | None = None,
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "schemaVersion": RESPONSE_SCHEMA_VERSION,
        "requestId": request_id,
        "ok": ok,
    }
    if result is not None:
        value["result"] = result
    if error is not None:
        value["error"] = error
    return value
