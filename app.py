"""
Deadlock Macro & Itemization Coach
==================================
A local web dashboard that:
  1. Pulls your recent match history from the free community Deadlock API
     (https://api.deadlock-api.com — not affiliated with Valve).
  2. Pulls current meta stats (item win rates, hero build stats) for the
     hero/matchup you played.
  3. Sends both to Claude and asks for a plain-language coaching report
     on your itemization and macro decisions.

Run:
    pip install -r requirements.txt
    export ANTHROPIC_API_KEY=sk-ant-...      (Windows: set ANTHROPIC_API_KEY=...)
    python app.py
Then open http://127.0.0.1:5000

NOTE ON API STABILITY
----------------------
deadlock-api.com is an open community project (not run by Valve or Anthropic)
and its exact endpoint paths can change. This script targets the endpoints
documented at https://api.deadlock-api.com/docs as of writing:
  - GET /v1/players/{account_id}/match-history
  - GET /v1/matches/{match_id}/metadata   (there is no plain /v1/matches/{id})
  - GET /v1/analytics/item-stats
  - GET /v1/analytics/hero-build-stats/{hero_id}
  - GET /v1/assets/heroes
  - GET /v1/assets/items
If any of these 404 for you, open the docs link above, find the renamed
endpoint, and update the constants at the top of this file — everything
else in the app will keep working.
"""

import os
import json
import time
from functools import lru_cache

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

load_dotenv()

app = Flask(__name__, template_folder=".")

DEADLOCK_API_BASE = "https://api.deadlock-api.com"
ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL = "claude-sonnet-4-6"

# Optional: a deadlock-api.com API key gets you a higher rate limit and
# faster refresh of your own matches (their $1.50/mo patron tier). Not
# required to use this app.
DEADLOCK_API_KEY = os.environ.get("DEADLOCK_API_KEY", "")

session = requests.Session()
if DEADLOCK_API_KEY:
    session.headers["X-API-Key"] = DEADLOCK_API_KEY

STEAM64_OFFSET = 76561197960265728


def to_account_id(raw_id):
    """Accept either the 32-bit account_id or a pasted SteamID64 and normalize."""
    return raw_id - STEAM64_OFFSET if raw_id >= STEAM64_OFFSET else raw_id


# --------------------------------------------------------------------------
# Deadlock API helpers
# --------------------------------------------------------------------------

def dl_get(path, params=None, timeout=15):
    """GET from the community Deadlock API with basic error surfacing."""
    url = f"{DEADLOCK_API_BASE}{path}"
    resp = session.get(url, params=params or {}, timeout=timeout)
    if resp.status_code == 404:
        raise LookupError(
            f"404 from {url} — this endpoint path may have changed. "
            f"Check https://api.deadlock-api.com/docs and update app.py."
        )
    resp.raise_for_status()
    return resp.json()


@lru_cache(maxsize=1)
def get_heroes():
    """id -> hero dict, cached for the process lifetime (heroes rarely change)."""
    heroes = dl_get("/v1/assets/heroes")
    return {h["id"]: h for h in heroes}


@lru_cache(maxsize=1)
def get_items():
    """id -> item dict, cached for the process lifetime."""
    items = dl_get("/v1/assets/items")
    return {i["id"]: i for i in items}


def get_match_history(account_id, limit=20):
    data = dl_get(f"/v1/players/{account_id}/match-history", params={"limit": limit})
    # Some deployments wrap the list in {"matches": [...]}; handle both shapes.
    return data.get("matches", data) if isinstance(data, dict) else data


def get_match_detail(match_id):
    """Fetch match metadata. The API has no plain /v1/matches/{id}; the real
    endpoint is /v1/matches/{id}/metadata and wraps the match info in a
    "match_info" object (parsed from the CMsgMatchMetaDataContents protobuf)."""
    data = dl_get(f"/v1/matches/{match_id}/metadata")
    return data.get("match_info", data) if isinstance(data, dict) else data


def get_item_stats(hero_id, enemy_hero_ids=None):
    params = {"hero_ids": str(hero_id), "min_matches": 20}
    if enemy_hero_ids:
        params["enemy_hero_ids"] = ",".join(str(h) for h in enemy_hero_ids)
    return dl_get("/v1/analytics/item-stats", params=params)


def get_hero_build_stats(hero_id):
    return dl_get(f"/v1/analytics/hero-build-stats/{hero_id}", params={"min_matches": 20})


def get_active_match(account_id):
    """Return the ActiveMatch dict the account is currently playing in, or None."""
    matches = dl_get("/v1/matches/active", params={"account_ids": str(account_id)})
    if not isinstance(matches, list):
        return None
    for m in matches:
        if any(p.get("account_id") == account_id for p in m.get("players", [])):
            return m
    return None


def hero_icon_url(hero):
    images = (hero or {}).get("images") or {}
    return images.get("icon_image_small") or images.get("minimap_image")


def item_icon_url(item):
    item = item or {}
    return item.get("image") or item.get("shop_image")


# --------------------------------------------------------------------------
# Claude coaching call
# --------------------------------------------------------------------------

COACH_SYSTEM_PROMPT = """You are a veteran Deadlock coach helping a player who wants to \
genuinely learn macro decision-making and itemization — not just be told what to buy.

You will be given:
  - The player's build in a specific match (items + rough buy timing if available)
  - Their hero and the enemy team's heroes
  - Current meta item win-rate stats for that hero (and vs. that enemy comp, when given)
  - Aggregate hero build stats (popular/winning skill or item orders)

Write a short coaching note with this structure:
1. **What you did well** — 1-2 concrete things, tied to the data, not generic praise.
2. **The biggest itemization miss** — pick ONE thing, explain *why* it mattered using
   the specific matchup (e.g. "you had no spirit lifesteal into a burst mage lane"),
   not just "buy X because win rate is higher."
3. **What the meta data suggests instead** — name specific items/timings and the
   reasoning a strong player would use, referencing the stats you were given.
4. **One macro note** — about timing, rotations, or objective control if the match
   data gives you enough to say something specific; otherwise skip this section
   rather than inventing something generic.

Keep it under 250 words, concrete, and written like a coach talking to a student who
wants to actually understand the game — not a stat printout. Do not hedge excessively;
give a clear opinion while noting real uncertainty (small sample sizes, patch changes).
"""

LIVE_SYSTEM_PROMPT = """You are a Deadlock coach giving a player a quick nudge for a \
match they are *currently in* (this is not post-match review — keep it short and
actionable, they'll read it in a few seconds between fights).

You will be given their hero, the enemy team's heroes, current meta item win-rate
stats for that specific matchup, and aggregate hero build stats.

In under 80 words, tell them:
  - The 1-2 highest-priority items to prioritize this match given the enemy comp,
    and one word on why (e.g. "they have two burst mages, get spirit lifesteal early").
  - Skip anything generic that isn't tied to this specific matchup's data.

No headers, no preamble — just the nudge, like a teammate calling it out in voice chat.
"""

# In-memory cache so live polling doesn't fire a fresh Claude call every ~30s.
LIVE_CACHE = {}
LIVE_CACHE_TTL_S = 300


def call_claude(payload_summary, system_prompt, max_tokens=700):
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return (
            "No ANTHROPIC_API_KEY set, so here's the raw data instead of an AI "
            "coaching note. Set the environment variable and restart the app to "
            "get full feedback:\n\n" + json.dumps(payload_summary, indent=2)
        )

    resp = requests.post(
        ANTHROPIC_API_URL,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": ANTHROPIC_MODEL,
            "max_tokens": max_tokens,
            "system": system_prompt,
            "messages": [
                {"role": "user", "content": json.dumps(payload_summary, indent=2)}
            ],
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    text_blocks = [b["text"] for b in data.get("content", []) if b.get("type") == "text"]
    return "\n".join(text_blocks) if text_blocks else "(Claude returned no text.)"


def call_claude_coach(payload_summary):
    return call_claude(payload_summary, COACH_SYSTEM_PROMPT, max_tokens=700)


def call_claude_live_nudge(payload_summary):
    return call_claude(payload_summary, LIVE_SYSTEM_PROMPT, max_tokens=300)


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/matches")
def api_matches():
    account_id = request.args.get("account_id", type=int)
    if not account_id:
        return jsonify({"error": "account_id is required"}), 400
    account_id = to_account_id(account_id)
    try:
        matches = get_match_history(account_id, limit=15)
        heroes = get_heroes()
        out = []
        for m in matches:
            hero_id = m.get("hero_id")
            out.append({
                "match_id": m.get("match_id"),
                "hero_id": hero_id,
                "hero_name": heroes.get(hero_id, {}).get("name", f"Hero {hero_id}"),
                "hero_icon": hero_icon_url(heroes.get(hero_id)),
                "won": m.get("match_result") == m.get("player_team") if "match_result" in m else m.get("won"),
                "start_time": m.get("start_time"),
                "duration_s": m.get("match_duration_s") or m.get("duration_s"),
            })
        return jsonify({"matches": out})
    except LookupError as e:
        return jsonify({"error": str(e)}), 502
    except requests.RequestException as e:
        return jsonify({"error": f"Deadlock API request failed: {e}"}), 502


@app.route("/api/coach")
def api_coach():
    account_id = request.args.get("account_id", type=int)
    match_id = request.args.get("match_id", type=int)
    if not account_id or not match_id:
        return jsonify({"error": "account_id and match_id are required"}), 400
    account_id = to_account_id(account_id)

    try:
        heroes = get_heroes()
        items = get_items()
        match = get_match_detail(match_id)

        players = match.get("players", [])
        me = next((p for p in players if p.get("account_id") == account_id), None)
        if me is None:
            return jsonify({"error": "Could not find you in that match's player list"}), 404

        my_team = me.get("team")
        enemy_ids = [p.get("hero_id") for p in players if p.get("team") != my_team]
        hero_id = me.get("hero_id")

        my_items = me.get("items", [])
        item_names = [items.get(i.get("item_id"), {}).get("name", str(i.get("item_id")))
                      for i in my_items] if my_items else []
        item_icons = [item_icon_url(items.get(i.get("item_id"))) for i in my_items] if my_items else []

        winning_team = match.get("winning_team")
        match_won = (my_team == winning_team) if winning_team is not None else me.get("won")

        meta_items = get_item_stats(hero_id, enemy_hero_ids=enemy_ids)
        build_stats = get_hero_build_stats(hero_id)

        # Trim to the most relevant slices so we don't blow the prompt budget.
        top_meta_items = sorted(
            meta_items, key=lambda x: x.get("matches", 0), reverse=True
        )[:15] if isinstance(meta_items, list) else meta_items

        payload = {
            "hero": heroes.get(hero_id, {}).get("name", f"Hero {hero_id}"),
            "enemy_heroes": [heroes.get(h, {}).get("name", f"Hero {h}") for h in enemy_ids],
            "your_items_this_match": item_names,
            "match_won": match_won,
            "match_duration_s": match.get("duration_s"),
            "current_meta_item_stats_for_this_hero_and_matchup": top_meta_items,
            "aggregate_hero_build_stats": build_stats[:5] if isinstance(build_stats, list) else build_stats,
        }

        note = call_claude_coach(payload)
        display = {
            "hero_icon": hero_icon_url(heroes.get(hero_id)),
            "enemy_heroes": [
                {"name": heroes.get(h, {}).get("name", f"Hero {h}"), "icon": hero_icon_url(heroes.get(h))}
                for h in enemy_ids
            ],
            "items": [{"name": n, "icon": icon} for n, icon in zip(item_names, item_icons)],
        }
        return jsonify({"coaching_note": note, "raw_data": payload, "display": display})

    except LookupError as e:
        return jsonify({"error": str(e)}), 502
    except requests.RequestException as e:
        return jsonify({"error": f"Deadlock API request failed: {e}"}), 502


@app.route("/api/live/status")
def api_live_status():
    """Best-effort 'Phase 2' nudge: detects a live match via /v1/matches/active
    and gives an early priority-buy nudge for the matchup. This does NOT track
    live item purchases (that would need per-match demo-SQL parsing against
    api.deadlock-api.com's broadcast/demo endpoints, which is far more fragile
    and rate-limited) — it's the immediate, reliable slice of "live assist"."""
    account_id = request.args.get("account_id", type=int)
    if not account_id:
        return jsonify({"error": "account_id is required"}), 400
    account_id = to_account_id(account_id)

    try:
        match = get_active_match(account_id)
        if match is None:
            return jsonify({"active": False})

        players = match.get("players", [])
        me = next((p for p in players if p.get("account_id") == account_id), None)
        if me is None:
            return jsonify({"active": False})

        heroes = get_heroes()
        my_team = me.get("team")
        hero_id = me.get("hero_id")
        enemy_ids = [p.get("hero_id") for p in players if p.get("team") != my_team and p.get("hero_id")]
        match_id = match.get("match_id")

        cached = LIVE_CACHE.get(match_id)
        if cached and (time.time() - cached["ts"]) < LIVE_CACHE_TTL_S:
            note = cached["note"]
        else:
            meta_items = get_item_stats(hero_id, enemy_hero_ids=enemy_ids)
            build_stats = get_hero_build_stats(hero_id)
            top_meta_items = sorted(
                meta_items, key=lambda x: x.get("matches", 0), reverse=True
            )[:10] if isinstance(meta_items, list) else meta_items
            payload = {
                "hero": heroes.get(hero_id, {}).get("name", f"Hero {hero_id}"),
                "enemy_heroes": [heroes.get(h, {}).get("name", f"Hero {h}") for h in enemy_ids],
                "current_meta_item_stats_for_this_hero_and_matchup": top_meta_items,
                "aggregate_hero_build_stats": build_stats[:5] if isinstance(build_stats, list) else build_stats,
            }
            note = call_claude_live_nudge(payload)
            LIVE_CACHE[match_id] = {"note": note, "ts": time.time()}

        return jsonify({
            "active": True,
            "match_id": match_id,
            "hero": {"name": heroes.get(hero_id, {}).get("name", f"Hero {hero_id}"), "icon": hero_icon_url(heroes.get(hero_id))},
            "enemy_heroes": [
                {"name": heroes.get(h, {}).get("name", f"Hero {h}"), "icon": hero_icon_url(heroes.get(h))}
                for h in enemy_ids
            ],
            "nudge": note,
        })

    except LookupError as e:
        return jsonify({"error": str(e)}), 502
    except requests.RequestException as e:
        return jsonify({"error": f"Deadlock API request failed: {e}"}), 502


if __name__ == "__main__":
    app.run(debug=True, port=5000)
