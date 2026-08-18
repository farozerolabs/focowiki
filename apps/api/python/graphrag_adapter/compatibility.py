"""Pinned GraphRAG API and output compatibility validation."""

from __future__ import annotations

import importlib.metadata
import inspect
from typing import Any

from .contracts import AdapterContractError, SUPPORTED_GRAPHRAG_VERSION


def assert_graphrag_compatible() -> dict[str, Any]:
    try:
        version = importlib.metadata.version("graphrag")
        from graphrag.index.operations.cluster_graph import cluster_graph
        from graphrag.index.operations.extract_graph.graph_extractor import (
            GraphExtractor,
            RECORD_DELIMITER,
            TUPLE_DELIMITER,
        )
        from .prompt import (
            RECORD_DELIMITER as OWNED_RECORD_DELIMITER,
            TUPLE_DELIMITER as OWNED_TUPLE_DELIMITER,
        )
    except (ImportError, importlib.metadata.PackageNotFoundError) as error:
        raise AdapterContractError(
            "GRAPHRAG_UNAVAILABLE", "the pinned GraphRAG runtime is unavailable"
        ) from error

    if version != SUPPORTED_GRAPHRAG_VERSION:
        raise AdapterContractError(
            "GRAPHRAG_VERSION_MISMATCH",
            f"expected GraphRAG {SUPPORTED_GRAPHRAG_VERSION}, received {version}",
        )

    parser_parameters = tuple(inspect.signature(GraphExtractor._process_result).parameters)
    cluster_parameters = tuple(inspect.signature(cluster_graph).parameters)
    if parser_parameters != (
        "self",
        "result",
        "source_id",
        "tuple_delimiter",
        "record_delimiter",
    ):
        raise AdapterContractError(
            "GRAPHRAG_API_MISMATCH", "GraphRAG extraction parser signature changed"
        )
    if cluster_parameters != ("edges", "max_cluster_size", "use_lcc", "seed"):
        raise AdapterContractError(
            "GRAPHRAG_API_MISMATCH", "GraphRAG community primitive signature changed"
        )
    if (
        RECORD_DELIMITER != OWNED_RECORD_DELIMITER
        or TUPLE_DELIMITER != OWNED_TUPLE_DELIMITER
    ):
        raise AdapterContractError(
            "GRAPHRAG_API_MISMATCH", "GraphRAG extraction delimiters changed"
        )
    return {
        "graphragVersion": version,
        "extractionParser": list(parser_parameters),
        "communityPrimitive": list(cluster_parameters),
    }
