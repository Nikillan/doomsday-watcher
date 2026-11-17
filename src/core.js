// Shared logic: reads District's public movie page, finds English Doomsday
// shows on release day within the radius (or at preferred theatres).
// Runs in Node 20+ (GitHub Actions).

export const CONFIG = {
  movieSlug: 'avengers-doomsday-movie-tickets-in-chennai-MV176735',
  movieName: 'Avengers: Doomsday',
  releaseDateIST: '2026-12-17',            // only shows on this IST date count
  home: { lat: 12.9566, lon: 80.2443, label: 'Kandanchavadi' },
  radiusKm: 10,
  preferred: ['phoenix', 'grand mall', 'bsr'], // case-insensitive substrings of cinema name
  languageMatch: /english/i,
};

const BASE = 'https://www.district.in/movies/';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-IN,en;q=0.9',
};

export function pageUrl(frmtid) {
  return BASE + CONFIG.movieSlug + (frmtid ? `?frmtid=${frmtid}` : '');
}

// ---- Live data: District's own sessions API, called like an anonymous visitor's browser would.
// The HTML snapshot (fetchNextData) can be hours stale on seat counts, so prefer this.
const API = 'https://www.district.in/gw/consumer/movies/v1/movie/sessions';
let cookieJar = '';

function absorbCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!list.length) return;
  const jar = new Map(cookieJar ? cookieJar.split('; ').map((c) => [c.split('=')[0], c]) : []);
  for (const sc of list) { const kv = sc.split(';')[0]; jar.set(kv.split('=')[0], kv); }
  cookieJar = [...jar.values()].join('; ');
}

async function warmSession() {
  cookieJar = '';
  const res = await fetch(pageUrl(), { headers: HEADERS, redirect: 'follow' });
  absorbCookies(res);
  await res.text();
}

export const debug = { lastLive: null };

async function fetchLive(frmtid) {
  const q = new URLSearchParams({
    version: '3', site_id: '1', channel: 'mweb', child_site_id: '1', platform: 'district',
    movieCode: frmtid, city_key: 'chennai', content_id: CONFIG.movieSlug.split('-MV')[1],
    latitude: String(CONFIG.home.lat), longitude: String(CONFIG.home.lon), cinemaOrderLogic: '3',
  });
  const call = () => fetch(`${API}?${q}`, {
    headers: { ...HEADERS, Accept: 'application/json', Referer: pageUrl(frmtid), Cookie: cookieJar },
  });
  if (!cookieJar) await warmSession();
  let res = await call();
  if (res.status === 401) { await warmSession(); res = await call(); }
  debug.lastLive = { status: res.status, cookieNames: cookieJar.split('; ').map((c) => c.split('=')[0]).filter(Boolean) };
  if (!res.ok) throw new Error(`live API ${res.status}`);
  absorbCookies(res);
  return res.json(); // { meta: { filterBuckets }, pageData: { nearbyCinemas, farCinemas } }
}

async function fetchNextData(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`No __NEXT_DATA__ in ${url} (blocked or layout changed?)`);
  return JSON.parse(m[1]);
}

function sessionsBlock(nextData) {
  const ms = nextData?.props?.pageProps?.initialState?.movies?.movieSessions || {};
  const key = Object.keys(ms)[0];
  return key ? { key, block: ms[key] } : null;
}

function languageBuckets(block) {
  const fb = block?.meta?.filterBuckets || [];
  const lang = fb.find((b) => b.bucketKey === 'language');
  return (lang?.buckets || []).map((b) => ({ title: b.title, key: b.key }));
}

function haversineKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// District's showTime is UTC without a zone, e.g. "2026-12-17T08:00" = 1:30 PM IST.
function toIST(showTime) {
  const d = new Date(showTime + 'Z');
  const ist = new Date(d.getTime() + 330 * 60000);
  const iso = ist.toISOString();
  const h = ist.getUTCHours(), mi = ist.getUTCMinutes();
  const label = `${((h + 11) % 12) + 1}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  return { date: iso.slice(0, 10), label, sortKey: iso };
}

export function nowIST() {
  const ist = new Date(Date.now() + 330 * 60000);
  return { date: ist.toISOString().slice(0, 10), hour: ist.getUTCHours() };
}

// Returns { shows: [...], languages: [...] }
export async function scan() {
  const base = await fetchNextData(pageUrl());
  const first = sessionsBlock(base);
  const langs = first ? languageBuckets(first.block) : [];
  const english = langs.filter((l) => CONFIG.languageMatch.test(l.title));

  const shows = [];
  let source = 'live';
  for (const lang of english) {
    let pd;
    try {
      pd = (await fetchLive(lang.key)).pageData || {};
    } catch (e) {
      source = `snapshot (live failed: ${e.message})`;
      const sb = sessionsBlock(await fetchNextData(pageUrl(lang.key)));
      if (!sb) continue;
      pd = sb.block.pageData || {};
    }
    const cinemas = [...(pd.nearbyCinemas || []), ...(pd.farCinemas || [])];
    for (const c of cinemas) {
      const info = c.cinemaInfo || {};
      const name = info.name || `Cinema ${c.id}`;
      const dist = haversineKm(CONFIG.home, { lat: info.latitude, lon: info.longitude });
      const preferred = CONFIG.preferred.some((p) => name.toLowerCase().includes(p));
      if (dist > CONFIG.radiusKm && !preferred) continue;
      for (const s of [...(c.sessions || []), ...(c.extraSessions || [])]) {
        const t = toIST(s.showTime);
        if (t.date !== CONFIG.releaseDateIST) continue;
        const prices = (s.areas || []).filter((a) => a.sAvail > 0).map((a) => a.price);
        shows.push({
          id: s.encSessionId || `${c.id}-${s.sid}`,
          cinema: name,
          distKm: Math.round(dist * 10) / 10,
          preferred,
          time: t.label,
          sortKey: t.sortKey,
          format: s.scrnFmt || '',
          language: lang.title,
          seatsLeft: s.avail ?? null,
          totalSeats: s.total ?? null,
          minPrice: prices.length ? Math.min(...prices) : null,
          link: pageUrl(lang.key),
        });
      }
    }
  }
  shows.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return { shows, languages: langs, source };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatShows(shows) {
  return shows
    .map((s) => {
      const star = s.preferred ? '⭐ ' : '';
      const seats = s.seatsLeft != null ? `${s.seatsLeft} seats left` : '';
      const price = s.minPrice != null ? ` · from ₹${Math.round(s.minPrice)}` : '';
      return `${star}<b>${esc(s.time)}</b> · ${esc(s.cinema)} (${s.distKm} km)\n   ${esc(s.format)} · ${esc(s.language)} · ${seats}${price}`;
    })
    .join('\n');
}

export function alertMessage(newShows) {
  const links = [...new Set(newShows.map((s) => s.link))];
  return (
    `🚨 <b>${esc(CONFIG.movieName)} — SEATS AVAILABLE (Dec 17)</b>\n\n` +
    formatShows(newShows) +
    `\n\n👉 Book now: ${links.map(esc).join('\n')}`
  );
}

export async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

// One full tick. `state` = { seen: string[], lastHeartbeat?: string, lastErrorAlert?: number }
// Returns { state, changed, result } — caller persists state only when changed.
export async function tick(state, notify) {
  const today = nowIST();
  if (today.date > CONFIG.releaseDateIST) return { state, changed: false, result: 'release day passed; idle' };

  let result, lastErr;
  for (let i = 0; i < 3; i++) {
    try { result = await scan(); break; } catch (e) { lastErr = e; }
  }

  if (!result) {
    const now = Date.now();
    if (!state.lastErrorAlert || now - state.lastErrorAlert > 3 * 3600 * 1000) {
      await notify(`⚠️ Doomsday watcher can't read District: ${esc(lastErr?.message || lastErr)}\n(Will retry every minute; next warning in 3h if it keeps failing.)`);
      return { state: { ...state, lastErrorAlert: now }, changed: true, result: 'error' };
    }
    return { state, changed: false, result: 'error (suppressed)' };
  }

  // avail map: session id -> true (bookable seats) / false (sold out). Alert on new-or-reopened bookable shows.
  const prev = state.avail || {};
  const firstRun = !state.avail;
  const live = result.source === 'live';
  // Snapshot seat counts can be stale: in that mode only brand-new shows count, known ones keep their last live status.
  const nowMap = Object.fromEntries(result.shows.map((s) => [s.id, !live && s.id in prev ? prev[s.id] : (s.seatsLeft ?? 1) > 0]));
  const bookable = result.shows.filter((s) => nowMap[s.id]);
  const alerted = state.alerted || {};
  const fresh = bookable.filter((s) => prev[s.id] !== true && Date.now() - (alerted[s.id] || 0) > 10 * 60000);
  let changed = false;
  const next = { ...state };
  delete next.seen;

  if (firstRun) {
    const soldOut = result.shows.filter((s) => !nowMap[s.id]);
    await notify(
      `✅ <b>Doomsday watcher is live</b> (${esc(result.source)}) — checking every minute for English shows on Dec 17 within ${CONFIG.radiusKm} km of ${CONFIG.home.label} (⭐ = Phoenix / Grand Mall / BSR). You'll be pinged when a new show opens or seats free up in a sold-out one.\n\n` +
        (bookable.length ? `Bookable now:\n${formatShows(bookable)}\n\n` : 'Nothing bookable right now.\n') +
        (soldOut.length ? `Sold out: ${soldOut.map((s) => `${esc(s.time)} ${esc(s.cinema.split(',')[0])}`).join('; ')}` : '')
    );
    changed = true;
  } else if (fresh.length) {
    await notify(alertMessage(fresh));
    next.alerted = { ...alerted, ...Object.fromEntries(fresh.map((s) => [s.id, Date.now()])) };
    await notify('⏰ Reminder: Doomsday seats available right now — book fast!');
    changed = true;
  }

  if (changed || JSON.stringify(prev) !== JSON.stringify({ ...prev, ...nowMap })) {
    next.avail = { ...prev, ...nowMap };
    changed = true;
  }

  // Daily "still alive" ping after 9 AM IST.
  if (!firstRun && today.hour >= 9 && state.lastHeartbeat !== today.date) {
    await notify(`💓 Watcher alive (${esc(result.source)}). ${result.shows.filter((s) => (s.seatsLeft ?? 1) > 0).length}/${result.shows.length} English Dec-17 show(s) in range bookable; English versions listed: ${result.languages.filter((l) => CONFIG.languageMatch.test(l.title)).length}.`);
    next.lastHeartbeat = today.date;
    changed = true;
  }
  if (firstRun) next.lastHeartbeat = today.date;

  return { state: next, changed, result };
}
