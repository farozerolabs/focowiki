"""General-purpose extraction prompt owned and versioned by Focowiki."""

PROMPT_REVISION = "general-purpose-graph-v3"
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

Valid complete output example (the {record_delimiter} separators are required):
("entity"{tuple_delimiter}Example system{tuple_delimiter}SYSTEM{tuple_delimiter}A system named in the input){record_delimiter}("entity"{tuple_delimiter}Example dataset{tuple_delimiter}DATASET{tuple_delimiter}A dataset used by the system){record_delimiter}("relationship"{tuple_delimiter}Example system{tuple_delimiter}Example dataset{tuple_delimiter}uses{tuple_delimiter}1){record_delimiter}{completion_delimiter}

Do not use Markdown. Do not replace {record_delimiter} with line breaks. Every
record must end with {record_delimiter}, followed by {completion_delimiter}
after the final record.

Entity types: {entity_types}
Input text:
{input_text}
""".strip()
