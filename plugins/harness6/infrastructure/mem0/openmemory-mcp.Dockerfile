# Patched mem0/openmemory-mcp:latest for the Mem0 stack in docker-compose.yml.
#
# Upstream hardcodes the default memory config in
# app/utils/memory.py:get_default_memory_config() — LLM `gpt-4o-mini`, embedder
# `text-embedding-3-small`, Qdrant host `mem0_store` — and reads no env var for
# any of them (verified by grepping the image: no LLM_MODEL / LLM_PROVIDER /
# QDRANT_* references anywhere). Only OPENAI_API_KEY and OPENAI_BASE_URL are
# picked up, by mem0's OpenAI client directly.
#
# patch-openmemory.py wraps the upstream default config so the same variable
# names the Graphiti stack uses (MEM_EXTRACTOR_MODEL, MEM_EMBED_MODEL,
# EMBEDDER_API_URL, EMBEDDER_DIMENSIONS) take effect. It asserts its anchor
# exists, so an upstream change breaks the build loudly. The Qdrant hostname is
# deliberately NOT patched: the compose service is simply named `mem0_store`.
#
# A config saved through OpenMemory's own /api/v1/config API (or UI) is stored
# in its database and overrides these defaults, as it does upstream.
#
# Does not touch, and is independent of, the Graphiti services in
# ../docker-compose.yml.
FROM mem0/openmemory-mcp:latest

COPY patch-openmemory.py /tmp/patch-openmemory.py
RUN python /tmp/patch-openmemory.py /usr/src/openmemory/app/utils/memory.py && rm /tmp/patch-openmemory.py
