"""Bounded adapter contracts independent from GraphRAG SDK DTOs."""

from __future__ import annotations

from dataclasses import dataclass

REQUEST_SCHEMA_VERSION = "focowiki.graphrag.request.v1"
RESPONSE_SCHEMA_VERSION = "focowiki.graphrag.response.v1"
ADAPTER_VERSION = "1.0.0"
SUPPORTED_GRAPHRAG_VERSION = "3.1.1"


class AdapterContractError(ValueError):
    """Safe validation error surfaced at the Node/Python boundary."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class AdapterLimits:
    maximum_chunks: int = 32
    maximum_chunk_characters: int = 64_000
    maximum_model_output_characters: int = 256_000
    maximum_entities: int = 2_000
    maximum_relationships: int = 4_000
    maximum_field_characters: int = 16_000
    maximum_edges_for_community: int = 10_000
    maximum_community_size: int = 100

    @classmethod
    def from_request(cls, value: object) -> "AdapterLimits":
        if value is None:
            return cls()
        if not isinstance(value, dict):
            raise AdapterContractError("INVALID_LIMITS", "limits must be an object")
        defaults = cls()
        fields = {}
        for name in defaults.__dataclass_fields__:
            raw = value.get(name, getattr(defaults, name))
            if not isinstance(raw, int) or isinstance(raw, bool) or raw <= 0:
                raise AdapterContractError("INVALID_LIMITS", f"{name} must be a positive integer")
            fields[name] = raw
        return cls(**fields)
