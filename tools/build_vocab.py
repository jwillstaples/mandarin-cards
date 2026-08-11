#!/usr/bin/env python3
"""Build data/vocab.json from the upstream Duolingo Chinese dictionary.

Fetches 4044ever/duolingo-chinese-dictionary, normalises it, and writes the word
list the app loads. Saved progress is keyed by word id, so the script refuses to
silently reassign ids: if a rebuild would move an existing word to a different id
it prints the collisions and writes an id remap alongside the data.

    python3 tools/build_vocab.py            # fetch upstream and rebuild
    python3 tools/build_vocab.py --from pairs.json
"""

import argparse
import json
import pathlib
import re
import sys
import urllib.request

UPSTREAM = "https://raw.githubusercontent.com/4044ever/duolingo-chinese-dictionary/main/pairs.json"
ROOT = pathlib.Path(__file__).resolve().parent.parent
DEST = ROOT / "data" / "vocab.json"

LESSON_RE = re.compile(r"(\d+)-(\d+)")
GLOSS_SPLIT = re.compile(r"\s*[/;]\s*")


def fetch(src):
    if src:
        return json.loads(pathlib.Path(src).read_text(encoding="utf-8"))
    with urllib.request.urlopen(UPSTREAM, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def normalise(raw):
    """Drop unusable rows, merge duplicate (hanzi, pinyin) pairs, split glosses."""
    words, by_pair, dropped = [], {}, 0
    for e in raw:
        hz = (e.get("chinese") or "").strip()
        py = (e.get("pinyin") or "").strip()
        en = (e.get("english") or "").strip()
        ls = (e.get("lesson") or "").strip()
        m = LESSON_RE.fullmatch(ls)
        if not (hz and py and en and m):
            dropped += 1
            continue

        key = (hz, py)
        if key in by_pair:
            prev = by_pair[key]
            for g in (g.strip() for g in GLOSS_SPLIT.split(en)):
                if g and g not in prev["en"]:
                    prev["en"].append(g)
            dropped += 1
            continue

        rec = {
            "id": None,
            "hz": hz,
            "py": py,
            "en": [g for g in (g.strip() for g in GLOSS_SPLIT.split(en)) if g],
            "s": int(m.group(1)),
            "u": int(m.group(2)),
        }
        words.append(rec)
        by_pair[key] = rec

    words.sort(key=lambda r: (r["s"], r["u"], r["hz"]))
    for i, r in enumerate(words):
        r["id"] = i
    return words, dropped


def check_ids(words):
    """Warn if any word already shipped under a different id."""
    if not DEST.exists():
        return {}
    old = json.loads(DEST.read_text(encoding="utf-8"))["words"]
    old_by_pair = {(w["hz"], w["py"]): w["id"] for w in old}
    remap = {}
    for w in words:
        prev = old_by_pair.get((w["hz"], w["py"]))
        if prev is not None and prev != w["id"]:
            remap[prev] = w["id"]
    return remap


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="src", help="read a local pairs.json instead of fetching")
    ap.add_argument("--retrieved", default=None, help="date stamp to record (YYYY-MM-DD)")
    args = ap.parse_args()

    raw = fetch(args.src)
    words, dropped = normalise(raw)
    remap = check_ids(words)

    sections = sorted({w["s"] for w in words})
    print(f"{len(words)} words kept, {dropped} rows dropped or merged")
    for s in sections:
        units = max(w["u"] for w in words if w["s"] == s)
        n = sum(1 for w in words if w["s"] == s)
        print(f"  section {s}: {n:4d} words across {units} units")

    if remap:
        path = ROOT / "data" / "id_remap.json"
        path.write_text(json.dumps(remap, indent=2), encoding="utf-8")
        print(f"\nWARNING: {len(remap)} words changed id — saved progress keyed by the old "
              f"ids will point at the wrong words.\nA mapping {{old: new}} was written to "
              f"{path.relative_to(ROOT)}; apply it to exported progress before importing.",
              file=sys.stderr)

    payload = {
        "source": "https://github.com/4044ever/duolingo-chinese-dictionary",
        "retrieved": args.retrieved or "unknown",
        "words": words,
    }
    DEST.parent.mkdir(parents=True, exist_ok=True)
    DEST.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    print(f"\nwrote {DEST.relative_to(ROOT)} ({DEST.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
