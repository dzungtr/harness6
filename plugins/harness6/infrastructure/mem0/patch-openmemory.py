"""Build-time patch for mem0/openmemory-mcp's app/utils/memory.py (see openmemory-mcp.Dockerfile)."""

import sys

ANCHOR = "def get_default_memory_config():\n"

PATCH = '''\
def get_default_memory_config():
    """Upstream defaults, with harness6 env overrides (MEM_*/EMBEDDER_*)."""
    config = _upstream_get_default_memory_config()
    llm_model = os.environ.get("MEM_EXTRACTOR_MODEL")
    embed_model = os.environ.get("MEM_EMBED_MODEL")
    embed_url = os.environ.get("EMBEDDER_API_URL")
    embed_dims = os.environ.get("EMBEDDER_DIMENSIONS")
    if llm_model:
        config["llm"]["config"]["model"] = llm_model
    if embed_model:
        config["embedder"]["config"]["model"] = embed_model
    if embed_url:
        config["embedder"]["config"]["openai_base_url"] = embed_url
    if embed_dims:
        config["embedder"]["config"]["embedding_dims"] = int(embed_dims)
        config["vector_store"]["config"]["embedding_model_dims"] = int(embed_dims)
    return config


'''

path = sys.argv[1]
src = open(path).read()
assert src.count(ANCHOR) == 1, f"patch anchor not found exactly once in {path}"
assert "\nimport os" in src or src.startswith("import os"), "memory.py no longer imports os"
src = src.replace(ANCHOR, PATCH + "def _upstream_get_default_memory_config():\n")
open(path, "w").write(src)
