"""Normalize bounded GraphRAG records into Focowiki-owned records."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Callable
from typing import Any

from .contracts import AdapterContractError, AdapterLimits
from .prompt import (
    COMPLETION_DELIMITER,
    ENTITY_TYPES,
    EXTRACTION_PROMPT,
    PROMPT_REVISION,
    RECORD_DELIMITER,
    TUPLE_DELIMITER,
)


def canonical_manifest_hash(chunks: list[dict[str, str]]) -> str:
    canonical = json.dumps(
        [{"id": item["id"], "text": item["text"]} for item in sorted(chunks, key=lambda item: item["id"])],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def prepare_extraction(request: dict[str, Any], limits: AdapterLimits) -> dict[str, Any]:
    knowledge_base_id = _identifier(request.get("knowledgeBaseId"), "knowledgeBaseId")
    source = request.get("source")
    if not isinstance(source, dict):
        raise AdapterContractError("INVALID_SOURCE", "source must be an object")
    source_file_id = _identifier(source.get("sourceFileId"), "sourceFileId")
    source_revision_id = _identifier(source.get("sourceRevisionId"), "sourceRevisionId")
    chunks = _chunks(source.get("chunks"), limits)
    expected_hash = canonical_manifest_hash(chunks)
    if source.get("canonicalInputHash") != expected_hash:
        raise AdapterContractError("INPUT_HASH_MISMATCH", "canonical input hash does not match chunks")

    prompts = [
        {
            "chunkId": chunk["id"],
            "prompt": EXTRACTION_PROMPT.format(
                record_delimiter=RECORD_DELIMITER,
                completion_delimiter=COMPLETION_DELIMITER,
                tuple_delimiter=TUPLE_DELIMITER,
                entity_types=", ".join(ENTITY_TYPES),
                input_text=chunk["text"],
            ),
        }
        for chunk in chunks
    ]
    return {
        "knowledgeBaseId": knowledge_base_id,
        "sourceFileId": source_file_id,
        "sourceRevisionId": source_revision_id,
        "canonicalInputHash": expected_hash,
        "promptRevision": PROMPT_REVISION,
        "prompts": prompts,
    }


def normalize_extraction(
    request: dict[str, Any],
    parse: Callable[[str, str], tuple[list[dict[str, Any]], list[dict[str, Any]]]],
    limits: AdapterLimits,
) -> dict[str, Any]:
    knowledge_base_id = _identifier(request.get("knowledgeBaseId"), "knowledgeBaseId")
    source = request.get("source")
    if not isinstance(source, dict):
        raise AdapterContractError("INVALID_SOURCE", "source must be an object")
    source_file_id = _identifier(source.get("sourceFileId"), "sourceFileId")
    source_revision_id = _identifier(source.get("sourceRevisionId"), "sourceRevisionId")
    chunks = _chunks(source.get("chunks"), limits)
    expected_hash = canonical_manifest_hash(chunks)
    if source.get("canonicalInputHash") != expected_hash:
        raise AdapterContractError("INPUT_HASH_MISMATCH", "canonical input hash does not match chunks")
    outputs = request.get("modelOutputs")
    if not isinstance(outputs, list) or len(outputs) != len(chunks):
        raise AdapterContractError("INVALID_MODEL_OUTPUT", "one model output is required per chunk")

    chunk_ids = {chunk["id"] for chunk in chunks}
    raw_entities: list[dict[str, Any]] = []
    raw_relationships: list[dict[str, Any]] = []
    for chunk, output in zip(chunks, outputs, strict=True):
        if not isinstance(output, str) or len(output) > limits.maximum_model_output_characters:
            raise AdapterContractError("MODEL_OUTPUT_TOO_LARGE", "model output exceeds its bound")
        framed_output = output.split(COMPLETION_DELIMITER, maxsplit=1)[0]
        entities, relationships = parse(framed_output, chunk["id"])
        if "<|COMPLETE|>" not in output and not entities and not relationships:
            raise AdapterContractError("INVALID_MODEL_OUTPUT", "model output is incomplete")
        raw_entities.extend(entities)
        raw_relationships.extend(relationships)
        if len(raw_entities) > limits.maximum_entities:
            raise AdapterContractError("ENTITY_LIMIT_EXCEEDED", "entity count exceeds its bound")
        if len(raw_relationships) > limits.maximum_relationships:
            raise AdapterContractError("RELATIONSHIP_LIMIT_EXCEEDED", "relationship count exceeds its bound")

    entities_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    mentions: list[dict[str, Any]] = []
    for raw in raw_entities:
        title = _bounded_text(raw.get("title"), "entity title", limits)
        entity_type = _bounded_text(raw.get("type"), "entity type", limits).upper()
        description = _bounded_text(raw.get("description"), "entity description", limits)
        source_id = _owned_evidence(raw.get("source_id"), chunk_ids)
        normalized_name = _normalize_name(title)
        key = (normalized_name, entity_type)
        entity_id = _stable_id("entity", knowledge_base_id, normalized_name, entity_type)
        current = entities_by_key.get(key)
        if current is None:
            current = {
                "entityId": entity_id,
                "canonicalName": title.strip(),
                "normalizedName": normalized_name,
                "entityType": entity_type,
                "descriptions": [],
            }
            entities_by_key[key] = current
        if description not in current["descriptions"]:
            current["descriptions"].append(description)
        mentions.append({
            "mentionId": _stable_id("mention", source_revision_id, source_id, entity_id),
            "entityId": entity_id,
            "sourceFileId": source_file_id,
            "sourceRevisionId": source_revision_id,
            "evidenceId": source_id,
        })

    relationships: list[dict[str, Any]] = []
    relationship_diagnostics: dict[str, int] = {}
    known_by_name: dict[str, list[dict[str, Any]]] = {}
    for entity in entities_by_key.values():
        known_by_name.setdefault(entity["normalizedName"], []).append(entity)
    for raw in raw_relationships:
        source_name = _normalize_name(_bounded_text(raw.get("source"), "relationship source", limits))
        target_name = _normalize_name(_bounded_text(raw.get("target"), "relationship target", limits))
        source_candidates = known_by_name.get(source_name, [])
        target_candidates = known_by_name.get(target_name, [])
        if len(source_candidates) != 1 or len(target_candidates) != 1:
            _increment_diagnostic(relationship_diagnostics, "RELATIONSHIP_ENDPOINT_UNRESOLVED")
            continue
        source_id = _owned_evidence(raw.get("source_id"), chunk_ids)
        description = _bounded_text(raw.get("description"), "relationship description", limits)
        weight = raw.get("weight", 1.0)
        if not isinstance(weight, (int, float)) or isinstance(weight, bool) or not math.isfinite(weight):
            raise AdapterContractError("INVALID_RELATIONSHIP_WEIGHT", "relationship weight must be finite")
        source_entity_id = source_candidates[0]["entityId"]
        target_entity_id = target_candidates[0]["entityId"]
        if source_entity_id == target_entity_id:
            _increment_diagnostic(relationship_diagnostics, "RELATIONSHIP_SELF_REFERENCE")
            continue
        relationships.append({
            "relationshipId": _stable_id(
                "relationship", source_revision_id, source_entity_id, target_entity_id, source_id, description
            ),
            "sourceEntityId": source_entity_id,
            "targetEntityId": target_entity_id,
            "description": description,
            "weight": float(weight),
            "sourceFileId": source_file_id,
            "sourceRevisionId": source_revision_id,
            "evidenceId": source_id,
        })

    entities = sorted(entities_by_key.values(), key=lambda item: item["entityId"])
    for entity in entities:
        entity["descriptions"].sort()
    evidence_by_entity: dict[str, list[str]] = {}
    for mention in mentions:
        evidence_by_entity.setdefault(mention["entityId"], []).append(mention["evidenceId"])
    summaries = [{
        "summaryId": _stable_id("summary", source_revision_id, entity["entityId"]),
        "targetKind": "entity",
        "targetId": entity["entityId"],
        "text": " ".join(entity["descriptions"]),
        "sourceFileId": source_file_id,
        "sourceRevisionId": source_revision_id,
        "evidenceIds": sorted(set(evidence_by_entity.get(entity["entityId"], []))),
    } for entity in entities]
    return {
        "entities": entities,
        "mentions": sorted(mentions, key=lambda item: item["mentionId"]),
        "relationships": sorted(relationships, key=lambda item: item["relationshipId"]),
        "summaries": summaries,
        "communities": [],
        "usage": {
            "inputChunkCount": len(chunks),
            "entityCount": len(entities),
            "mentionCount": len(mentions),
            "relationshipCount": len(relationships),
        },
        "diagnostics": [{
            "code": code,
            "severity": "warning",
            "count": relationship_diagnostics[code],
        } for code in sorted(relationship_diagnostics)],
    }


def _increment_diagnostic(diagnostics: dict[str, int], code: str) -> None:
    diagnostics[code] = diagnostics.get(code, 0) + 1


def _chunks(value: object, limits: AdapterLimits) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value or len(value) > limits.maximum_chunks:
        raise AdapterContractError("INVALID_CHUNKS", "chunks must be a non-empty bounded array")
    result = []
    seen = set()
    for item in value:
        if not isinstance(item, dict):
            raise AdapterContractError("INVALID_CHUNKS", "each chunk must be an object")
        chunk_id = _identifier(item.get("id"), "chunk id")
        text = item.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > limits.maximum_chunk_characters:
            raise AdapterContractError("INVALID_CHUNK_TEXT", "chunk text is empty or exceeds its bound")
        if chunk_id in seen:
            raise AdapterContractError("DUPLICATE_CHUNK", "chunk identifiers must be unique")
        seen.add(chunk_id)
        result.append({"id": chunk_id, "text": text})
    return result


def _identifier(value: object, field: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 256 or not re.fullmatch(r"[A-Za-z0-9._:-]+", value):
        raise AdapterContractError("INVALID_IDENTIFIER", f"{field} is invalid")
    return value


def _bounded_text(value: object, field: str, limits: AdapterLimits) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limits.maximum_field_characters:
        raise AdapterContractError("INVALID_RECORD", f"{field} is empty or exceeds its bound")
    if re.search(r"\)\s*\(\s*[\"']?(?:entity|relationship)[\"']?", value, re.IGNORECASE):
        raise AdapterContractError("INVALID_RECORD", f"{field} contains invalid record framing")
    return value.strip()


def _owned_evidence(value: object, chunk_ids: set[str]) -> str:
    if not isinstance(value, str) or value not in chunk_ids:
        raise AdapterContractError("INVALID_EVIDENCE_OWNER", "record evidence is outside the input manifest")
    return value


def _normalize_name(value: str) -> str:
    return " ".join(value.casefold().split())


def _stable_id(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()
