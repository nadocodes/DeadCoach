"""
Sync Deadlock match data into the DeadCoach artifact's database.

The published artifact can't reach api.deadlock-api.com itself (artifact pages
have no outbound network), so Claude Code runs this script, then writes the
JSON files it produces into the artifact's `db` with the ArtifactData tool.

Usage:
    python artifact_sync.py <account_id or SteamID64> [--per-mode 10] [--out DIR]

Pulls the most recent matches in each mode (Ranked, Standard, Street Brawl),
grades each one against the rest of the lobby, and writes one JSON file per
database document:
    <out>/profiles/<account_id>.json            match list for the search bar
    <out>/games/<account_id>-<match_id>.json    build + matchup + grade + meta stats
"""

import argparse
import json
import os
import sys
import time

import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

API = "https://api.deadlock-api.com"
STEAM64_OFFSET = 76561197960265728
MODES = ("ranked", "standard", "streetbrawl")

session = requests.Session()
if os.environ.get("DEADLOCK_API_KEY"):
    session.headers["X-API-Key"] = os.environ["DEADLOCK_API_KEY"]


def to_account_id(raw_id):
    return raw_id - STEAM64_OFFSET if raw_id >= STEAM64_OFFSET else raw_id


def dl_get(path, params=None):
    for attempt in range(3):
        resp = session.get(f"{API}{path}", params=params or {}, timeout=60)
        if resp.status_code == 429:
            time.sleep(2 + attempt * 3)
            continue
        resp.raise_for_status()
        return resp.json()
    resp.raise_for_status()


def match_mode(m):
    """ECitadelGameMode 4 = Street Brawl; ECitadelMatchMode 4 = Ranked, 1 = Unranked.
    Bot, private-lobby and other modes return None and are skipped."""
    if m.get("game_mode") == 4:
        return "streetbrawl"
    if m.get("game_mode") == 1 and m.get("match_mode") == 4:
        return "ranked"
    if m.get("game_mode") == 1 and m.get("match_mode") == 1:
        return "standard"
    return None


# --------------------------------------------------------------------------
# Grading: role-aware. Work out what the player was actually doing (from the
# build's soul spend, healing given, and the hero's type/tags), then score
# where they finished in the lobby on the metrics that matter for that role.
# --------------------------------------------------------------------------

METRICS = {
    # key: (label, higher_is_better)
    "souls": ("Souls", True),
    "hero_damage": ("Hero damage", True),
    "damage_per_soul": ("Damage per soul", True),
    "kills": ("Kills", True),
    "assists": ("Assists", True),
    "kill_participation": ("Kill share", True),
    "deaths": ("Fewest deaths", False),
    "last_hits": ("Last hits", True),
    "objective_damage": ("Objective damage", True),
    "healing_given": ("Healing + barriers given", True),
    "damage_taken": ("Damage soaked", True),
    "damage_mitigated": ("Damage mitigated", True),
    "heal_prevented": ("Healing denied", True),
    "accuracy": ("Accuracy", True),
    "crit_rate": ("Headshot rate", True),
}

ROLE_WEIGHTS = {
    "gun_carry": {"souls": .17, "hero_damage": .18, "damage_per_soul": .08, "kill_participation": .12,
                  "deaths": .12, "last_hits": .10, "objective_damage": .08, "accuracy": .07, "crit_rate": .08},
    "spirit_carry": {"souls": .17, "hero_damage": .20, "damage_per_soul": .10, "kill_participation": .14,
                     "deaths": .12, "last_hits": .10, "objective_damage": .08, "kills": .09},
    "tank": {"damage_taken": .18, "damage_mitigated": .12, "kill_participation": .16, "assists": .08,
             "deaths": .10, "hero_damage": .10, "objective_damage": .10, "souls": .08, "heal_prevented": .08},
    "support": {"healing_given": .28, "assists": .14, "kill_participation": .14, "deaths": .14,
                "heal_prevented": .06, "hero_damage": .08, "souls": .08, "damage_per_soul": .08},
    "assassin": {"kills": .18, "hero_damage": .16, "damage_per_soul": .10, "kill_participation": .12,
                 "deaths": .14, "souls": .14, "crit_rate": .06, "objective_damage": .10},
    "hybrid": {"souls": .18, "hero_damage": .16, "kill_participation": .16, "deaths": .14,
               "last_hits": .10, "objective_damage": .10, "healing_given": .08, "damage_taken": .08},
}
ROLE_LABELS = {"gun_carry": "Gun carry", "spirit_carry": "Spirit carry", "tank": "Tank",
               "support": "Support", "assassin": "Assassin", "hybrid": "Hybrid"}
HERO_TYPE_ROLE = {"marksman": "gun_carry", "mystic": "spirit_carry", "brawler": "tank", "assassin": "assassin"}
LANE_METRICS = {"last_hits", "objective_damage"}   # matter far less in Street Brawl
GRADE_BANDS = [(85, "S"), (70, "A"), (55, "B"), (40, "C"), (0, "D")]


def final_stats(p):
    stats = p.get("stats") or []
    return stats[-1] if stats else {}


def percentile(value, values, higher_is_better=True):
    """0..100: share of the other players you beat (ties count half)."""
    others = list(values)
    others.remove(value)
    if not others:
        return 50.0
    beat = sum(1 for v in others if (v < value if higher_is_better else v > value))
    tie = sum(1 for v in others if v == value)
    return 100.0 * (beat + 0.5 * tie) / len(others)


def player_metrics(p, team_kills):
    s = final_stats(p)
    souls = p.get("net_worth") or s.get("net_worth") or 0
    dmg = s.get("player_damage") or 0
    hits = (s.get("shots_hit") or 0)
    shots = hits + (s.get("shots_missed") or 0)
    hero_hits = s.get("hero_bullets_hit") or 0
    return {
        "souls": souls,
        "hero_damage": dmg,
        "damage_per_soul": round(dmg / souls, 3) if souls else 0,
        "kills": p.get("kills") or 0,
        "assists": p.get("assists") or 0,
        "kill_participation": round(((p.get("kills") or 0) + (p.get("assists") or 0)) / (team_kills.get(p.get("team")) or 1), 3),
        "deaths": p.get("deaths") or 0,
        "last_hits": p.get("last_hits") or s.get("creep_kills") or 0,
        "objective_damage": s.get("boss_damage") or 0,
        "healing_given": (s.get("teammate_healing") or 0) + (s.get("teammate_barriering") or 0),
        "damage_taken": s.get("player_damage_taken") or 0,
        "damage_mitigated": s.get("damage_mitigated") or 0,
        "heal_prevented": s.get("heal_prevented") or 0,
        "accuracy": round(hits / shots, 3) if shots else 0,
        "crit_rate": round((s.get("hero_bullets_hit_crit") or 0) / hero_hits, 3) if hero_hits else 0,
    }


def detect_role(hero, build, mine, all_m):
    """Role from soul spend by shop slot, healing given, and the hero's own type/tags."""
    spend = {"weapon": 0, "vitality": 0, "spirit": 0}
    for b in build:
        if b.get("slot") in spend:
            spend[b["slot"]] += b.get("cost") or 0
    total = sum(spend.values()) or 1
    share = {k: round(v / total, 2) for k, v in spend.items()}
    tags = {t.lower() for t in (hero.get("tags") or [])}
    hero_type = hero.get("hero_type")
    healing, dmg = mine["healing_given"], mine["hero_damage"] or 1
    mix = f"{round(share['weapon']*100)}% weapon / {round(share['vitality']*100)}% vitality / {round(share['spirit']*100)}% spirit"

    if healing >= 0.35 * dmg or ({"support", "helpful", "protector"} & tags and healing >= 0.15 * dmg):
        return "support", f"Healed/shielded teammates for {healing:,} ({round(100*healing/dmg)}% of your damage). Build: {mix}."
    soak_rank = sorted((m["damage_taken"] for m in all_m), reverse=True).index(mine["damage_taken"]) + 1
    frontline = hero_type == "brawler" or "tank" in tags or soak_rank <= max(3, len(all_m) // 3)
    if (share["vitality"] >= 0.45 or ("tank" in tags and share["vitality"] >= 0.35)) and frontline:
        return "tank", f"Build leaned vitality ({mix}) and you soaked {mine['damage_taken']:,} damage ({soak_rank} of {len(all_m)} in the lobby)."
    if share["vitality"] >= 0.45:
        # Survival build on a non-frontliner: grade on the damage type it backed up.
        role = "spirit_carry" if share["spirit"] >= share["weapon"] else ("assassin" if hero_type == "assassin" else "gun_carry")
        return role, f"Vitality-heavy build ({mix}) but you weren't on the front line, so graded as a {ROLE_LABELS[role].lower()}."
    if share["spirit"] >= 0.45:
        return "spirit_carry", f"Build leaned spirit ({mix})."
    if share["weapon"] >= 0.45:
        role = "assassin" if hero_type == "assassin" else "gun_carry"
        return role, f"Build leaned weapon ({mix}); {hero.get('name')} is a{'n' if hero_type == 'assassin' else ''} {hero_type or 'flex'} hero."
    role = HERO_TYPE_ROLE.get(hero_type, "hybrid")
    return role, f"Mixed build ({mix}), so graded on {hero.get('name')}'s usual {hero_type or 'flex'} role."


def grade_player(players, me, won, hero, build, mode):
    team_kills = {}
    for p in players:
        team_kills[p.get("team")] = team_kills.get(p.get("team"), 0) + (p.get("kills") or 0)
    all_m = [player_metrics(p, team_kills) for p in players]
    mine = player_metrics(me, team_kills)
    role, reason = detect_role(hero, build, mine, all_m)

    weights = dict(ROLE_WEIGHTS[role])
    if mode == "streetbrawl":
        for k in LANE_METRICS:
            weights.pop(k, None)
    norm = sum(weights.values())
    weights = {k: w / norm for k, w in weights.items()}

    minutes = max(1, (final_stats(me).get("time_stamp_s") or 60) / 60)
    breakdown, score = {}, 0.0
    for key in METRICS:
        label, higher = METRICS[key]
        values = [m[key] for m in all_m]
        ordered = sorted(values, reverse=higher)
        entry = {"label": label, "value": mine[key], "rank": ordered.index(mine[key]) + 1,
                 "of": len(values), "weight": round(weights.get(key, 0), 3)}
        if key in weights:
            score += weights[key] * percentile(mine[key], values, higher)
        breakdown[key] = entry
    score += 4 if won else -4               # small nudge for the result
    score = max(0, min(100, round(score)))
    letter = next(l for floor, l in GRADE_BANDS if score >= floor)
    per_min = {
        "damage": round(mine["hero_damage"] / minutes),
        "healing": round(mine["healing_given"] / minutes),
        "souls": round(mine["souls"] / minutes),
        "damage_taken": round(mine["damage_taken"] / minutes),
    }
    return {"letter": letter, "score": score, "role": role, "role_label": ROLE_LABELS[role],
            "role_reason": reason, "per_min": per_min, "breakdown": breakdown}


def compact_meta(stats, items, my_item_ids, keep=30):
    """Trim item-stats to the most-picked shop items, plus everything the
    player bought, with just the fields the coach needs."""
    rows = []
    for s in stats if isinstance(stats, list) else []:
        it = items.get(s.get("item_id"))
        if not it or it.get("type") != "upgrade" or not s.get("matches"):
            continue
        rows.append({
            "item": it["name"],
            "slot": it.get("item_slot_type"),
            "tier": it.get("item_tier"),
            "matches": s["matches"],
            "win_rate": round(100 * s["wins"] / s["matches"], 1),
            "avg_buy_min": round((s.get("avg_buy_time_s") or 0) / 60, 1),
            "_id": s["item_id"],
        })
    rows.sort(key=lambda r: r["matches"], reverse=True)
    top = rows[:keep]
    top_ids = {r["_id"] for r in top}
    top += [r for r in rows if r["_id"] in my_item_ids and r["_id"] not in top_ids]
    for r in top:
        r.pop("_id")
    return top


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("account_id", type=int)
    ap.add_argument("--per-mode", type=int, default=10)
    ap.add_argument("--out", default="artifact_sync_out")
    args = ap.parse_args()

    account_id = to_account_id(args.account_id)
    heroes = {h["id"]: h for h in dl_get("/v1/assets/heroes")}
    items = {i["id"]: i for i in dl_get("/v1/assets/items")}
    hero_name = lambda hid: heroes.get(hid, {}).get("name", f"Hero {hid}")

    history = dl_get(f"/v1/players/{account_id}/match-history")
    history = history.get("matches", history) if isinstance(history, dict) else history
    history = sorted(history, key=lambda m: m.get("start_time", 0), reverse=True)
    picked, counts = [], {mode: 0 for mode in MODES}
    for m in history:
        mode = match_mode(m)
        if mode and counts[mode] < args.per_mode:
            counts[mode] += 1
            picked.append((mode, m))
    if not picked:
        sys.exit(f"No matches found for account {account_id}.")

    os.makedirs(os.path.join(args.out, "profiles"), exist_ok=True)
    os.makedirs(os.path.join(args.out, "games"), exist_ok=True)

    summaries = []
    for mode, m in picked:
        match_id = m["match_id"]
        won = m.get("match_result") == m.get("player_team")
        summary = {
            "match_id": match_id,
            "mode": mode,
            "hero": hero_name(m.get("hero_id")),
            "won": won,
            "start_time": m.get("start_time"),
            "duration_s": m.get("match_duration_s"),
            "kills": m.get("player_kills"),
            "deaths": m.get("player_deaths"),
            "assists": m.get("player_assists"),
            "net_worth": m.get("net_worth"),
            "has_detail": False,
        }
        if mode == "streetbrawl" and m.get("brawl_score_team0") is not None:
            mine_t, other_t = (0, 1) if m.get("player_team") == 0 else (1, 0)
            summary["rounds"] = f"{m.get(f'brawl_score_team{mine_t}')}-{m.get(f'brawl_score_team{other_t}')}"
        try:
            md = dl_get(f"/v1/matches/{match_id}/metadata")
            info = md.get("match_info", md)
            players = info.get("players", [])
            me = next(p for p in players if p.get("account_id") == account_id)
            my_team = me.get("team")
            enemy_ids = [p["hero_id"] for p in players if p.get("team") != my_team]
            ally_ids = [p["hero_id"] for p in players
                        if p.get("team") == my_team and p.get("account_id") != account_id]

            build, my_item_ids = [], set()
            for it in me.get("items", []):
                meta = items.get(it.get("item_id"))
                if not meta or meta.get("type") != "upgrade":
                    continue
                my_item_ids.add(it["item_id"])
                build.append({
                    "item": meta["name"],
                    "slot": meta.get("item_slot_type"),
                    "tier": meta.get("item_tier"),
                    "cost": meta.get("cost"),
                    "bought_min": round(it.get("game_time_s", 0) / 60, 1),
                    "sold_min": round(it["sold_time_s"] / 60, 1) if it.get("sold_time_s") else None,
                })

            grade = grade_player(players, me, won, heroes.get(me.get("hero_id"), {}), build, mode)
            s = final_stats(me)
            meta_stats = dl_get("/v1/analytics/item-stats", params={
                "hero_ids": str(me["hero_id"]),
                "enemy_hero_ids": ",".join(map(str, enemy_ids)),
                "game_mode": "street_brawl" if mode == "streetbrawl" else "normal",
                "min_matches": 20,
            })

            detail = {
                **summary,
                "has_detail": True,
                "account_id": account_id,
                "lane": me.get("assigned_lane"),
                "level": me.get("level"),
                "last_hits": me.get("last_hits"),
                "denies": me.get("denies"),
                "hero_damage": s.get("player_damage"),
                "damage_taken": s.get("player_damage_taken"),
                "healing": s.get("player_healing"),
                "allies": [hero_name(h) for h in ally_ids],
                "enemies": [hero_name(h) for h in enemy_ids],
                "grade": grade,
                "build": build,
                "meta_items_vs_this_comp": compact_meta(meta_stats, items, my_item_ids),
                "synced_at": int(time.time()),
            }
            summary["has_detail"] = True
            summary["enemies"] = detail["enemies"]
            summary["grade"] = grade["letter"]
            summary["score"] = grade["score"]
            summary["ranks"] = {k: v["rank"] for k, v in grade["breakdown"].items() if v["weight"]}
            summary["role"] = grade["role_label"]
            with open(os.path.join(args.out, "games", f"{account_id}-{match_id}.json"), "w", encoding="utf-8") as f:
                json.dump(detail, f, ensure_ascii=False)
            print(f"  {match_id} {mode:<11} {summary['hero']:<14} {'W' if won else 'L'}  {grade['letter']} {grade['score']:>3}  {grade['role_label']}")
        except (StopIteration, requests.RequestException, KeyError) as e:
            print(f"  {match_id} skipped detail: {e}")
        summaries.append(summary)

    profile = {"account_id": account_id, "synced_at": int(time.time()), "matches": summaries}
    with open(os.path.join(args.out, "profiles", f"{account_id}.json"), "w", encoding="utf-8") as f:
        json.dump(profile, f, ensure_ascii=False)
    print(f"Wrote {len(summaries)} matches for {account_id} to {args.out}/ ({counts})")


if __name__ == "__main__":
    main()
