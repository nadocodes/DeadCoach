"""
Build items.json (and heroes.json) for the DeadCoach website (docs/) and the
claude.ai artifact (artifact/): every shop item (name, slot, tier, cost, active flag,
short description) with its current painted shop art.

- docs/: art is saved as docs/items/<name>.webp (128px) and referenced by path.
- artifact/: the same art is embedded as data URIs, because artifact pages
  can't load images from other files or sites.

Usage:
    python build_item_catalog.py
Re-run after a patch adds or changes items, then commit and push.
"""

import base64
import html
import io
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor

import requests
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE_DIR = os.path.join(ROOT, "docs")
ARTIFACT_DIR = os.path.join(ROOT, "artifact")
ART_SIZE = 128


def short_desc(item):
    desc = item.get("description")
    if isinstance(desc, dict):
        desc = desc.get("desc") or next((v for v in desc.values() if isinstance(v, str)), "")
    text = re.sub(r"<[^>]+>", "", html.unescape(desc or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:220]


def fetch_art(item):
    """Current shop art (painted card), resized to ART_SIZE webp bytes."""
    url = item.get("shop_image_webp") or item.get("shop_image") or item.get("image_webp") or item.get("image")
    if not url:
        return None
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    img = Image.open(io.BytesIO(r.content)).convert("RGB").resize((ART_SIZE, ART_SIZE), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "WEBP", quality=82, method=6)
    return out.getvalue()


def main():
    items = requests.get("https://api.deadlock-api.com/v1/assets/items", timeout=60).json()
    shop = [i for i in items if i.get("type") == "upgrade" and i.get("shopable")
            and i.get("item_slot_type") in ("weapon", "vitality", "spirit")]
    with ThreadPoolExecutor(8) as pool:
        arts = list(pool.map(fetch_art, shop))

    art_dir = os.path.join(SITE_DIR, "items")
    os.makedirs(art_dir, exist_ok=True)
    for f in os.listdir(art_dir):
        if f.endswith(".webp"):
            os.remove(os.path.join(art_dir, f))

    site, embedded = [], []
    for i, art in zip(shop, arts):
        base = {
            "id": i["id"],
            "name": i["name"],
            "slot": i["item_slot_type"],
            "tier": i.get("item_tier"),
            "cost": i.get("cost"),
            "active": bool(i.get("is_active_item")),
            "desc": short_desc(i),
        }
        path = None
        if art:
            fname = re.sub(r"[^a-z0-9_]+", "_", (i.get("class_name") or str(i["id"])).lower()) + ".webp"
            with open(os.path.join(art_dir, fname), "wb") as f:
                f.write(art)
            path = "items/" + fname
        site.append({**base, "icon": path})
        embedded.append({**base, "icon": ("data:image/webp;base64," + base64.b64encode(art).decode()) if art else None})

    order = lambda c: (c["slot"], c["tier"] or 0, c["cost"] or 0, c["name"])
    site.sort(key=order)
    embedded.sort(key=order)

    heroes = requests.get("https://api.deadlock-api.com/v1/assets/heroes", timeout=60).json()
    hero_list = [{"id": h["id"], "name": h["name"], "type": h.get("hero_type"), "tags": h.get("tags") or []}
                 for h in heroes if h.get("player_selectable")]

    for out_dir, catalog in ((SITE_DIR, site), (ARTIFACT_DIR, embedded)):
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "items.json"), "w", encoding="utf-8") as f:
            json.dump(catalog, f, ensure_ascii=False, separators=(",", ":"))
        with open(os.path.join(out_dir, "heroes.json"), "w", encoding="utf-8") as f:
            json.dump(hero_list, f, ensure_ascii=False, separators=(",", ":"))
    missing = sum(1 for a in arts if not a)
    print(f"Wrote {len(site)} items ({missing} without art) and {len(hero_list)} heroes; art in {art_dir}")


if __name__ == "__main__":
    main()
