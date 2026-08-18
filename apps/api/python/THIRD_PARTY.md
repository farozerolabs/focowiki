# Python runtime dependencies

The unified backend worker Python runtime is locked for Python 3.12 by
`requirements.lock`.

## Microsoft GraphRAG

- Package: `graphrag`
- Version: `3.1.1`
- Upstream tag: `v3.1.1`
- Upstream commit: `14a00ad88fc33cf2b52f4f113f25807556f8e25e`
- License: MIT
- Source: <https://github.com/microsoft/graphrag>
- PyPI wheel SHA-256: `646deaa22893dcd14f740ceb8c99cc5112b51677f1db05c413489ab2c4048702`

Focowiki uses selected indexing primitives behind its owned adapter. The
GraphRAG query API and complete-corpus indexing pipeline are not runtime
dependencies of request handling.
