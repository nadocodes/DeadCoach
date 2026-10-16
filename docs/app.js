// DeadCoach website: pulls matches straight from the community Deadlock API
// (api.deadlock-api.com, which allows browser requests), grades each game by
// role against its lobby, and coaches three ways: a free data-driven coach,
// Claude on the viewer's own claude.ai plan (copy/paste), or Claude through the
// viewer's own Anthropic API key (kept in their browser only).

const API = "https://api.deadlock-api.com";
const STEAM64_OFFSET = 76561197960265728n;
const PER_MODE = 15;
const MODES = [["ranked", "Ranked"], ["standard", "Standard"], ["streetbrawl", "Street Brawl"]];
const MODE_LABEL = Object.fromEntries(MODES);
const SLOT_ORDER = ["weapon", "vitality", "spirit"];
const TIER_COST = { 1: 800, 2: 1600, 3: 3200, 4: 6400, 5: 9999 };
const CACHE_VERSION = "v2";
const CLAUDE_MODELS = [["claude-sonnet-5-5", "Sonnet 5.5 (cheaper)"], ["claude-opus-5-5", "Opus 5.5 (deepest)"]];

const state = {
  items: new Map(), itemsById: new Map(), heroes: new Map(),
  account: null, history: [], mode: null, loadToken: 0,
  games: new Map(), matchId: null, game: null, meta: null,
  coachKind: "data", plan: null, planSource: null, ctl: null,
  shopTab: null, shopView: null, shopTabPicked: false, shopViewPicked: false,
};

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mins = s => s ? Math.round(s / 60) + "m" : "?";
const ordinal = n => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const ago = t => {
  if (!t) return "";
  const h = (Date.now() / 1000 - t) / 3600;
  if (h < 1) return "just now";
  if (h < 24) return Math.round(h) + "h ago";
  return Math.round(h / 24) + "d ago";
};
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch { try { Object.keys(localStorage).filter(x => x.startsWith("dc:g:")).slice(0, 50).forEach(x => localStorage.removeItem(x)); localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// What the search box was given: a direct ID in any Steam format, a custom /id/ link, or a name.
function parseInput(raw) {
  const t = String(raw || "").trim();
  let m;
  if ((m = t.match(/steamcommunity\.com\/profiles\/(\d{5,})/i))) return { kind: "id", id: normalizeId(m[1]) };
  if ((m = t.match(/steamcommunity\.com\/id\/([^/?#\s]+)/i))) return { kind: "vanity", vanity: decodeURIComponent(m[1]) };
  if ((m = t.match(/STEAM_[0-5]:([01]):(\d+)/i))) return { kind: "id", id: String(Number(m[2]) * 2 + Number(m[1])) };
  if ((m = t.match(/\[?U:1:(\d+)\]?/i))) return { kind: "id", id: m[1] };
  if (/^\d{5,}$/.test(t)) return { kind: "id", id: normalizeId(t) };
  if (t.length >= 2) return { kind: "name", q: t };
  return null;
}
const toSteam64 = id => String(BigInt(id) + STEAM64_OFFSET);
const steamIdFormats = id => ({ account: id, steam64: toSteam64(id), steam2: `STEAM_1:${Number(id) % 2}:${Math.floor(Number(id) / 2)}`, steam3: `[U:1:${id}]` });

async function searchSteam(q) {
  try { return await api("/v1/players/steam-search", { search_query: q, limit: 50 }); }
  catch { return []; }
}

// Resolve the box's input to an account and load it, or show a list of matching players to pick from.
async function findAndLoad(raw) {
  const parsed = parseInput(raw);
  const finder = $("#finder");
  if (!parsed) { finder.hidden = false; finder.innerHTML = `<div class="finder-msg">Paste a Steam profile link, a SteamID in any format, an account ID, or a Steam name.</div>`; return; }
  if (parsed.kind === "id") { finder.hidden = true; return loadAccount(parsed.id); }
  finder.hidden = false;
  finder.innerHTML = `<div class="finder-msg">Looking up ${esc(parsed.vanity || parsed.q)}…</div>`;
  const q = parsed.vanity || parsed.q;
  const results = await searchSteam(q);
  if (parsed.vanity) {
    const exact = results.find(r => new RegExp(`/id/${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?$`, "i").test(r.profileurl || ""));
    if (exact) { finder.hidden = true; return loadAccount(String(exact.account_id)); }
  }
  if (!results.length) {
    finder.innerHTML = `<div class="finder-msg">No Deadlock players found for “${esc(q)}”. ${parsed.vanity ? "Custom links are matched through Steam names, so try typing the player's Steam name instead." : "Try their exact Steam name, or paste their profile link."}</div>`;
    return;
  }
  finder.innerHTML = `<div class="finder-msg">${parsed.vanity ? `Couldn't match that custom link exactly. Pick the player:` : `Players matching “${esc(q)}”:`}</div>
    <div class="finder-list">${results.slice(0, 12).map(r => `<button type="button" class="finder-row" data-id="${r.account_id}">
      <img src="${esc(r.avatarmedium || r.avatar || "")}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <span><b>${esc(r.personaname)}</b><small>${esc((r.profileurl || "").replace(/^https?:\/\/steamcommunity\.com/, ""))} · account ${r.account_id}</small></span></button>`).join("")}</div>`;
  finder.querySelectorAll(".finder-row").forEach(b => b.onclick = () => { finder.hidden = true; loadAccount(b.dataset.id); });
}

// Show who's loaded plus every ID format, with copy buttons.
async function renderIdCard(id) {
  const el = $("#idcard"); if (!el) return;
  const f = steamIdFormats(id);
  const row = (label, v) => `<span class="idf"><small>${label}</small><code>${esc(v)}</code><button type="button" class="copy" data-v="${esc(v)}" aria-label="Copy ${label}">Copy</button></span>`;
  const draw = p => {
    el.hidden = false;
    el.innerHTML = `${p ? `<a class="who" href="${esc(p.profileurl)}" target="_blank" rel="noopener"><img src="${esc(p.avatarmedium || p.avatar || "")}" alt="" referrerpolicy="no-referrer"><b>${esc(p.personaname)}</b></a>` : ""}
      ${row("Account ID", f.account)}${row("SteamID64", f.steam64)}${row("SteamID", f.steam2)}${row("SteamID3", f.steam3)}
      <span class="idf"><small>Share link</small><code>${esc(location.origin + location.pathname + "?id=" + id)}</code><button type="button" class="copy" data-v="${esc(location.origin + location.pathname + "?id=" + id)}" aria-label="Copy share link">Copy</button></span>`;
    el.querySelectorAll(".copy").forEach(b => b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.v); b.textContent = "Copied"; setTimeout(() => b.textContent = "Copy", 1500); }
      catch { const r = document.createRange(); r.selectNodeContents(b.previousElementSibling); getSelection().removeAllRanges(); getSelection().addRange(r); }
    });
  };
  draw(null);
  try {
    const [p] = await api("/v1/players/steam", { account_ids: id });
    if (p && state.account === id) draw(p);
  } catch { /* the ID formats are still shown */ }
}

function normalizeId(raw) {
  const digits = String(raw).match(/\d{5,}/g);
  if (!digits) return null;
  const n = BigInt(digits[digits.length - 1]);
  return String(n >= STEAM64_OFFSET ? n - STEAM64_OFFSET : n);
}

async function api(path, params = {}, signal) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { signal });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 1500 + attempt * 2500)); continue; }
    if (!res.ok) throw new Error(`The Deadlock API answered ${res.status} for ${path}.`);
    return res.json();
  }
  throw new Error("The Deadlock API is rate-limiting requests right now. Wait a minute and try again.");
}

// ---------------------------------------------------------------- static data
async function loadStatic() {
  const [items, heroes] = await Promise.all([fetch("items.json?v=3").then(r => r.json()), fetch("heroes.json?v=3").then(r => r.json())]);
  for (const i of items) { state.items.set(i.name.toLowerCase(), i); state.itemsById.set(i.id, i); }
  for (const h of heroes) state.heroes.set(h.id, h);
}
const findItem = name => state.items.get(String(name || "").toLowerCase());
const heroName = id => state.heroes.get(id)?.name || `Hero ${id}`;

function modeOf(m) {
  if (m.game_mode === 4) return "streetbrawl";
  if (m.game_mode === 1 && m.match_mode === 4) return "ranked";
  if (m.game_mode === 1 && m.match_mode === 1) return "standard";
  return null;
}

// ---------------------------------------------------------------- grading (role-aware, vs the lobby)
const METRICS = {
  souls: ["Souls", true], hero_damage: ["Hero damage", true], damage_per_soul: ["Damage per soul", true],
  kills: ["Kills", true], assists: ["Assists", true], kill_participation: ["Kill share", true],
  deaths: ["Fewest deaths", false], last_hits: ["Last hits", true], objective_damage: ["Objective damage", true],
  healing_given: ["Healing + barriers given", true], damage_taken: ["Damage soaked", true],
  damage_mitigated: ["Damage mitigated", true], heal_prevented: ["Healing denied", true],
  accuracy: ["Accuracy", true], crit_rate: ["Headshot rate", true],
};
const ROLE_WEIGHTS = {
  gun_carry: { souls: .17, hero_damage: .18, damage_per_soul: .08, kill_participation: .12, deaths: .12, last_hits: .10, objective_damage: .08, accuracy: .07, crit_rate: .08 },
  spirit_carry: { souls: .17, hero_damage: .20, damage_per_soul: .10, kill_participation: .14, deaths: .12, last_hits: .10, objective_damage: .08, kills: .09 },
  tank: { damage_taken: .18, damage_mitigated: .12, kill_participation: .16, assists: .08, deaths: .10, hero_damage: .10, objective_damage: .10, souls: .08, heal_prevented: .08 },
  support: { healing_given: .28, assists: .14, kill_participation: .14, deaths: .14, heal_prevented: .06, hero_damage: .08, souls: .08, damage_per_soul: .08 },
  assassin: { kills: .18, hero_damage: .16, damage_per_soul: .10, kill_participation: .12, deaths: .14, souls: .14, crit_rate: .06, objective_damage: .10 },
  hybrid: { souls: .18, hero_damage: .16, kill_participation: .16, deaths: .14, last_hits: .10, objective_damage: .10, healing_given: .08, damage_taken: .08 },
};
const ROLE_LABELS = { gun_carry: "Gun carry", spirit_carry: "Spirit carry", tank: "Tank", support: "Support", assassin: "Assassin", hybrid: "Hybrid" };
const ROLE_SLOTS = { gun_carry: ["weapon", "vitality", "spirit"], spirit_carry: ["spirit", "vitality", "weapon"], tank: ["vitality", "weapon", "spirit"],
  support: ["spirit", "vitality", "weapon"], assassin: ["weapon", "spirit", "vitality"], hybrid: ["vitality", "weapon", "spirit"] };
const HERO_TYPE_ROLE = { marksman: "gun_carry", mystic: "spirit_carry", brawler: "tank", assassin: "assassin" };
const LANE_METRICS = ["last_hits", "objective_damage"];
const GRADE_BANDS = [[85, "S"], [70, "A"], [55, "B"], [40, "C"], [0, "D"]];

function percentile(value, values, higher) {
  const others = values.slice(); others.splice(others.indexOf(value), 1);
  if (!others.length) return 50;
  const beat = others.filter(v => higher ? v < value : v > value).length;
  const tie = others.filter(v => v === value).length;
  return 100 * (beat + tie / 2) / others.length;
}

function playerMetrics(p, teamKills) {
  const s = p.final_stats || {};
  const souls = p.net_worth || s.net_worth || 0, dmg = s.player_damage || 0;
  const hits = s.shots_hit || 0, shots = hits + (s.shots_missed || 0), heroHits = s.hero_bullets_hit || 0;
  return {
    souls, hero_damage: dmg, damage_per_soul: souls ? +(dmg / souls).toFixed(3) : 0,
    kills: p.kills || 0, assists: p.assists || 0,
    kill_participation: +(((p.kills || 0) + (p.assists || 0)) / (teamKills[p.team] || 1)).toFixed(3),
    deaths: p.deaths || 0, last_hits: p.last_hits || s.creep_kills || 0, objective_damage: s.boss_damage || 0,
    healing_given: (s.teammate_healing || 0) + (s.teammate_barriering || 0),
    damage_taken: s.player_damage_taken || 0, damage_mitigated: s.damage_mitigated || 0, heal_prevented: s.heal_prevented || 0,
    accuracy: shots ? +(hits / shots).toFixed(3) : 0, crit_rate: heroHits ? +((s.hero_bullets_hit_crit || 0) / heroHits).toFixed(3) : 0,
  };
}

function detectRole(hero, build, mine, all) {
  const spend = { weapon: 0, vitality: 0, spirit: 0 };
  for (const b of build) if (b.slot in spend) spend[b.slot] += b.cost || 0;
  const total = spend.weapon + spend.vitality + spend.spirit || 1;
  const share = Object.fromEntries(Object.entries(spend).map(([k, v]) => [k, v / total]));
  const pct = k => Math.round(share[k] * 100);
  const mix = `${pct("weapon")}% weapon / ${pct("vitality")}% vitality / ${pct("spirit")}% spirit`;
  const tags = new Set((hero?.tags || []).map(t => t.toLowerCase()));
  const type = hero?.type, name = hero?.name || "This hero";
  const heal = mine.healing_given, dmg = mine.hero_damage || 1;
  if (heal >= 0.35 * dmg || ((tags.has("support") || tags.has("helpful") || tags.has("protector")) && heal >= 0.15 * dmg))
    return ["support", `Healed/shielded teammates for ${heal.toLocaleString()} (${Math.round(100 * heal / dmg)}% of your damage). Build: ${mix}.`];
  const soakRank = all.map(m => m.damage_taken).sort((a, b) => b - a).indexOf(mine.damage_taken) + 1;
  const frontline = type === "brawler" || tags.has("tank") || soakRank <= Math.max(3, Math.floor(all.length / 3));
  if ((share.vitality >= 0.45 || (tags.has("tank") && share.vitality >= 0.35)) && frontline)
    return ["tank", `Build leaned vitality (${mix}) and you soaked ${mine.damage_taken.toLocaleString()} damage (${soakRank} of ${all.length} in the lobby).`];
  if (share.vitality >= 0.45) {
    const role = share.spirit >= share.weapon ? "spirit_carry" : type === "assassin" ? "assassin" : "gun_carry";
    return [role, `Vitality-heavy build (${mix}) but you weren't on the front line, so graded as a ${ROLE_LABELS[role].toLowerCase()}.`];
  }
  if (share.spirit >= 0.45) return ["spirit_carry", `Build leaned spirit (${mix}).`];
  if (share.weapon >= 0.45) return [type === "assassin" ? "assassin" : "gun_carry", `Build leaned weapon (${mix}); ${name} is ${type ? (type === "assassin" ? "an assassin" : "a " + type) : "a flex"} hero.`];
  const role = HERO_TYPE_ROLE[type] || "hybrid";
  return [role, `Mixed build (${mix}), so graded on ${name}'s usual ${type || "flex"} role.`];
}

function gradePlayer(players, me, won, hero, build, mode, durationS) {
  const teamKills = {};
  for (const p of players) teamKills[p.team] = (teamKills[p.team] || 0) + (p.kills || 0);
  const all = players.map(p => playerMetrics(p, teamKills)), mine = playerMetrics(me, teamKills);
  const [role, reason] = detectRole(hero, build, mine, all);
  let weights = { ...ROLE_WEIGHTS[role] };
  if (mode === "streetbrawl") LANE_METRICS.forEach(k => delete weights[k]);
  const norm = Object.values(weights).reduce((a, b) => a + b, 0);
  weights = Object.fromEntries(Object.entries(weights).map(([k, w]) => [k, w / norm]));
  const breakdown = {}; let score = 0;
  for (const [key, [label, higher]] of Object.entries(METRICS)) {
    const values = all.map(m => m[key]);
    const ordered = values.slice().sort((a, b) => higher ? b - a : a - b);
    breakdown[key] = { label, value: mine[key], rank: ordered.indexOf(mine[key]) + 1, of: values.length, weight: +(weights[key] || 0).toFixed(3) };
    if (weights[key]) score += weights[key] * percentile(mine[key], values, higher);
  }
  score = Math.max(0, Math.min(100, Math.round(score + (won ? 4 : -4))));
  const letter = GRADE_BANDS.find(([floor]) => score >= floor)[1];
  const minutes = Math.max(1, (durationS || 60) / 60);
  return {
    letter, score, role, role_label: ROLE_LABELS[role], role_reason: reason, breakdown,
    per_min: { damage: Math.round(mine.hero_damage / minutes), healing: Math.round(mine.healing_given / minutes), souls: Math.round(mine.souls / minutes), damage_taken: Math.round(mine.damage_taken / minutes) },
  };
}

// A short scorecard line built from the numbers (the free stand-in for an AI quote).
function phraseFor(key, r) {
  if (key === "deaths") return r.rank === 1 ? "fewest deaths in the lobby" : r.rank <= 3 ? `${ordinal(r.rank)}-fewest deaths of ${r.of}` : `${r.value} deaths (${ordinal(r.rank)} of ${r.of})`;
  const label = r.label.toLowerCase();
  return r.rank === 1 ? `most ${label} in the lobby` : `${ordinal(r.rank)} of ${r.of} in ${label}`;
}
function quoteFor(g) {
  const rows = Object.entries(g.grade.breakdown).filter(([, r]) => r.weight);
  const [bk, best] = rows.slice().sort((a, b) => a[1].rank - b[1].rank || b[1].weight - a[1].weight)[0];
  const [wk, worst] = rows.slice().sort((a, b) => b[1].rank - a[1].rank || b[1].weight - a[1].weight)[0];
  const cap = t => t[0].toUpperCase() + t.slice(1);
  const b = phraseFor(bk, best), w = phraseFor(wk, worst), role = g.grade.role_label.toLowerCase();
  if ("SA".includes(g.grade.letter)) return `${cap(b)}. A ${role} game done right.`;
  if (g.grade.letter === "B") return `${cap(b)}, held back by ${w}.`;
  return g.won ? `${cap(w)}; the team carried the rest.` : `${cap(w)}; ${b} wasn't enough to carry it.`;
}

// ---------------------------------------------------------------- loading
async function loadAccount(id) {
  const token = ++state.loadToken;
  state.account = id; state.history = []; state.games = new Map(); state.matchId = null; state.mode = null;
  $("#acctInput").value = id;
  store.set("dc:account", id);
  history.replaceState(null, "", "?id=" + id);
  $("#acctMeta").textContent = "";
  renderIdCard(id);
  $("#ledger").innerHTML = `<div class="notice">Loading matches for ${esc(id)}…</div>`;
  showEmptyMain();
  try {
    const hist = await api(`/v1/players/${id}/match-history`);
    if (token !== state.loadToken) return;
    const counts = {};
    state.history = (Array.isArray(hist) ? hist : hist.matches || [])
      .sort((a, b) => b.start_time - a.start_time)
      .map(m => ({ ...m, mode: modeOf(m) }))
      .filter(m => m.mode && (counts[m.mode] = (counts[m.mode] || 0) + 1) <= PER_MODE)
      .map(m => ({ match_id: m.match_id, mode: m.mode, hero_id: m.hero_id, hero: heroName(m.hero_id), won: m.match_result === m.player_team,
        start_time: m.start_time, duration_s: m.match_duration_s, kills: m.player_kills, deaths: m.player_deaths, assists: m.player_assists, net_worth: m.net_worth,
        rounds: m.mode === "streetbrawl" && m.brawl_score_team0 != null ? `${m[`brawl_score_team${m.player_team}`]}-${m[`brawl_score_team${1 - m.player_team}`]}` : null }));
    for (const m of state.history) { const g = store.get(`dc:g:${CACHE_VERSION}:${id}:${m.match_id}`); if (g) state.games.set(m.match_id, g); }
    $("#acctMeta").textContent = `live from deadlock-api.com`;
    if (!state.history.length) { $("#ledger").innerHTML = `<div class="notice">No Ranked, Standard or Street Brawl matches found for ${esc(id)}. Check the ID: it's the 32-bit account ID or a SteamID64.</div>`; return; }
    renderLedger();
  } catch (e) {
    if (token !== state.loadToken) return;
    $("#ledger").innerHTML = `<div class="notice">${esc(e.message || "Couldn't reach the Deadlock API.")} Check the ID and try again.</div>`;
  }
}

// Fetch lobby data for any listed games we haven't graded yet (10 per request, ~120 KB each).
async function ensureGames(list) {
  const token = state.loadToken, acct = state.account;
  const todo = list.filter(m => m && !state.games.has(m.match_id) && !m.loading && !m.failed);
  for (let i = 0; i < todo.length; i += 10) {
    const chunk = todo.slice(i, i + 10);
    chunk.forEach(m => m.loading = true);
    try {
      const metas = await api("/v1/matches/metadata", { match_ids: chunk.map(m => m.match_id).join(","), include_player_info: true,
        include_player_kda: true, include_player_items: true, include_player_final_stats: true });
      if (token !== state.loadToken) return;
      for (const md of metas) {
        const summary = chunk.find(m => m.match_id === md.match_id);
        const g = summary && buildGame(acct, md, summary);
        if (g) { state.games.set(g.match_id, g); store.set(`dc:g:${CACHE_VERSION}:${acct}:${g.match_id}`, g); }
      }
      chunk.forEach(m => { if (!state.games.has(m.match_id)) m.failed = true; });
    } catch { chunk.forEach(m => m.failed = true); }
    chunk.forEach(m => m.loading = false);
    renderLedger(true);
  }
}

function buildGame(acct, md, summary) {
  const players = md.players || [];
  const me = players.find(p => String(p.account_id) === String(acct));
  if (!me) return null;
  const build = (me.items || []).map(it => {
    const item = state.itemsById.get(it.item_id);
    return item && { item: item.name, slot: item.slot, tier: item.tier, cost: item.cost,
      bought_min: +(it.game_time_s / 60).toFixed(1), sold_min: it.sold_time_s ? +(it.sold_time_s / 60).toFixed(1) : null };
  }).filter(Boolean);
  const grade = gradePlayer(players, me, summary.won, state.heroes.get(me.hero_id), build, summary.mode, md.duration_s || summary.duration_s);
  const s = me.final_stats || {};
  const g = {
    ...summary, hero_id: me.hero_id, hero: heroName(me.hero_id), lane: me.assigned_lane, level: me.player_level,
    last_hits: me.last_hits, denies: me.denies, net_worth: me.net_worth,
    enemy_ids: players.filter(p => p.team !== me.team).map(p => p.hero_id),
    allies: players.filter(p => p.team === me.team && p !== me).map(p => heroName(p.hero_id)),
    enemies: players.filter(p => p.team !== me.team).map(p => heroName(p.hero_id)),
    hero_damage: s.player_damage, damage_taken: s.player_damage_taken, healing: s.player_healing,
    build, grade,
  };
  g.quote = quoteFor(g);
  return g;
}

async function loadMeta(g) {
  const key = `dc:meta:${g.hero_id}:${g.mode === "streetbrawl" ? "sb" : "n"}:${g.enemy_ids.slice().sort().join("-")}`;
  const cached = store.get(key);
  if (cached && Date.now() - cached.at < 24 * 3600 * 1000) return cached.rows;
  const raw = await api("/v1/analytics/item-stats", { hero_ids: g.hero_id, enemy_hero_ids: g.enemy_ids.join(","),
    game_mode: g.mode === "streetbrawl" ? "street_brawl" : "normal", min_matches: 20 });
  const owned = new Set(g.build.map(b => b.item));
  let rows = (raw || []).map(r => { const it = state.itemsById.get(r.item_id); return it && r.matches ? {
    item: it.name, slot: it.slot, tier: it.tier, matches: r.matches, wins: r.wins,
    win_rate: +(100 * r.wins / r.matches).toFixed(1), avg_buy_min: +((r.avg_buy_time_s || 0) / 60).toFixed(1) } : null; }).filter(Boolean);
  rows.sort((a, b) => b.matches - a.matches);
  rows = rows.slice(0, 45).concat(rows.slice(45).filter(r => owned.has(r.item)));
  store.set(key, { at: Date.now(), rows });
  return rows;
}

// ---------------------------------------------------------------- ledger
function renderLedger(keepScroll) {
  const el = $("#ledger"), byMode = Object.fromEntries(MODES.map(([k]) => [k, state.history.filter(m => m.mode === k)]));
  if (!state.mode) { const saved = store.get("dc:mode"); state.mode = byMode[saved]?.length ? saved : state.history[0]?.mode || "standard"; }
  const list = byMode[state.mode] || [];
  const wins = list.filter(m => m.won).length;
  const graded = list.map(m => state.games.get(m.match_id)).filter(Boolean);
  const avg = graded.length ? Math.round(graded.reduce((t, g) => t + g.grade.score, 0) / graded.length) : null;
  const scrollTop = keepScroll ? $(".ledger")?.scrollTop : 0;
  el.innerHTML = `<div class="tabs" role="tablist" aria-label="Game mode">${MODES.map(([k, label]) => {
      const ms = byMode[k], w = ms.filter(m => m.won).length;
      return `<button type="button" class="tab" role="tab" data-mode="${k}" aria-selected="${k === state.mode}">${label}<small>${ms.length ? `${w}–${ms.length - w}` : "none"}</small></button>`;
    }).join("")}</div>
    <div class="modesum"><span>${list.length ? `${wins}–${list.length - wins} over last ${list.length}` : ""}</span><span class="mono">${avg != null ? `avg score ${avg}` : ""}</span></div>
    ${list.length ? `<div class="ledger">${list.map(m => {
      const g = state.games.get(m.match_id);
      return `<button type="button" class="row ${m.won ? "win" : ""}" data-id="${m.match_id}" aria-current="${m.match_id === state.matchId}">
      <span class="stripe"></span>
      <span><span class="hero">${esc(m.hero)}</span><br><span class="sub mono">${g ? `${esc(g.grade.role_label)} · ` : ""}${m.kills}/${m.deaths}/${m.assists} · ${g?.rounds ? `rounds ${esc(g.rounds)} · ` : ""}${mins(m.duration_s)} · ${ago(m.start_time)}</span>${g ? `<span class="quote">${esc(g.quote)}</span>` : ""}</span>
      <span class="right"><span class="res">${m.won ? "WIN" : "LOSS"}</span>${g ? `<span class="grade ${g.grade.letter}" title="Score ${g.grade.score}/100">${g.grade.letter}</span>` : (m.failed ? `<span class="grade pending" title="No lobby data from the API yet">–</span>` : `<span class="grade pending" title="Grading…">·</span>`)}</span></button>`;
    }).join("")}</div>` : `<div class="notice">No ${MODE_LABEL[state.mode]} games in your recent history.</div>`}`;
  if (keepScroll && $(".ledger")) $(".ledger").scrollTop = scrollTop;
  el.querySelectorAll(".tab").forEach(t => t.onclick = () => { state.mode = t.dataset.mode; store.set("dc:mode", state.mode); renderLedger(); });
  el.querySelectorAll(".row").forEach(r => r.onclick = () => selectMatch(Number(r.dataset.id)));
  ensureGames(list);
  if (!state.matchId && list.length) selectMatch(list[0].match_id);
}

// ---------------------------------------------------------------- match view
function showEmptyMain() {
  state.matchId = null; state.game = null;
  $("#main").innerHTML = `<div class="empty-main">Pick a match on the left to see your build and get coached.</div>`;
}

async function selectMatch(matchId) {
  state.ctl?.abort();
  state.matchId = matchId; state.game = null; state.meta = null; state.plan = null; state.planSource = null;
  state.shopTabPicked = false; state.shopViewPicked = false;
  document.querySelectorAll(".row").forEach(r => r.setAttribute("aria-current", String(Number(r.dataset.id) === matchId)));
  $("#main").innerHTML = `<div class="empty-main">Loading match ${matchId}…</div>`;
  const summary = state.history.find(m => m.match_id === matchId);
  if (!state.games.has(matchId)) {
    if (summary) summary.failed = false;
    if (!summary?.loading) await ensureGames([summary]);
    for (let i = 0; i < 100 && summary?.loading; i++) await new Promise(r => setTimeout(r, 300));
  }
  if (state.matchId !== matchId) return;
  const g = state.games.get(matchId);
  if (!g) { $("#main").innerHTML = `<div class="empty-main">This match's details aren't available from the API yet. Try again in a few minutes.</div>`; return; }
  state.game = g;
  renderMatch();
  try {
    state.meta = await loadMeta(g);
  } catch { state.meta = []; }
  if (state.matchId !== matchId) return;
  const saved = store.get(`dc:plan:${state.account}:${matchId}`);
  if (saved) { state.plan = saved.plan; state.planSource = saved.source; state.coachKind = saved.source; }
  else { state.plan = dataCoach(g, state.meta); state.planSource = "data"; if (state.coachKind !== "data") state.coachKind = "data"; }
  renderMeta(); renderCoach();
}

const PCT_KEYS = new Set(["kill_participation", "accuracy", "crit_rate"]);
function fmtMetric(k, v) {
  if (PCT_KEYS.has(k)) return Math.round(v * 100) + "%";
  if (k === "damage_per_soul") return v.toFixed(2);
  if (v >= 10000) return (v / 1000).toFixed(1) + "k";
  return v.toLocaleString();
}
function metricRows(list, counted) {
  return list.map(([k, r]) => `<span class="${counted ? "" : "off"}">${esc(r.label)}</span><span class="v ${counted ? "" : "off"}">${fmtMetric(k, r.value)}</span>
    <span class="r ${r.rank <= 3 ? "top" : r.rank >= r.of - 2 ? "bottom" : ""}">${ordinal(r.rank)}/${r.of}</span>
    <span class="w">${counted ? `<b style="width:${Math.round(r.weight * 220)}px"></b>${Math.round(r.weight * 100)}%` : "–"}</span>`).join("");
}

function renderMatch() {
  const m = state.game, gr = m.grade;
  const rows = Object.entries(gr.breakdown);
  const counted = rows.filter(([, r]) => r.weight).sort((a, b) => b[1].weight - a[1].weight), other = rows.filter(([, r]) => !r.weight);
  $("#main").innerHTML = `
    <div class="scorecard">
      <div style="min-width:0">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><h2>${esc(m.hero)}</h2><span class="verdict ${m.won ? "win" : "loss"}">${m.won ? "WIN" : "LOSS"}</span><span class="modetag">${esc(MODE_LABEL[m.mode])}${m.rounds ? ` · rounds ${esc(m.rounds)}` : ""}</span></div>
        <div class="vs"><span class="muted">vs</span> <b>${m.enemies.map(esc).join(", ")}</b></div>
        <div class="vs muted" style="margin-top:2px;font-size:14px">with ${m.allies.map(esc).join(", ")}</div>
      </div>
      <dl class="stats" style="margin:0">
        <div><dt>K/D/A</dt><dd>${m.kills}/${m.deaths}/${m.assists}</dd></div>
        <div><dt>Souls</dt><dd>${(m.net_worth / 1000).toFixed(1)}k</dd></div>
        <div><dt>Dmg / min</dt><dd>${gr.per_min.damage.toLocaleString()}</dd></div>
        <div><dt>${gr.per_min.healing ? "Heal / min" : "Last hits"}</dt><dd>${gr.per_min.healing ? gr.per_min.healing.toLocaleString() : m.last_hits}</dd></div>
        <div><dt>Soaked / min</dt><dd>${gr.per_min.damage_taken.toLocaleString()}</dd></div>
        <div><dt>Length</dt><dd>${mins(m.duration_s)}</dd></div>
      </dl>
      <div class="gradeblock">
        <div style="display:flex;gap:12px;align-items:center"><span class="grade big ${gr.letter}">${gr.letter}</span><span class="score">Score<br><b style="font-size:20px;color:var(--fg)">${gr.score}</b>/100</span></div>
        <blockquote>${esc(m.quote)}</blockquote>
        <div style="flex:1 1 260px;min-width:0"><span class="rolechip"><i></i>Graded as ${esc(gr.role_label)}</span><div class="rolewhy">${esc(gr.role_reason)}</div></div>
        <div class="metrics">
          <span class="hd">Counted for this role</span><span class="hd" style="justify-content:flex-end">You</span><span class="hd" style="justify-content:flex-end">Lobby</span><span class="hd wh">Weight</span>
          ${metricRows(counted, true)}
          ${other.length ? `<span class="hd">Also tracked</span><span class="hd"></span><span class="hd"></span><span class="hd wh"></span>${metricRows(other, false)}` : ""}
        </div>
      </div>
    </div>
    <div class="coach" id="coach"><div class="cv-wait"><span class="spin"></span>Pulling meta stats for this lineup…</div></div>
    <div class="shop" id="shop"></div>
    <div class="two">
      <section>
        <h3 class="label">Your build, in buy order</h3>
        <ol class="build">${m.build.map(b => `<li class="${b.slot} ${b.sold_min != null ? "sold" : ""}">
          <span class="t">${b.bought_min.toFixed(1)}m</span><span class="dot"></span>
          <span class="name"><span class="bi">${tile(b.item, { size: "xs" })}</span>${esc(b.item)}${b.sold_min != null ? ` <span class="muted mono" style="font-size:12px">sold ${b.sold_min.toFixed(1)}m</span>` : ""}</span>
          <span class="tier">T${b.tier}</span></li>`).join("")}</ol>
        <div class="legend">${SLOT_ORDER.map(s => `<span class="${s}"><span class="dot"></span>${s}</span>`).join("")}<span>struck = sold</span></div>
      </section>
      <section id="metaSection">
        <h3 class="label">${esc(m.hero)} items vs this lineup</h3>
        <div class="muted">Loading…</div>
      </section>
    </div>`;
}

function renderMeta() {
  const el = $("#metaSection"); if (!el) return;
  const m = state.game, bought = new Set(m.build.map(b => b.item));
  if (!state.meta?.length) { el.innerHTML = `<h3 class="label">${esc(m.hero)} items vs this lineup</h3><div class="muted">No meta stats came back for this lineup.</div>`; return; }
  el.innerHTML = `<h3 class="label">${esc(m.hero)} items vs this lineup</h3>
    <div class="tablewrap"><table>
      <thead><tr><th>Item</th><th style="text-align:right">Win %</th><th style="text-align:right">Avg buy</th><th style="text-align:right">Games</th></tr></thead>
      <tbody>${state.meta.slice(0, 35).map(r => `<tr class="${r.slot} ${bought.has(r.item) ? "mine" : ""}">
        <td><span class="nm">${tile(r.item, { size: "xs" })}${esc(r.item)}</span></td>
        <td class="num"><span class="wr">${r.win_rate.toFixed(1)}<span class="bar ${r.win_rate >= 51 ? "hi" : r.win_rate <= 48 ? "lo" : ""}"><i style="width:${Math.max(0, Math.min(100, (r.win_rate - 35) / 30 * 100))}%"></i></span></span></td>
        <td class="num">${r.avg_buy_min.toFixed(1)}m</td>
        <td class="num">${r.matches >= 1000 ? Math.round(r.matches / 1000) + "k" : r.matches}</td></tr>`).join("")}</tbody>
    </table></div>
    <div class="legend"><span>Bar centre line = 50%. Scale 35–65%.</span></div>`;
}

// ---------------------------------------------------------------- item tiles (in-game shop look)
function tile(name, opts = {}) {
  const it = findItem(name) || { name, slot: opts.slot || "weapon", cost: TIER_COST[opts.tier] || "", tier: opts.tier };
  const cls = ["it", it.slot, opts.size || "", opts.state || ""].join(" ");
  const icon = it.icon ? `<img src="${it.icon}" alt="" loading="lazy">` : `<span class="fb">${esc((it.name || "?")[0])}</span>`;
  if (opts.size === "xs") return `<span class="${cls}" title="${esc(it.name)}"><span class="ic">${icon}</span></span>`;
  const tip = `${it.name} · ${it.cost} souls${it.active ? " · active" : ""}${it.desc ? " — " + it.desc : ""}`;
  return `<div class="${cls}" title="${esc(tip)}" data-item="${esc(it.name)}">
    <div class="ic">${icon}</div><div class="nm">${esc(it.name)}</div><div class="co"><i></i>${(it.cost || "").toLocaleString()}</div>
    ${it.active ? `<span class="act">ACTIVE</span>` : ""}${opts.order ? `<span class="ord">${opts.order}</span>` : ""}${opts.owned ? `<span class="own">OWNED</span>` : ""}</div>`;
}
const chip = name => `<span class="ichip">${tile(name, { size: "xs" })}${esc(findItem(name)?.name || name)}</span>`;
const inl = t => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

// ---------------------------------------------------------------- free data coach
function dataCoach(g, meta) {
  const rows = new Map((meta || []).map(r => [r.item, r]));
  const totalM = (meta || []).reduce((t, r) => t + r.matches, 0), totalW = (meta || []).reduce((t, r) => t + r.wins, 0);
  const base = totalM ? 100 * totalW / totalM : 50;
  const maxM = Math.max(1, ...(meta || []).map(r => r.matches));
  const solid = r => r && r.matches >= Math.max(300, maxM * 0.02);
  const finals = g.build.filter(b => b.sold_min == null);
  const owned = new Set(g.build.map(b => b.item));
  const good = finals.map(b => rows.get(b.item)).filter(r => solid(r) && r.win_rate >= base + 1.5).sort((a, b) => b.win_rate - a.win_rate);
  const bad = finals.map(b => rows.get(b.item)).filter(r => solid(r) && r.win_rate <= base - 1.5).sort((a, b) => a.win_rate - b.win_rate);
  const score = r => (r.win_rate - base) * Math.log10(r.matches);
  const taken = new Set();
  const pick = (slot, tier) => (meta || []).filter(r => !owned.has(r.item) && !taken.has(r.item) && r.slot === slot && Math.abs(r.tier - tier) <= 1 && solid(r) && r.win_rate >= base + 1)
    .sort((a, b) => (Math.abs(a.tier - tier) - Math.abs(b.tier - tier)) || score(b) - score(a))[0];
  const swaps = [];
  for (const r of bad.slice(0, 3)) {
    const c = pick(r.slot, r.tier);
    if (c) { taken.add(c.item); swaps.push({ out: r.item, in: c.item, by_min: Math.round(c.avg_buy_min), why: `${c.win_rate}% win rate vs this lineup, against ${r.win_rate}% for ${r.item}.` }); }
  }
  const roleSlots = ROLE_SLOTS[g.grade.role];
  const popular = (meta || []).filter(r => !owned.has(r.item) && !taken.has(r.item) && solid(r) && r.win_rate >= base + 0.5 && r.tier >= 2)
    .sort((a, b) => (roleSlots.indexOf(a.slot) - roleSlots.indexOf(b.slot)) * 0.5 + (score(b) - score(a)));
  while (swaps.length < 2 && popular.length) {
    const c = popular.shift(); taken.add(c.item);
    swaps.push({ out: null, in: c.item, by_min: Math.round(c.avg_buy_min), why: `${c.win_rate}% win rate for ${g.hero} vs this lineup across ${c.matches.toLocaleString()} games.` });
  }
  // Final build: your finished items, swaps applied, filled up to 12 with strong picks for your role, in meta buy order.
  let build = finals.map(b => b.item).filter(n => !swaps.some(s => s.out === n));
  swaps.forEach(s => build.push(s.in));
  const fill = popular.filter(r => !build.includes(r.item));
  while (build.length < 12 && fill.length) build.push(fill.shift().item);
  build = build.slice(0, 16).map(n => {
    const r = rows.get(n), mine = g.build.find(b => b.item === n);
    return { item: n, by_min: Math.round(r?.avg_buy_min || mine?.bought_min || 0),
      why: r ? `${r.win_rate}% win rate, usually bought around ${Math.round(r.avg_buy_min)}m` : "Kept from your build" };
  }).sort((a, b) => a.by_min - b.by_min);

  const br = g.grade.breakdown, weighted = Object.entries(br).filter(([, r]) => r.weight);
  const bestM = weighted.slice().sort((a, b) => a[1].rank - b[1].rank || b[1].weight - a[1].weight)[0];
  const worstM = weighted.slice().sort((a, b) => b[1].rank - a[1].rank || b[1].weight - a[1].weight)[0];
  const did_well = [];
  if (bestM) did_well.push({ title: `${bestM[1].label}: ${ordinal(bestM[1].rank)} of ${bestM[1].of}`, detail: `${fmtMetric(bestM[0], bestM[1].value)} ${bestM[1].label.toLowerCase()}, one of the things a ${g.grade.role_label.toLowerCase()} is judged on most (${Math.round(bestM[1].weight * 100)}% of your grade).`, items: [] });
  if (good.length) did_well.push({ title: "Strong item picks", detail: good.slice(0, 2).map(r => `**${r.item}** wins ${r.win_rate}% for ${g.hero} against this lineup (baseline ${base.toFixed(1)}%).`).join(" "), items: good.slice(0, 2).map(r => r.item) });
  const late = finals.map(b => ({ b, r: rows.get(b.item) })).filter(x => solid(x.r) && x.b.tier >= 3 && x.b.bought_min - x.r.avg_buy_min >= 4).sort((a, b) => (b.b.bought_min - b.r.avg_buy_min) - (a.b.bought_min - a.r.avg_buy_min));
  const biggest_miss = bad[0]
    ? { title: `${bad[0].item} underperformed`, detail: `**${bad[0].item}** wins only ${bad[0].win_rate}% for ${g.hero} against ${g.enemies.slice(0, 3).join(", ")}${g.enemies.length > 3 ? " and co." : ""}, below the ${base.toFixed(1)}% baseline for this matchup across ${bad[0].matches.toLocaleString()} games.`, items: [bad[0].item] }
    : worstM ? { title: `${worstM[1].label}: ${ordinal(worstM[1].rank)} of ${worstM[1].of}`, detail: `Your weakest area for a ${g.grade.role_label.toLowerCase()}: ${fmtMetric(worstM[0], worstM[1].value)}. It carries ${Math.round(worstM[1].weight * 100)}% of the grade for this role.`, items: [] } : null;
  const do_instead = swaps.slice(0, 2).map(s => ({ title: s.out ? `Swap ${s.out} for ${s.in}` : `Add ${s.in}`, detail: s.why, items: [s.in] }));
  if (late[0]) do_instead.push({ title: `Get ${late[0].b.item} sooner`, detail: `You bought it at ${Math.round(late[0].b.bought_min)}m; players who buy it in this matchup average ${Math.round(late[0].r.avg_buy_min)}m.`, items: [late[0].b.item] });
  const d = br.deaths, souls = br.souls;
  const macro = d && d.rank >= d.of - 2 ? { title: `${d.value} deaths, ${ordinal(d.rank)} of ${d.of}`, detail: `Each death hands souls to the enemy and costs you time on the map. Cutting a few would have done more for this game than any single item.` }
    : souls && souls.rank >= souls.of - 3 ? { title: `Souls ${ordinal(souls.rank)} of ${souls.of}`, detail: `You finished with ${fmtMetric("souls", souls.value)} souls (${g.grade.per_min.souls}/min). More time farming between fights would get your key items online on time.` } : null;
  const headline = `${g.grade.letter} game as a ${g.grade.role_label.toLowerCase()}. ${g.quote}`;
  return { headline, did_well, biggest_miss, do_instead: do_instead.slice(0, 3), macro, swaps, final_build: build };
}

// ---------------------------------------------------------------- Claude coaching (prompt shared by both Claude options)
const COACH_RULES = `You are a veteran Deadlock coach helping a player who wants to genuinely learn macro decision-making and itemization, not just be told what to buy.

You are given JSON for one match: the game mode (ranked and standard are the normal 6v6 mode; streetbrawl is the short 4v4 round-based mode, where laning and objectives matter much less), the role they actually played (gun carry, spirit carry, tank, support, assassin or hybrid, detected from their build's soul spend, healing given and hero type) and a role-weighted grade S-D from where they ranked in the lobby (grade.breakdown has every metric with rank and the weight it carried for that role), the per-minute numbers, the player's hero, allies, enemies, result, KDA, net worth, lane, and their build in purchase order (bought_min / sold_min are game minutes; slot is weapon / vitality / spirit; tier 1-4). You also get "meta_items_vs_this_comp": item win rates and average buy minute for this hero in matches against these enemy heroes (large public sample; win rates near 50% are neutral).

Coach like a veteran talking to a student: concrete, a clear opinion, name the enemy heroes and what they threaten, cite the meta numbers, and note real uncertainty (sample size, patch changes) briefly. Only make a macro point if the match data supports something specific.`;

const PLAN_FORMAT = `Reply with only one JSON object in exactly this shape:
{
  "headline": "one-sentence verdict on this game, max 22 words",
  "did_well": [{"title": "max 7 words", "detail": "1-2 sentences tied to the data", "items": ["exact item names, optional"]}],
  "biggest_miss": {"title": "max 7 words", "detail": "2-3 sentences: why it mattered against these specific enemy heroes", "items": ["..."]},
  "do_instead": [{"title": "max 7 words", "detail": "1-2 sentences citing the meta numbers", "items": ["..."]}],
  "macro": {"title": "max 7 words", "detail": "1-2 sentences"} or null if the data doesn't support a specific macro point,
  "swaps": [{"out": "an item they bought, or null if this fills an empty slot", "in": "item to buy instead", "by_min": 14, "why": "max 16 words"}],
  "final_build": [{"item": "exact item name", "by_min": 6, "why": "max 12 words"}]
}
Rules: did_well has 1-2 entries, do_instead 1-3, swaps 2-4. final_build is the full build they should have finished this game with, in purchase order, 10-16 items, with realistic by_min timings for this game's length and their net worth (souls). Keep what was right about their build; it is a corrected version of their build for this hero, role and enemy lineup, not a generic meta list. Use exact item names from the catalog below; never invent items.`;

function catalogForPrompt() {
  const lines = [];
  for (const slot of SLOT_ORDER) for (const t of [1, 2, 3, 4, 5]) {
    const names = [...state.items.values()].filter(i => i.slot === slot && i.tier === t).map(i => i.name + (i.active ? " (active)" : ""));
    if (names.length) lines.push(`${slot} T${t} (${TIER_COST[t]}): ${names.join(", ")}`);
  }
  return lines.join("\n");
}
function matchPayload() {
  const { enemy_ids, quote, loading, ...m } = state.game;
  return JSON.stringify({ ...m, meta_items_vs_this_comp: (state.meta || []).map(({ wins, ...r }) => r) });
}
const fullPrompt = () => `${COACH_RULES}\n\n${PLAN_FORMAT}\n\nItem catalog (slot, tier, cost):\n${catalogForPrompt()}\n\nMatch data:\n${matchPayload()}`;

// A compact version of the request for claude.ai, small enough to pre-fill through the link.
function claudeAiPrompt() {
  const g = state.game, gr = g.grade;
  const ranks = Object.values(gr.breakdown).filter(r => r.weight).map(r => `${r.label} ${fmtMetric(Object.keys(gr.breakdown).find(k => gr.breakdown[k] === r), r.value)} (${r.rank}/${r.of}, ${Math.round(r.weight * 100)}%)`).join("; ");
  const build = g.build.map(b => `${b.item} ${Math.round(b.bought_min)}m${b.sold_min != null ? ` (sold ${Math.round(b.sold_min)}m)` : ""}`).join(", ");
  const meta = (state.meta || []).slice(0, 30).map(r => `${r.item} ${r.win_rate}% @${Math.round(r.avg_buy_min)}m n=${r.matches >= 1000 ? Math.round(r.matches / 1000) + "k" : r.matches}`).join("; ");
  const names = SLOT_ORDER.map(sl => `${sl}: ${[...state.items.values()].filter(i => i.slot === sl).map(i => i.name).join(", ")}`).join("\n");
  return `You're a veteran Deadlock coach. Coach this player on itemization and macro: concrete, a clear opinion, name the enemy heroes and what they threaten, cite the win-rate numbers.

MATCH ${g.match_id} · ${MODE_LABEL[g.mode]}${g.mode === "streetbrawl" ? " (short 4v4 rounds; laning matters less)" : ""} · ${g.won ? "WIN" : "LOSS"} · ${mins(g.duration_s)}
Hero ${g.hero} played as ${gr.role_label} (${gr.role_reason}) · grade ${gr.letter} ${gr.score}/100
K/D/A ${g.kills}/${g.deaths}/${g.assists} · souls ${g.net_worth} · dmg/min ${gr.per_min.damage} · heal/min ${gr.per_min.healing}
Enemies: ${g.enemies.join(", ")} · Allies: ${g.allies.join(", ")}
Lobby ranks for this role (value, rank/players, weight): ${ranks}
Build in buy order: ${build}
${g.hero} item win rates vs this enemy lineup (win%, avg buy minute, games): ${meta}

Reply with ONE \`\`\`json code block and nothing else. Don't make an artifact or file. Shape:
{"match_id": ${g.match_id}, "headline": "max 22 words", "did_well": [{"title": "max 7 words", "detail": "1-2 sentences", "items": []}], "biggest_miss": {"title": "", "detail": "2-3 sentences on these enemies", "items": []}, "do_instead": [{"title": "", "detail": "cite numbers", "items": []}], "macro": null or {"title": "", "detail": ""}, "swaps": [{"out": "item they bought or null", "in": "item", "by_min": 14, "why": "max 16 words"}], "final_build": [{"item": "", "by_min": 6, "why": "max 12 words"}]}
did_well 1-2, do_instead 1-3, swaps 2-4, final_build 10-16 items in buy order: a corrected version of their build for this hero, role and lineup. Use exact item names from:
${names}`;
}

function cleanPlan(p) {
  if (!p || typeof p !== "object") return null;
  const known = n => !!findItem(n), canon = n => findItem(n)?.name || n, arr = v => Array.isArray(v) ? v : [];
  const fixCard = c => c && typeof c === "object" ? { title: String(c.title || ""), detail: String(c.detail || ""), items: arr(c.items).filter(known).map(canon) } : null;
  const plan = {
    headline: String(p.headline || ""),
    did_well: arr(p.did_well).map(fixCard).filter(Boolean).slice(0, 2),
    biggest_miss: fixCard(p.biggest_miss),
    do_instead: arr(p.do_instead).map(fixCard).filter(Boolean).slice(0, 3),
    macro: fixCard(p.macro),
    swaps: arr(p.swaps).filter(s => s && known(s.in)).map(s => ({ out: s.out && known(s.out) ? canon(s.out) : null, in: canon(s.in), by_min: Number(s.by_min) || null, why: String(s.why || "") })).slice(0, 4),
    final_build: arr(p.final_build).filter(f => f && known(f.item)).map(f => ({ item: canon(f.item), by_min: Number(f.by_min) || null, why: String(f.why || "") })).slice(0, 16),
  };
  return plan.biggest_miss || plan.final_build.length ? plan : null;
}
// Find the coaching JSON in whatever was pasted: code fences, smart quotes, trailing commas and text around it are all fine.
function parseJsonLoose(text) {
  const clean = String(text || "").replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  const tryParse = c => { try { return JSON.parse(c); } catch { try { return JSON.parse(c.replace(/,\s*([}\]])/g, "$1")); } catch { return null; } } };
  const candidates = [];
  for (const m of clean.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  // every balanced {...} block, largest first
  for (let i = clean.indexOf("{"); i >= 0 && candidates.length < 60; i = clean.indexOf("{", i + 1)) {
    let depth = 0, inStr = false;
    for (let j = i; j < clean.length; j++) {
      const ch = clean[j];
      if (inStr) { if (ch === "\\") j++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === "{") depth++; else if (ch === "}" && --depth === 0) { candidates.push(clean.slice(i, j + 1)); break; }
    }
  }
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) { const v = tryParse(c.trim()); if (v && typeof v === "object" && (v.final_build || v.biggest_miss || v.swaps)) return v; }
  return null;
}

// Take a pasted / clipboard reply from claude.ai and show it on the match it belongs to.
function acceptClaudeReply(text, { quiet } = {}) {
  const raw = parseJsonLoose(text);
  const plan = cleanPlan(raw);
  if (!plan) { if (!quiet) $("#coachErr") && ($("#coachErr").textContent = "Couldn't find Claude's coaching in that text. Click the Copy button under Claude's reply, then paste again."); return false; }
  const target = Number(raw.match_id) && state.history.some(m => m.match_id === Number(raw.match_id)) ? Number(raw.match_id) : state.matchId;
  store.set(`dc:plan:${state.account}:${target}`, { plan, source: "plan", at: Date.now() });
  state.claudePending = null;
  if (target === state.matchId) { state.plan = plan; state.planSource = "plan"; state.coachKind = "plan"; state.shopViewPicked = false; state.shopTabPicked = false; renderCoach(); }
  else { const m = state.history.find(x => x.match_id === target); if (m && m.mode !== state.mode) { state.mode = m.mode; renderLedger(); } selectMatch(target); }
  return true;
}

async function checkClipboardForReply() {
  if (!state.claudePending || document.visibilityState !== "visible") return;
  try {
    const text = await navigator.clipboard.readText();
    if (text && text !== state.claudePending.prompt && acceptClaudeReply(text, { quiet: true })) return;
  } catch { /* no clipboard permission: the Ctrl+V hint covers it */ }
}
function savePlan(plan, source) {
  state.plan = plan; state.planSource = source;
  store.set(`dc:plan:${state.account}:${state.matchId}`, { plan, source, at: Date.now() });
}

async function coachWithKey() {
  const key = store.get("dc:key"); if (!key) return;
  const matchId = state.matchId, model = store.get("dc:model") || CLAUDE_MODELS[0][0];
  const ctl = state.ctl = new AbortController();
  renderCoach(true);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctl.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: "user", content: fullPrompt() }] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 401 ? "That API key was rejected. Check it in the Claude (API key) tab." : data?.error?.message || `Claude answered ${res.status}.`);
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    const plan = cleanPlan(parseJsonLoose(text));
    if (!plan) throw new Error("Claude's answer came back malformed. Press Coach me to try again.");
    if (state.matchId !== matchId) return;
    savePlan(plan, "key");
    state.ctl = null; renderCoach();
  } catch (e) {
    state.ctl = null;
    if (state.matchId !== matchId) return;
    renderCoach();
    if (e.name !== "AbortError") $("#coachErr").textContent = e.message || "The request to Claude failed.";
  }
}

// ---------------------------------------------------------------- coach panel
function renderCoach(waiting) {
  const el = $("#coach"); if (!el || !state.game) return;
  const kinds = [["data", "Quick coach", "free"], ["plan", "Claude", "your claude.ai plan"], ["key", "Claude", "your API key"]];
  const key = store.get("dc:key");
  let controls = "";
  if (state.coachKind === "data") {
    controls = `<p class="muted cv-note">Built from the meta win rates for ${esc(state.game.hero)} against this exact enemy lineup and your lobby ranks. Instant and free.</p>`;
  } else if (state.coachKind === "plan") {
    const prompt = claudeAiPrompt();
    const url = "https://claude.ai/new?q=" + encodeURIComponent(prompt);
    const prefilled = url.length <= 14000;
    const waitingForClaude = state.claudePending?.matchId === state.matchId;
    controls = `<div class="askbox">
      <div class="actions"><a class="btn" id="askClaude" href="${prefilled ? esc(url) : "https://claude.ai/new"}" target="_blank" rel="noopener">${waitingForClaude ? "Ask Claude again" : "Coach with Claude"}</a></div>
      <ol class="steps">
        <li>Claude opens in a new tab${prefilled ? " with the request already typed in for you. Just press Enter to send it." : ". The request is on your clipboard: press Ctrl+V in the message box, then Enter."}</li>
        <li>When Claude finishes, click the <b>Copy</b> button under its reply.</li>
        <li>Come back to this tab. DeadCoach picks the reply up automatically${waitingForClaude ? "" : ""}. If your browser asks to see the clipboard, allow it, or press <b>Ctrl+V</b> anywhere on this page.</li>
      </ol>
      ${waitingForClaude ? `<div class="cv-wait"><span class="spin"></span><span>Waiting for Claude's reply…</span></div>` : ""}
      <details class="manual"><summary>Paste the reply by hand instead</summary>
        <textarea id="replyText" class="ta" placeholder="Paste Claude's reply here…" aria-label="Claude's reply"></textarea>
        <div class="actions"><button class="btn ghost" type="button" id="usePaste">Show it</button><button class="btn ghost" type="button" id="copyPrompt">Copy the request again</button></div>
        <textarea id="promptText" class="ta" readonly hidden></textarea>
      </details></div>`;
  } else {
    controls = key
      ? `<div class="keyrow"><label for="modelSel" class="muted">Model</label><select id="modelSel">${CLAUDE_MODELS.map(([v, l]) => `<option value="${v}" ${v === (store.get("dc:model") || CLAUDE_MODELS[0][0]) ? "selected" : ""}>${l}</option>`).join("")}</select>
          ${waiting ? `<button class="btn ghost" type="button" id="stopBtn">Stop</button>` : `<button class="btn" type="button" id="keyCoach">${state.planSource === "key" ? "Re-coach" : "Coach me"}</button>`}
          <button class="btn ghost" type="button" id="forgetKey">Forget key</button></div>
         <p class="muted cv-note">Billed to your Anthropic account, usually a few cents per note. Your key stays in this browser and is only sent to api.anthropic.com.</p>`
      : `<form class="keyrow" id="keyForm"><input id="keyInput" type="password" autocomplete="off" placeholder="sk-ant-…" aria-label="Anthropic API key"><button class="btn" type="submit">Save key</button></form>
         <p class="muted cv-note">Get a key at console.anthropic.com. It's saved only in this browser and sent only to api.anthropic.com.</p>`;
  }
  const sourceNote = { data: "Quick coach", plan: "Claude (claude.ai)", key: "Claude (API)" }[state.planSource];
  el.innerHTML = `
    <div class="coach-head"><h3>Coach's note</h3>
      <div class="coachtabs" role="tablist">${kinds.map(([k, l, sub]) => `<button type="button" role="tab" data-kind="${k}" aria-selected="${k === state.coachKind}">${l}<small>${sub}</small></button>`).join("")}</div></div>
    ${controls}
    <div class="err" id="coachErr"></div>
    ${waiting ? `<div class="cv-wait"><span class="spin"></span><span>Claude is reading your game. This takes 20–60 seconds…</span></div>` : state.plan ? renderPlan(state.plan) : ""}
    ${state.plan && !waiting ? `<div class="meta-line">Showing: ${sourceNote}</div>` : ""}`;
  el.querySelectorAll(".coachtabs button").forEach(b => b.onclick = () => {
    state.coachKind = b.dataset.kind;
    if (b.dataset.kind === "data") { state.plan = dataCoach(state.game, state.meta); state.planSource = "data"; store.del(`dc:plan:${state.account}:${state.matchId}`); }
    renderCoach();
  });
  $("#askClaude")?.addEventListener("click", () => {
    const prompt = claudeAiPrompt();
    navigator.clipboard?.writeText(prompt).catch(() => {});   // also on the clipboard, in case the link can't pre-fill it
    state.claudePending = { matchId: state.matchId, prompt, at: Date.now() };
    setTimeout(() => renderCoach(), 300);
  });
  $("#copyPrompt")?.addEventListener("click", async () => {
    const text = claudeAiPrompt();
    try { await navigator.clipboard.writeText(text); $("#copyPrompt").textContent = "Copied. Now paste it into Claude"; }
    catch { const t = $("#promptText"); t.hidden = false; t.value = text; t.select(); $("#copyPrompt").textContent = "Copy the selected text"; }
  });
  $("#usePaste")?.addEventListener("click", () => acceptClaudeReply($("#replyText").value || ""));
  $("#keyForm")?.addEventListener("submit", e => { e.preventDefault(); const v = $("#keyInput").value.trim(); if (v) { store.set("dc:key", v); renderCoach(); } });
  $("#forgetKey")?.addEventListener("click", () => { store.del("dc:key"); renderCoach(); });
  $("#modelSel")?.addEventListener("change", e => store.set("dc:model", e.target.value));
  $("#keyCoach")?.addEventListener("click", coachWithKey);
  $("#stopBtn")?.addEventListener("click", () => state.ctl?.abort());
  renderShop();
}

function card(kind, kicker, c) {
  if (!c) return "";
  const items = (c.items || []).filter(findItem);
  return `<div class="cv-card ${kind}"><span class="kicker">${kicker}</span><h5>${inl(c.title || "")}</h5><p>${inl(c.detail || "")}</p>
    ${items.length ? `<div>${items.map(chip).join("")}</div>` : ""}</div>`;
}

function renderPlan(plan) {
  const m = state.game, mine = m.build.filter(b => b.sold_min == null).map(b => b.item.toLowerCase());
  const inFinal = n => plan.final_build.some(f => f.item.toLowerCase() === n.toLowerCase());
  return `<div class="cv">
    ${plan.headline ? `<p class="cv-head">${inl(plan.headline)}</p>` : ""}
    <div class="cv-cards">
      ${(plan.did_well || []).map(c => card("good", "What worked", c)).join("")}
      ${card("miss", "Biggest miss", plan.biggest_miss)}
      ${(plan.do_instead || []).map(c => card("fix", "Do this instead", c)).join("")}
      ${plan.macro ? card("macro", "Macro", plan.macro) : ""}
    </div>
    ${plan.swaps?.length ? `<h4 class="cv-sub">Swaps</h4><div class="swaps">${plan.swaps.map(sw => `<div class="swap">
        ${sw.out && findItem(sw.out) ? tile(sw.out, { size: "sm", state: "mine" }) : `<span class="none">empty<br>slot</span>`}
        <span class="arrow">→</span>${tile(sw.in, { size: "sm", state: "pick" })}
        <span class="why">${sw.by_min != null ? `<span class="when">by ${Number(sw.by_min).toFixed(0)}m</span>` : ""}${inl(sw.why || "")}</span></div>`).join("")}</div>` : ""}
    ${plan.final_build?.length ? `<h4 class="cv-sub">Build path</h4>
      <div class="path">
        <span class="who">You</span><div class="strip">${m.build.map(b => `<div class="slotc ${b.sold_min != null ? "sold" : ""}"><span class="m">${b.bought_min.toFixed(0)}m</span>${tile(b.item, { size: "sm", state: inFinal(b.item) ? "pick" : "" })}</div>`).join("")}</div>
        <span class="who coachw">Coach</span><div class="strip">${plan.final_build.map((f, i) => `<div class="slotc" title="${esc(f.why || "")}"><span class="m">${f.by_min != null ? Number(f.by_min).toFixed(0) + "m" : ""}</span>${tile(f.item, { size: "sm", order: i + 1, state: mine.includes(f.item.toLowerCase()) ? "mine" : "" })}</div>`).join("")}</div>
      </div>` : ""}
  </div>`;
}

// ---------------------------------------------------------------- item browser
function renderShop() {
  const el = $("#shop"); if (!el || !state.game) return;
  if (!state.items.size) { el.hidden = true; return; }
  const plan = state.plan;
  const coachList = (plan?.final_build || []).map(f => f.item.toLowerCase());
  const mineSet = new Set(state.game.build.filter(b => b.sold_min == null).map(b => b.item.toLowerCase()));
  const views = plan ? [["both", "Both"], ["coach", "Coach's build"], ["mine", "Your build"]] : [["mine", "Your build"]];
  if (!state.shopViewPicked || !views.some(([k]) => k === state.shopView)) state.shopView = views[0][0];
  const lit = name => {
    const k = name.toLowerCase(), c = coachList.includes(k), o = mineSet.has(k);
    if (state.shopView === "coach") return c ? "pick" : (o ? "dim mine" : "dim");
    if (state.shopView === "mine") return o ? "mine" : "dim";
    return c ? "pick" : o ? "mine" : "dim";
  };
  const items = [...state.items.values()];
  const count = slot => items.filter(i => i.slot === slot && !lit(i.name).startsWith("dim")).length;
  if (!state.shopTabPicked) state.shopTab = SLOT_ORDER.slice().sort((a, b) => count(b) - count(a))[0];
  const tiers = [...new Set(items.filter(i => i.slot === state.shopTab).map(i => i.tier))].sort();
  el.innerHTML = `
    <div class="shop-top"><h3>Item browser</h3>
      <div class="shop-view" role="group" aria-label="Highlight">${views.map(([k, l]) => `<button type="button" data-view="${k}" aria-pressed="${k === state.shopView}">${l}</button>`).join("")}</div></div>
    <div class="shop-tabs" role="tablist">${SLOT_ORDER.map(sl => `<button type="button" role="tab" class="shop-tab ${sl}" data-tab="${sl}" aria-selected="${sl === state.shopTab}">${sl}<small>${count(sl)}</small></button>`).join("")}</div>
    <div class="shop-body ${state.shopTab}">
      ${tiers.map(t => `<div class="tier-row"><div class="th">Tier ${t}<b><i></i>${(TIER_COST[t] || "").toLocaleString()}</b></div>
        <div class="tiles">${items.filter(i => i.slot === state.shopTab && i.tier === t).map(i => {
          const ord = coachList.indexOf(i.name.toLowerCase());
          return tile(i.name, { state: lit(i.name), order: ord >= 0 && state.shopView !== "mine" ? ord + 1 : 0, owned: mineSet.has(i.name.toLowerCase()) && state.shopView !== "mine" });
        }).join("")}</div></div>`).join("")}
    </div>
    <div class="shop-detail" id="shopDetail">Hover or tap an item for details.</div>
    <div class="shop-legend">
      ${plan ? `<span><span class="k" style="box-shadow:0 0 0 2px var(--accent)"></span>coach's build (numbers = buy order)</span>` : ""}
      <span><span class="k" style="box-shadow:0 0 0 2px #f4efe4"></span>your final items</span>
    </div>`;
  el.querySelectorAll(".shop-tab").forEach(b => b.onclick = () => { state.shopTab = b.dataset.tab; state.shopTabPicked = true; renderShop(); });
  el.querySelectorAll(".shop-view button").forEach(b => b.onclick = () => { state.shopView = b.dataset.view; state.shopViewPicked = true; state.shopTabPicked = false; renderShop(); });
  const showDetail = e => {
    const t = e.target.closest(".it[data-item]"); if (!t) return;
    const it = findItem(t.dataset.item); if (!it) return;
    const f = plan?.final_build?.find(x => x.item.toLowerCase() === it.name.toLowerCase());
    const r = state.meta?.find(x => x.item === it.name);
    $("#shopDetail").innerHTML = `<b>${esc(it.name)}</b> · ${it.cost.toLocaleString()} souls${it.active ? " · active" : ""}${it.desc ? ` — ${esc(it.desc)}` : ""}${r ? `<br><b>vs this lineup:</b> ${r.win_rate}% win rate, bought around ${Math.round(r.avg_buy_min)}m` : ""}${f?.why ? `<br><b>Coach:</b> ${esc(f.why)}${f.by_min != null ? ` (by ${Number(f.by_min).toFixed(0)}m)` : ""}` : ""}`;
  };
  el.querySelector(".shop-body").addEventListener("mouseover", showDetail);
  el.querySelector(".shop-body").addEventListener("click", showDetail);
}

// ---------------------------------------------------------------- boot
$("#searchForm").addEventListener("submit", e => { e.preventDefault(); findAndLoad($("#acctInput").value); });
window.addEventListener("focus", checkClipboardForReply);
document.addEventListener("visibilitychange", checkClipboardForReply);
document.addEventListener("paste", e => {
  const t = e.target;
  if (t && (t.id === "acctInput" || t.id === "keyInput")) return;
  const text = e.clipboardData?.getData("text") || "";
  if (text.includes("final_build") || text.includes("biggest_miss")) { e.preventDefault(); acceptClaudeReply(text); }
});

(async () => {
  try { await loadStatic(); } catch { $("#ledger").innerHTML = `<div class="notice">Couldn't load the item list. Reload the page.</div>`; return; }
  const fromUrl = new URLSearchParams(location.search).get("id");
  const parsed = fromUrl && parseInput(fromUrl);
  if (parsed && parsed.kind !== "id") return findAndLoad(fromUrl);
  const id = parsed?.id || store.get("dc:account");
  if (id) loadAccount(id);
  else $("#ledger").innerHTML = `<div class="notice">Paste a Steam profile link, a SteamID in any format, an account ID, or a Steam name above to load matches. Share the page link afterwards and it opens straight to your games.</div>`;
})();
