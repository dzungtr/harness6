"""Summarise results-live-run*.json and sweep theta_switch over the recorded Gate probabilities.

    python3 docs/experiments/analyze.py
"""
import glob
import json
import os

here = os.path.dirname(os.path.abspath(__file__))
seqs = []
for path in sorted(glob.glob(os.path.join(here, "results-live-run*.json"))):
    live = json.load(open(path))["live"]
    spans = live["gateSpans"]
    durs = sorted(s["durationMs"] for s in spans)
    fallbacks = sum(1 for s in spans if s["attrs"].get("fallback") or s["error"])
    switched = sum(1 for s in spans if s["attrs"].get("switched"))
    turns = [t for r in live["rows"] for t in r["turns"]]
    print(os.path.basename(path), "spans", len(spans), "turns", len(turns), "switched", switched, "fallback", fallbacks,
          "p50ms", round(durs[len(durs) // 2]), "maxms", round(durs[-1]),
          "services", sorted({str(s["attrs"].get("service.name")) for s in spans}))
    probs = [(s["attrs"]["p.deliberation"], s["attrs"]["p.execution"], s["attrs"]["event"], s["attrs"]["role.previous"]) for s in spans if "p.deliberation" in s["attrs"]]
    mid = [(e, prev, pd, pe) for pd, pe, e, prev in probs if 0.25 < max(pd, pe) < 0.94]
    print("  mid-range probabilities:", mid)
    print("  cacheRead per turn:", [(t["model"][-5:], t["cacheRead"]) for t in turns])
    seqs.append([(pd, pe) for pd, pe, _, _ in probs])

print("theta  switches per run")
for th in [0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]:
    out = []
    for seq in seqs:
        cur, sw = None, 0
        for pd, pe in seq:
            if cur is None:
                cur = "d" if pd >= pe else "e"
            else:
                other = "e" if cur == "d" else "d"
                if (pe if other == "e" else pd) >= th:
                    cur, sw = other, sw + 1
        out.append(sw)
    print(th, out)
