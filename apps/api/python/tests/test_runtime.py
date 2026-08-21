import unittest
from unittest.mock import patch

from graphrag_adapter.contracts import REQUEST_SCHEMA_VERSION, RESPONSE_SCHEMA_VERSION
from graphrag_adapter.prompt import ENTITY_TYPES, EXTRACTION_PROMPT
from graphrag_adapter.runtime import execute_request
from graphrag_adapter.normalize import canonical_manifest_hash


class RuntimeTest(unittest.TestCase):
    def test_health_exposes_only_owned_contract_metadata(self):
        with patch("graphrag_adapter.runtime.assert_graphrag_compatible", return_value={"graphragVersion": "3.1.1"}):
            response = execute_request({"schemaVersion": REQUEST_SCHEMA_VERSION, "requestId": "health-1", "operation": "health"})
        self.assertEqual(response["schemaVersion"], RESPONSE_SCHEMA_VERSION)
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["compatibility"]["graphragVersion"], "3.1.1")

    def test_prompt_and_entity_types_are_general_purpose(self):
        combined = (EXTRACTION_PROMPT + " " + " ".join(ENTITY_TYPES)).lower()
        for forbidden in ("court", "statute", "jurisdiction", "plaintiff", "defendant"):
            self.assertNotIn(forbidden, combined)

    def test_diagnostics_do_not_echo_malformed_input(self):
        response = execute_request({"schemaVersion": REQUEST_SCHEMA_VERSION, "requestId": "safe-1", "operation": "unknown", "apiKey": "secret-value"})
        self.assertFalse(response["ok"])
        self.assertNotIn("secret-value", str(response))

    def test_prepares_versioned_general_purpose_prompts(self):
        chunks = [{"id": "chunk-0001", "text": "A system uses a dataset."}]
        request = {
            "schemaVersion": REQUEST_SCHEMA_VERSION,
            "requestId": "prepare-1",
            "operation": "prepare",
            "knowledgeBaseId": "kb-1",
            "source": {
                "sourceFileId": "file-1",
                "sourceRevisionId": "revision-1",
                "chunks": chunks,
                "canonicalInputHash": canonical_manifest_hash(chunks),
            },
        }
        with patch("graphrag_adapter.runtime.assert_graphrag_compatible", return_value={"graphragVersion": "3.1.1"}):
            response = execute_request(request)
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["promptRevision"], "general-purpose-graph-v3")
        self.assertEqual(response["result"]["prompts"][0]["chunkId"], "chunk-0001")
        self.assertIn("A system uses a dataset.", response["result"]["prompts"][0]["prompt"])
        self.assertIn(")##(\"entity\"<|>", response["result"]["prompts"][0]["prompt"].replace("\n", ""))

    def test_rejects_tuple_headers_absorbed_into_entity_descriptions(self):
        chunks = [{"id": "chunk-0001", "text": "Atlas maintains a glossary."}]
        response = execute_request({
            "schemaVersion": REQUEST_SCHEMA_VERSION,
            "requestId": "extract-corrupt-1",
            "operation": "extract",
            "knowledgeBaseId": "kb-1",
            "source": {
                "sourceFileId": "file-1",
                "sourceRevisionId": "revision-1",
                "chunks": chunks,
                "canonicalInputHash": canonical_manifest_hash(chunks),
            },
            "modelOutputs": [
                '("entity"<|>Atlas<|>PROJECT<|>Maintains a glossary)\n'
                '("entity"<|>Glossary<|>DOCUMENT<|>Shared terms)\n'
                '##<|COMPLETE|>'
            ],
        })
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "INVALID_RECORD")


if __name__ == "__main__":
    unittest.main()
