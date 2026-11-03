# Patched mem0/mem0-api-server:latest for the Mem0 stack in docker-compose.yml.
#
# Two fixes layered on the published image (last pushed 2025-09; re-checked by
# running it, see the PR that introduced this directory):
#
# 1. Missing dependencies. The image's bundled server/main.py hardcodes a
#    Postgres+pgvector vector store AND a Neo4j graph store (both are built
#    unconditionally at import time), but the image ships without them:
#      - psycopg has no libpq/binary wrapper ("no pq wrapper available"),
#      - `neo4j` / `langchain-neo4j` are not installed,
#      - `rank-bm25` is not installed (needed by the graph-store reranker).
#    The container crashes on boot until all of them are installed.
#
# 2. Hardcoded models/endpoints. Upstream main.py pins the LLM to `gpt-4o` and
#    the embedder to `text-embedding-3-small`, reading only OPENAI_API_KEY
#    (OPENAI_BASE_URL is honored by mem0's OpenAI client itself). It has no
#    env knob for the models, the embedder endpoint or the vector dimensions.
#    patch-main.py below wires the same variable names the Graphiti stack uses
#    (MEM_EXTRACTOR_MODEL, MEM_EMBED_MODEL, EMBEDDER_API_URL,
#    EMBEDDER_DIMENSIONS). The patch asserts its anchor line exists, so an
#    upstream change breaks the build loudly instead of silently dropping it.
#
# Does not touch, and is independent of, the Graphiti services in
# ../docker-compose.yml.
FROM mem0/mem0-api-server:latest

RUN pip install --no-cache-dir "psycopg[binary,pool]" neo4j langchain-neo4j rank-bm25

COPY patch-main.py /tmp/patch-main.py
RUN python /tmp/patch-main.py /app/main.py && rm /tmp/patch-main.py
