#!/usr/bin/env python3
"""Build a safe Cloud Run revision prune plan.

    plan_run_prune.py <revisions.csv> <serving.csv> <out.txt>   (KEEP from env)

Keeps, per service, the newest KEEP revisions PLUS every traffic-serving
revision, and writes the rest to out.txt.

Exits non-zero WITHOUT writing a plan if any serving revision would land in the
delete set. Deleting the revision a service is serving takes that function down,
so it has to be impossible rather than unlikely — and a partial plan is worse
than none, because the caller would delete most of a plan it should not trust.
"""

import collections
import csv
import os
import sys


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2

    revisions_csv, serving_csv, out_path = sys.argv[1:4]
    keep = int(os.environ.get("KEEP", "10"))

    revs = collections.defaultdict(list)
    with open(revisions_csv) as f:
        for row in csv.reader(f):
            if len(row) < 3:
                continue
            name, svc, ts = row[0], row[1], row[2]
            if name and svc:
                revs[svc].append((ts, name))

    serving = set()
    with open(serving_csv) as f:
        for row in csv.reader(f):
            for cell in row[1:]:
                for r in cell.split(";"):
                    r = r.strip()
                    if r:
                        serving.add(r)

    if not serving:
        # No serving revisions read means the services listing failed or changed
        # shape. Without it every revision looks unprotected, so refuse rather
        # than plan a deletion of things that might be live.
        print("refusing: could not identify any serving revision", file=sys.stderr)
        return 1

    delete = []
    for _svc, items in revs.items():
        items.sort(reverse=True)  # newest first
        protected = {n for _, n in items[:keep]} | serving
        delete.extend(n for _, n in items if n not in protected)

    overlap = serving & set(delete)
    if overlap:
        print(
            f"refusing: {len(overlap)} serving revisions in delete set, "
            f"e.g. {sorted(overlap)[:3]}",
            file=sys.stderr,
        )
        return 1

    with open(out_path, "w") as f:
        if delete:
            f.write("\n".join(delete) + "\n")

    total = sum(len(v) for v in revs.values())
    print(
        f"plan: {total} revisions, {len(serving)} serving, "
        f"keep newest {keep}/service, delete {len(delete)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
