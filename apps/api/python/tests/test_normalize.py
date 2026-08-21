import unittest

from graphrag_adapter.contracts import AdapterContractError, AdapterLimits
from graphrag_adapter.normalize import canonical_manifest_hash, normalize_extraction


def parser(output, source_id):
    if output.startswith("malformed"):
        return ([], [])
    if output.startswith("orphan"):
        return ([{"title": "A", "type": "CONCEPT", "description": "A", "source_id": source_id}], [{"source": "A", "target": "B", "description": "unsupported", "weight": 1, "source_id": source_id}])
    if output.startswith("self"):
        return ([{"title": "A", "type": "CONCEPT", "description": "A", "source_id": source_id}], [{"source": "A", "target": "A", "description": "self", "weight": 1, "source_id": source_id}])
    return (
        [
            {"title": "Shared Concept", "type": "CONCEPT", "description": "First", "source_id": source_id},
            {"title": "Related System", "type": "SYSTEM", "description": "Second", "source_id": source_id},
        ],
        [{"source": "Shared Concept", "target": "Related System", "description": "The text connects them", "weight": 2, "source_id": source_id}],
    )


def request(outputs=None):
    chunks = [{"id": "chunk-b", "text": "Second"}, {"id": "chunk-a", "text": "First"}]
    return {
        "knowledgeBaseId": "kb-1",
        "source": {
            "sourceFileId": "file-1",
            "sourceRevisionId": "revision-1",
            "chunks": chunks,
            "canonicalInputHash": canonical_manifest_hash(chunks),
        },
        "modelOutputs": outputs or ["valid<|COMPLETE|>", "valid<|COMPLETE|>"],
    }


class NormalizeTest(unittest.TestCase):
    def test_is_deterministic_and_owns_evidence_by_source_revision(self):
        first = normalize_extraction(request(), parser, AdapterLimits())
        second = normalize_extraction(request(), parser, AdapterLimits())
        self.assertEqual(first, second)
        self.assertEqual(len(first["entities"]), 2)
        self.assertEqual(len(first["mentions"]), 4)
        self.assertEqual(len(first["summaries"]), 2)
        self.assertTrue(all(item["sourceRevisionId"] == "revision-1" for item in first["mentions"]))
        self.assertTrue(all(item["evidenceId"] in {"chunk-a", "chunk-b"} for item in first["relationships"]))

    def test_rejects_hash_mismatch_and_drops_relationship_without_endpoint(self):
        invalid = request()
        invalid["source"]["canonicalInputHash"] = "0" * 64
        with self.assertRaisesRegex(AdapterContractError, "hash"):
            normalize_extraction(invalid, parser, AdapterLimits())

        normalized = normalize_extraction(
            request(["orphan<|COMPLETE|>", "orphan<|COMPLETE|>"]),
            parser,
            AdapterLimits(),
        )
        self.assertEqual(len(normalized["entities"]), 1)
        self.assertEqual(len(normalized["mentions"]), 2)
        self.assertEqual(normalized["relationships"], [])
        self.assertEqual(normalized["diagnostics"], [{
            "code": "RELATIONSHIP_ENDPOINT_UNRESOLVED",
            "severity": "warning",
            "count": 2,
        }])

        self_relationship = normalize_extraction(
            request(["self<|COMPLETE|>", "self<|COMPLETE|>"]),
            parser,
            AdapterLimits(),
        )
        self.assertEqual(self_relationship["relationships"], [])
        self.assertEqual(self_relationship["diagnostics"], [{
            "code": "RELATIONSHIP_SELF_REFERENCE",
            "severity": "warning",
            "count": 2,
        }])

    def test_rejects_oversized_model_output_and_unowned_evidence(self):
        with self.assertRaisesRegex(AdapterContractError, "bound"):
            normalize_extraction(request(["12345", "ok"]), parser, AdapterLimits(maximum_model_output_characters=4))

        with self.assertRaisesRegex(AdapterContractError, "incomplete"):
            normalize_extraction(request(["malformed", "malformed"]), parser, AdapterLimits())

        def unowned(_output, _source_id):
            return ([{"title": "A", "type": "CONCEPT", "description": "A", "source_id": "foreign"}], [])

        with self.assertRaisesRegex(AdapterContractError, "outside"):
            normalize_extraction(request(), unowned, AdapterLimits())

    def test_accepts_parseable_tuple_records_when_the_model_omits_the_completion_marker(self):
        normalized = normalize_extraction(
            request(["valid tuple records", "valid tuple records"]),
            parser,
            AdapterLimits(),
        )
        self.assertEqual(len(normalized["entities"]), 2)
        self.assertEqual(len(normalized["relationships"]), 2)

    def test_repeated_work_does_not_retain_prior_manifests(self):
        expected = normalize_extraction(request(), parser, AdapterLimits())
        for _ in range(250):
            self.assertEqual(normalize_extraction(request(), parser, AdapterLimits()), expected)

    def test_rejects_record_headers_inside_normalized_fields(self):
        def corrupted(_output, source_id):
            return ([{
                "title": "Atlas",
                "type": "PROJECT",
                "description": 'Maintains a glossary)("entity"',
                "source_id": source_id,
            }], [])

        with self.assertRaisesRegex(AdapterContractError, "record framing"):
            normalize_extraction(request(), corrupted, AdapterLimits())


if __name__ == "__main__":
    unittest.main()
