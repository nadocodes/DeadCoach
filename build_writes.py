"""
Turn an artifact_sync.py output folder into an ArtifactData batch `writes` list.

Usage:
    python build_writes.py <sync_dir> [--existing ID,ID,...] [--player-version N]

--existing        match doc ids already in the artifact db (e.g. 80608013-111110065);
                  those are skipped, so only new matches are created.
--player-version  current version of players/<account_id> in the db; omit if the
                  account has never been synced (the doc is then created).

Prints a JSON array ready to pass as `writes` to the ArtifactData batch action.
"""

import argparse
import json
import os

ap = argparse.ArgumentParser()
ap.add_argument("sync_dir")
ap.add_argument("--existing", default="")
ap.add_argument("--player-version", type=int)
args = ap.parse_args()

existing = {s.strip() for s in args.existing.split(",") if s.strip()}
players_dir = os.path.join(args.sync_dir, "profiles")
player_file = next(f for f in os.listdir(players_dir) if f.endswith(".json"))
account_id = player_file[:-5]
player = json.load(open(os.path.join(players_dir, player_file), encoding="utf-8"))

writes = []
for m in player["matches"]:
    doc_id = f"{account_id}-{m['match_id']}"
    path = os.path.abspath(os.path.join(args.sync_dir, "games", doc_id + ".json"))
    if doc_id in existing or not os.path.exists(path):
        continue
    writes.append({"op": "set", "collection": "games", "doc_id": doc_id,
                   "file_path": path.replace(os.sep, "/")})

player_write = {"op": "set", "collection": "profiles", "doc_id": account_id,
                "file_path": os.path.abspath(os.path.join(players_dir, player_file)).replace(os.sep, "/")}
if args.player_version:
    player_write["if_version"] = args.player_version
writes.append(player_write)

print(json.dumps(writes))
