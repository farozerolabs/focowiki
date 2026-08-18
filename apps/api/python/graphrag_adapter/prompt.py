"""General-purpose extraction prompt owned and versioned by Focowiki."""

PROMPT_REVISION = "general-purpose-graph-v2"
TUPLE_DELIMITER = "<|>"
RECORD_DELIMITER = "##"
COMPLETION_DELIMITER = "<|COMPLETE|>"
ENTITY_TYPES = [
    "ORGANIZATION",
    "PERSON",
    "LOCATION",
    "EVENT",
    "CONCEPT",
    "PRODUCT",
    "PROCESS",
    "SYSTEM",
    "DATASET",
    "DOCUMENT",
    "OTHER",
]

EXTRACTION_PROMPT = """
Extract only entities and relationships that are explicitly supported by the
input text. Use the supplied entity types. Preserve short evidence-grounded
descriptions and do not infer missing facts. Emit GraphRAG tuple records using
{record_delimiter} between records and {completion_delimiter} at the end.

Entity: ("entity"{tuple_delimiter}<name>{tuple_delimiter}<type>{tuple_delimiter}<description>)
Relationship: ("relationship"{tuple_delimiter}<source>{tuple_delimiter}<target>{tuple_delimiter}<description>{tuple_delimiter}<weight>)

Entity types: {entity_types}
Input text:
{input_text}
""".strip()
