#!/usr/bin/env node
// Keeps data/pvp.json up to date for the "Battle League: what's on now" section.
//
// What it does:
//   1. Reads which GO Battle League leagues and cups are on, and when, from LeekDuck's
//      event calendar (via ScrapedDuck: https://github.com/bigfoott/ScrapedDuck).
//   2. Matches each league or cup to PvPoke's rankings (https://github.com/pvpoke/pvpoke, MIT licence)
//      and saves the ranked Pokédex numbers.
//   3. Merges with the last saved file, so a week that has already started is never lost
//      (ScrapedDuck sometimes drops the current week once it has begun).
//
// If a source is down or returns something odd, the last good data is kept and the problem is
// reported (the GitHub workflow then fails, which sends an email). The site keeps working.
//
// Runs every few hours from .github/workflows/pvp-data.yml. To run it yourself: node scripts/update-pvp-data.mjs
//
// Rarely needed: if a week that has already started is missing, add it by hand (times in UTC):
//   node scripts/update-pvp-data.mjs --add-week 2026-11-24T21:00:00Z 2026-12-01T21:00:00Z "Master League and Mega Catch Cup: Great League Edition"
//
// For testing, these settings can be changed: PVP_EVENTS_URL, PVP_PVPOKE_URL, PVP_NOW (pretend it is this date/time).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const OUT = new URL("../data/pvp.json", import.meta.url);
const EVENTS_URL = process.env.PVP_EVENTS_URL || "https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data/events.json";
const PVPOKE = (process.env.PVP_PVPOKE_URL || "https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data").replace(/\/$/, "");
const NOW = process.env.PVP_NOW ? Date.parse(process.env.PVP_NOW) : Date.now();
const DAY = 864e5;
const KEEP_PAST_DAYS = 14;   // drop weeks that ended longer ago than this
const RANK_AHEAD_DAYS = 14;  // fetch rankings for leagues starting within this many days
const errors = [];

if (!Number.isFinite(NOW)) throw new Error("PVP_NOW is not a valid date");

// ---------- fetching ----------
class HttpError extends Error { constructor(status, url) { super(`HTTP ${status} for ${url}`); this.status = status; } }

async function getJSON(url, tries = 3) {
  if (url.startsWith("file:")) return JSON.parse(await readFile(new URL(url), "utf8"));
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { "User-Agent": "pokemon-go-search data job" } });
      if (res.status === 404) throw new HttpError(404, url); // missing file: no point retrying
      if (!res.ok) throw new HttpError(res.status, url);
      return await res.json();
    } catch (e) {
      last = e;
      if (e instanceof HttpError && e.status === 404) throw e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

// ---------- reading league and cup names ----------
// "Great League: Mega Edition, Ultra League: Mega Edition, and Master League | Daydream Destinations"
//   -> ["Great League: Mega Edition", "Ultra League: Mega Edition", "Master League"]
export function splitLeagues(title) {
  const base = String(title).split(" | ")[0];
  return base.split(/,\s*(?:and\s+)?|\s+and\s+/).map(s => s.trim()).filter(Boolean);
}

function capOf(name) {
  const n = name.toLowerCase();
  if (/\blittle\b/.test(n)) return 500;
  if (/\bmaster league\b/.test(n)) return 10000;
  if (/\bultra league\b/.test(n)) return 2500;
  if (/\bgreat league\b/.test(n)) return 1500;
  return null;
}

const normTitle = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

// Exact name match only (never a "close enough" match, which could pick a cup with different rules).
// If PvPoke has a separate GO Battle League version of the cup, e.g. "Some Cup (GBL)", prefer it.
function matchCup(name, cups) {
  const want = normTitle(name);
  if (!want) return null;
  return cups.find(c => normTitle(c.title) === want + " gbl") || cups.find(c => normTitle(c.title) === want) || null;
}

// Works out the CP limit, whether Megas are allowed and which PvPoke ranking list to use.
export function describeLeague(name, cups) {
  const i = name.indexOf(":");
  const head = (i < 0 ? name : name.slice(0, i)).trim();
  const tail = (i < 0 ? "" : name.slice(i + 1)).trim();
  const cap = capOf(name);
  const lg = { name, cp: cap || 1500, megas: /\bmega\b/i.test(name), kind: "cup", cup: null };
  if (!cap) lg.cpGuess = true;
  if (/^(great|ultra|master) league$/i.test(head)) {
    lg.kind = "league";
    if (!tail) lg.cup = "all";
    else if (/^mega edition$/i.test(tail)) lg.cup = "mega";
    else { const c = matchCup(tail.replace(/\bedition$/i, "Cup"), cups); lg.cup = c ? c.name : null; }
  } else if (/\bcatch cup\b/i.test(head)) {
    // Catch cups are about when you caught the Pokémon, which the site handles with an age filter.
    // Rank them with the normal league list (Mega version if Megas are allowed).
    lg.kind = "catch";
    lg.cup = lg.megas ? "mega" : "all";
  } else {
    const c = matchCup(head, cups);
    lg.cup = c ? c.name : null;
  }
  return lg;
}

// ---------- rankings -> Pokédex numbers ----------
function toDex(list, bySpecies, label) {
  if (!Array.isArray(list) || list.length < 20) throw new Error(`${label}: ranking list is missing or too short`);
  const dex = [], seen = new Set(), top = [];
  let unknown = 0;
  for (const e of list) {
    const p = e && bySpecies.get(e.speciesId);
    if (!p) { unknown++; continue; }
    const n = p.dex;
    if (!Number.isInteger(n) || n < 1 || n > 2000) { unknown++; continue; }
    if (seen.has(n)) continue;
    seen.add(n); dex.push(n);
    if (top.length < 3) top.push(p.speciesName);
  }
  if (unknown > list.length * 0.1) throw new Error(`${label}: too many unrecognised Pokémon (${unknown} of ${list.length})`);
  if (dex.length < 20) throw new Error(`${label}: too few Pokémon after checking (${dex.length})`);
  return { dex, top };
}

// ---------- main ----------
function iso(ms) { return new Date(ms).toISOString(); }

function parseArgs(argv) {
  const add = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--add-week") {
      const [start, end, title] = argv.slice(i + 1, i + 4);
      const s = Date.parse(start), e = Date.parse(end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || !title) throw new Error('Use: --add-week START END "League A and League B" (times in UTC, e.g. 2026-11-24T21:00:00Z)');
      add.push({ key: `${iso(s)}|${iso(e)}`, title, start: iso(s), end: iso(e), link: "", manual: true });
      i += 3;
    }
  }
  return { add };
}

async function main() {
  const { add } = parseArgs(process.argv.slice(2));

  let prev = {};
  try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch { /* first run */ }
  const prevChecked = prev.checked || {};

  // 1. League weeks and seasons from LeekDuck (via ScrapedDuck)
  let freshWeeks = null, freshSeasons = null;
  try {
    const events = await getJSON(EVENTS_URL);
    if (!Array.isArray(events) || events.length < 5) throw new Error("event list is empty or not a list");
    freshWeeks = []; freshSeasons = [];
    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      if (ev.eventType === "go-battle-league") {
        const s = Date.parse(ev.start), e = Date.parse(ev.end);
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || e - s > 31 * DAY || !ev.name) {
          errors.push(`Skipped an odd Battle League entry: ${JSON.stringify(ev).slice(0, 160)}`);
          continue;
        }
        freshWeeks.push({ key: `${iso(s)}|${iso(e)}`, title: String(ev.name), start: iso(s), end: iso(e), link: String(ev.link || "") });
      } else if (ev.eventType === "season" && ev.name && ev.start && ev.end) {
        freshSeasons.push({ name: String(ev.name), start: String(ev.start), end: String(ev.end) });
      }
    }
  } catch (e) {
    errors.push(`League calendar (ScrapedDuck): ${e.message}`);
  }

  // Merge weeks. The calendar is trusted for weeks that haven't started; a week that has
  // started is kept even if the calendar has dropped it.
  let weeks = (prev.weeks || []).map(w => ({ key: w.key, title: w.title, start: w.start, end: w.end, link: w.link || "", ...(w.manual ? { manual: true } : {}) }));
  if (freshWeeks && freshWeeks.length) {
    const keys = new Set(freshWeeks.map(w => w.key));
    weeks = weeks.filter(w => !keys.has(w.key) && (Date.parse(w.start) <= NOW || w.manual)).concat(freshWeeks);
  }
  for (const w of add) { weeks = weeks.filter(x => x.key !== w.key); weeks.push(w); }
  weeks = weeks.filter(w => Date.parse(w.end) > NOW - KEEP_PAST_DAYS * DAY).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  let seasons = prev.seasons || [];
  if (freshSeasons && freshSeasons.length) {
    const names = new Set(freshSeasons.map(s => s.name));
    seasons = seasons.filter(s => !names.has(s.name)).concat(freshSeasons);
  }
  seasons = seasons.filter(s => Date.parse(s.end) > NOW - 120 * DAY).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  // 2. PvPoke's cup list and Pokémon list
  let cups = prev.cups || [], bySpecies = null;
  try {
    const gm = await getJSON(`${PVPOKE}/gamemaster.json`);
    if (!gm || !Array.isArray(gm.pokemon) || gm.pokemon.length < 500 || !Array.isArray(gm.cups) || gm.cups.length < 5) throw new Error("game data is missing parts");
    bySpecies = new Map(gm.pokemon.map(p => [p.speciesId, p]));
    cups = gm.cups.filter(c => c && c.name && c.title).map(c => ({ name: String(c.name), title: String(c.title) }));
  } catch (e) {
    errors.push(`PvPoke game data: ${e.message}`);
  }

  // 3. Work out each league, then fetch the rankings needed for leagues on now or soon
  for (const w of weeks) {
    // Which season a catch cup belongs to (allow a day either side for time zones)
    const ws = Date.parse(w.start);
    const season = seasons.find(s => ws >= Date.parse(s.start) - DAY && ws < Date.parse(s.end) - DAY);
    w.leagues = splitLeagues(w.title).map(name => {
      const lg = describeLeague(name, cups);
      if (lg.kind === "catch") { if (season) lg.catchFrom = season.start; }
      lg.rank = lg.cup ? `${lg.cup}-${lg.cp}` : null;
      delete lg.cup;
      return lg;
    });
  }

  const wanted = new Set();
  for (const w of weeks) {
    if (Date.parse(w.end) <= NOW || Date.parse(w.start) > NOW + RANK_AHEAD_DAYS * DAY) continue;
    for (const lg of w.leagues) if (lg.rank) wanted.add(lg.rank);
  }

  const prevRankings = prev.rankings || {};
  const rankings = {};
  const missing = new Set();
  let rankingProblems = 0;
  for (const key of [...wanted].sort()) {
    const cut = key.lastIndexOf("-"), cup = key.slice(0, cut), cp = key.slice(cut + 1);
    if (!bySpecies) { if (prevRankings[key]) rankings[key] = prevRankings[key]; else missing.add(key); continue; }
    try {
      const list = await getJSON(`${PVPOKE}/rankings/${cup}/overall/rankings-${cp}.json`);
      rankings[key] = toDex(list, bySpecies, key);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) { missing.add(key); continue; } // PvPoke has no list for this one (yet)
      rankingProblems++;
      errors.push(`PvPoke rankings ${key}: ${e.message}`);
      if (prevRankings[key]) rankings[key] = prevRankings[key]; else missing.add(key);
    }
  }
  // No list for a league: the site shows its CP limit only
  for (const w of weeks) for (const lg of w.leagues) if (lg.rank && missing.has(lg.rank) && !rankings[lg.rank]) lg.rank = null;

  // 4. Save
  const leaguesOk = !!(freshWeeks && freshSeasons);
  const rankingsOk = !!bySpecies && rankingProblems === 0;
  const data = {
    version: 1,
    about: "Made by scripts/update-pvp-data.mjs. League calendar: LeekDuck via ScrapedDuck. Rankings: PvPoke (MIT licence).",
    checked: {
      leagues: leaguesOk ? iso(NOW) : (prevChecked.leagues || null),
      rankings: rankingsOk ? iso(NOW) : (prevChecked.rankings || null)
    },
    errors,
    seasons,
    cups,
    weeks,
    rankings
  };

  const meaningful = d => JSON.stringify({ seasons: d.seasons, cups: d.cups, weeks: d.weeks, rankings: d.rankings });
  const changed = meaningful(prev) !== meaningful(data);

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  // Readable layout, but keep long number lists on one line
  const text = JSON.stringify(data, null, 1).replace(/\[\s*(\d+(?:,\s*\d+)*)\s*\]/g, (m, inner) => "[" + inner.replace(/\s+/g, "") + "]");
  await writeFile(OUT, text + "\n");

  // Summary for the log and for the GitHub workflow
  const live = weeks.filter(w => Date.parse(w.start) <= NOW && Date.parse(w.end) > NOW);
  console.log(`Weeks saved: ${weeks.length} (live now: ${live.map(w => w.title).join(" / ") || "none"})`);
  console.log(`Ranking lists saved: ${Object.keys(rankings).map(k => `${k} (${rankings[k].dex.length})`).join(", ") || "none"}`);
  if (missing.size) console.log(`No PvPoke list (CP limit only): ${[...missing].join(", ")}`);
  console.log(changed ? "Data changed." : "No change in data.");
  if (errors.length) console.log("Problems:\n- " + errors.join("\n- "));
  if (process.env.GITHUB_OUTPUT) {
    const summary = errors.join(" / ").replace(/[\r\n]+/g, " ").slice(0, 900);
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nerrors=${errors.length}\nsummary=${summary}\n`);
  }
}

// Only run when called directly (so the tests can import the helpers above)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(e);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=false\nerrors=1\nsummary=${String(e.message).replace(/[\r\n]+/g, " ").slice(0, 900)}\n`);
    process.exit(1);
  });
}
