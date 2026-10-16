# Deadlock Macro & Itemization Coach

## DeadCoach website (`docs/`)

A static site, hosted on GitHub Pages, that anyone can use: type an account ID
(or open `…/?id=<account_id>`) and it loads matches live from
[deadlock-api.com](https://deadlock-api.com) in the browser, with no server and no syncing.

- Ranked / Standard / Street Brawl tabs, each game graded S–D against its lobby
  for the role actually played (detected from the build, healing and hero type).
- Coach's note three ways: **Quick coach** (free, built from meta win rates for that
  enemy lineup), **Claude via claude.ai** (copy the request, paste Claude's reply
  back to see it visualised), or **Claude via your own API key** (stored only in
  that browser).
- In-game style item browser highlighting your build and the coach's build.

Publish: push this repo to GitHub, then Settings → Pages → Deploy from a branch →
`main` / `/docs`. Run locally with `python -m http.server 8766 --directory docs`.
After a game patch, run `python build_item_catalog.py` to refresh item and hero data.

## Original local Flask app

A local web dashboard: pick one of your recent matches, and it pulls your
build + the current meta stats for that hero/matchup from the community
[Deadlock API](https://deadlock-api.com), then asks Claude to write you a
short coaching note on what you bought and why it did or didn't work.

This is **Phase 1** (post-match coaching). It's deliberately not a live
in-match overlay yet — see "Phase 2" below for why, and what to do once
you're happy with the coaching quality here.

## 1. Get an Anthropic API key

1. Go to https://console.anthropic.com and sign up / log in.
2. Create an API key under **API Keys**.
3. You'll be billed per request (this app's calls are small — a few cents
   at most per coaching note). Free trial credit is usually available for
   new accounts.

## 2. Install and run

```bash
cd deadlock-coach
pip install -r requirements.txt

# macOS/Linux:
export ANTHROPIC_API_KEY=sk-ant-api03-...your-key-here...
# Windows (cmd):
set ANTHROPIC_API_KEY=sk-ant-api03-...your-key-here...
# Windows (PowerShell):
$env:ANTHROPIC_API_KEY="sk-ant-api03-...your-key-here..."

python app.py
```

Open **http://127.0.0.1:5000** in your browser.

Without an API key set, the app still runs and shows you the raw match +
meta data it *would* have sent to Claude — useful for checking the plumbing
works before you spend any API credit.

## 3. Find your account_id

The Deadlock API uses your 32-bit Steam account ID, not your SteamID64 or
Steam vanity name. If you have your SteamID64 (a long number starting with
`7656119...`), subtract `76561197960265728` to get your account_id. Several
community tools linked from the [deadlock-api.com docs](https://api.deadlock-api.com/docs)
can also do this conversion from a Steam profile URL directly.

## If something 404s

`deadlock-api.com` is an independent community project, not run by Valve or
Anthropic, and endpoint paths can change as they develop it. `app.py` has a
block of constants and small `dl_get(...)` calls near the top clearly
documenting which endpoints it expects:

- `GET /v1/players/{account_id}/match-history`
- `GET /v1/matches/{match_id}`
- `GET /v1/analytics/item-stats`
- `GET /v1/analytics/hero-build-stats/{hero_id}`
- `GET /v1/assets/heroes`
- `GET /v1/assets/items`

If you get a 502 error mentioning one of these, open
https://api.deadlock-api.com/docs, find the current name/shape for that
endpoint, and update the corresponding function in `app.py` — the rest of
the app doesn't need to change.

## What the coaching note actually uses

For the match you click:
- **Your build** — the items you bought, pulled from the match detail
- **The matchup** — your hero vs. the specific enemy heroes you faced
- **Live meta stats** — item win rates *for your hero specifically against
  that enemy composition*, not just generic hero win rates
- **Aggregate build stats** — what item/skill orders tend to win with your
  hero across many matches

Claude is prompted to structure feedback as: what you did well, the single
biggest itemization miss (not a laundry list), what the data suggests
instead and why, and — only when the match data supports it — one macro
note about timing or rotations.

## Phase 2 — live in-match assist

Once you're happy with the coaching quality here, the natural next step is
a near-real-time version using `live.deadlock-api.com`'s event stream
(built for betting platforms, paid API key, ~60-90s delay inherited from
Valve's spectate feed). That's a bigger lift — a background listener,
a buffer of recent game-state events, and a way to surface a suggestion
without breaking your flow mid-fight — happy to help build that next.
