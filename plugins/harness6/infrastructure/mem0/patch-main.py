"""Build-time patch for mem0/mem0-api-server's /app/main.py (see mem0-api.Dockerfile)."""

import sys

ANCHOR = "MEMORY_INSTANCE = Memory.from_config(DEFAULT_CONFIG)\n"

PATCH = '''\
# --- harness6 patch: honor model/endpoint/dimension env vars -----------------
def _env(name):
    return os.environ.get(name) or None


if _env("MEM_EXTRACTOR_MODEL"):
    DEFAULT_CONFIG["llm"]["config"]["model"] = _env("MEM_EXTRACTOR_MODEL")
if _env("MEM_EMBED_MODEL"):
    DEFAULT_CONFIG["embedder"]["config"]["model"] = _env("MEM_EMBED_MODEL")
if _env("EMBEDDER_API_URL"):
    DEFAULT_CONFIG["embedder"]["config"]["openai_base_url"] = _env("EMBEDDER_API_URL")
if _env("EMBEDDER_DIMENSIONS"):
    _dims = int(_env("EMBEDDER_DIMENSIONS"))
    DEFAULT_CONFIG["embedder"]["config"]["embedding_dims"] = _dims
    DEFAULT_CONFIG["vector_store"]["config"]["embedding_model_dims"] = _dims
# -----------------------------------------------------------------------------

'''

path = sys.argv[1]
src = open(path).read()
assert src.count(ANCHOR) == 1, f"patch anchor not found exactly once in {path}"
open(path, "w").write(src.replace(ANCHOR, PATCH + ANCHOR))
