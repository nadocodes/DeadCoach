"""
Build items.json (and heroes.json) for the DeadCoach website (docs/) and the
claude.ai artifact (artifact/): every shop item (name, slot, tier, cost, active flag,
short description) with its white shop icon embedded as a data URI, so the
DeadCoach artifact can draw the in-game item browser without loading images
from another site (artifact pages can't).

Usage:
    python build_item_catalog.py
Re-run after a patch adds or changes items, then republish the artifact.
"""

import base64
import html
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor

import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_DIRS = [os.path.join(ROOT, "docs"), os.path.join(ROOT, "artifact")]


def short_desc(item):
    desc = item.get("description")
    if isinstance(desc, dict):
        desc = desc.get("desc") or next((v for v in desc.values() if isinstance(v, str)), "")
    text = re.sub(r"<[^>]+>", "", html.unescape(desc or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:220]


def icon_data_uri(url):
    if not url:
        return None
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return "data:image/webp;base64," + base64.b64encode(r.content).decode()


def main():
    items = requests.get("https://api.deadlock-api.com/v1/assets/items", timeout=60).json()
    shop = [i for i in items if i.get("type") == "upgrade" and i.get("shopable")
            and i.get("item_slot_type") in ("weapon", "vitality", "spirit")]
    with ThreadPoolExecutor(8) as pool:
        icons = list(pool.map(lambda i: icon_data_uri(i.get("image_webp") or i.get("image")), shop))
    catalog = [{
        "id": i["id"],
        "name": i["name"],
        "slot": i["item_slot_type"],
        "tier": i.get("item_tier"),
        "cost": i.get("cost"),
        "active": bool(i.get("is_active_item")),
        "desc": short_desc(i),
        "icon": icon,
    } for i, icon in zip(shop, icons)]
    catalog.sort(key=lambda c: (c["slot"], c["tier"] or 0, c["cost"] or 0, c["name"]))
    heroes = requests.get("https://api.deadlock-api.com/v1/assets/heroes", timeout=60).json()
    hero_list = [{"id": h["id"], "name": h["name"], "type": h.get("hero_type"), "tags": h.get("tags") or []}
                 for h in heroes if h.get("player_selectable")]
    for out_dir in OUT_DIRS:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "items.json"), "w", encoding="utf-8") as f:
            json.dump(catalog, f, ensure_ascii=False, separators=(",", ":"))
        with open(os.path.join(out_dir, "heroes.json"), "w", encoding="utf-8") as f:
            json.dump(hero_list, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {len(catalog)} items and {len(hero_list)} heroes to {', '.join(OUT_DIRS)}")


if __name__ == "__main__":
    main()
