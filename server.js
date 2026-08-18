// Kitchen Dashboard — B + E
// Node 22 (node:sqlite) + Express 4. Same stack pattern as WeekendPlanning.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const exifr = require('exifr');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const BRENDAN_PIN = process.env.BRENDAN_PIN || '1998';
const EMMA_PIN = process.env.EMMA_PIN || '2024';
const SEED_VERSION = 1;

// Upstream services + data sources
const WEEKEND_URL = process.env.WEEKEND_URL || 'https://weekend.finnoperations.com';
const WEEKEND_PIN = process.env.WEEKEND_PIN || BRENDAN_PIN;
const WORKOUT_URL = process.env.WORKOUT_URL || 'https://workoutplanning-production.up.railway.app';
const MBTA_API_KEY = process.env.MBTA_API_KEY || '';
const MBTA_BASE = process.env.MBTA_BASE || 'https://api-v3.mbta.com';
const NWS_BASE = process.env.NWS_BASE || 'https://api.weather.gov';
const LAT = process.env.LAT || '42.3653';   // Central Square, Cambridge
const LON = process.env.LON || '-71.1035';
const NWS_UA = 'KitchenDashboard (personal kiosk, brf1998@gmail.com)';
const GEO_BASE = process.env.GEO_BASE || 'https://nominatim.openstreetmap.org';

// MBTA feeds: label, route badge, query. Stop ids verified against api-v3.mbta.com.
const MBTA_FEEDS = [
  { key: 'red', badge: 'RL', color: '#DA291C', label: 'Red Line → Kendall/MIT', sub: 'from Central',
    params: 'filter[stop]=place-cntsq&filter[route]=Red&filter[direction_id]=0' },
  { key: 'bus1', badge: '1', color: '#FFC72C', label: '1 bus → BMC', sub: 'Mass Ave opp Lee St',
    params: 'filter[stop]=69&filter[route]=1&filter[direction_id]=1' },
  { key: 'bus47', badge: '47', color: '#FFC72C', label: '47 bus → Longwood/BCH', sub: 'Green St @ Magazine',
    params: 'filter[stop]=1123&filter[route]=47&filter[direction_id]=1' },
];

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'photos'), { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'dashboard.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS chores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, area TEXT DEFAULT '',
    cadence TEXT DEFAULT 'weekly',           -- 'daily' | 'weekly'
    day INTEGER DEFAULT -1,                  -- 0=Sun..6=Sat for weekly, -1 for daily
    assignee TEXT DEFAULT 'alt',             -- 'b' | 'e' | 'alt' | 'both'
    pos INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS chore_log (
    chore_id INTEGER, date TEXT, person TEXT, done_at TEXT,
    PRIMARY KEY (chore_id, date)
  );
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person TEXT, text TEXT, status TEXT DEFAULT 'new', created TEXT
  );
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file TEXT, caption TEXT DEFAULT '', added_by TEXT, created TEXT
  );
  CREATE TABLE IF NOT EXISTS geo_cache (key TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE IF NOT EXISTS chore_marks (
    chore_id INTEGER, date TEXT, person TEXT, done_at TEXT,
    PRIMARY KEY (chore_id, date, person)
  );
`);
// migrations for databases created before v3
try { db.exec("ALTER TABLE photos ADD COLUMN taken TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE photos ADD COLUMN place TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE chores ADD COLUMN due TEXT DEFAULT ''"); } catch (e) {}
db.exec('CREATE TABLE IF NOT EXISTS pins (weekend_id TEXT PRIMARY KEY, created TEXT)');
try {
  db.exec(`INSERT OR IGNORE INTO chore_marks (chore_id, date, person, done_at)
    SELECT chore_id, date, person, done_at FROM chore_log`);
  db.exec('DROP TABLE chore_log');
} catch (e) {}
db.exec(`
  SELECT 1;
`);

function seed() {
  const cur = db.prepare("SELECT value FROM settings WHERE key='seed_version'").get();
  if (cur && Number(cur.value) >= SEED_VERSION) return;
  const CHORES = [
    ['Dishes + counters', 'kitchen', 'daily', -1, 'alt', 1],
    ['Trash + recycling out', 'house', 'weekly', 0, 'alt', 2],
    ['Bathroom clean', 'bath', 'weekly', 6, 'alt', 3],
    ['Vacuum + sweep', 'house', 'weekly', 0, 'alt', 4],
    ['Laundry', 'house', 'weekly', 0, 'both', 5],
    ['Groceries + meal plan', 'kitchen', 'weekly', 0, 'both', 6],
    ['Water plants', 'house', 'weekly', 3, 'alt', 7],
  ];
  const has = db.prepare('SELECT id FROM chores WHERE title = ?');
  const ins = db.prepare('INSERT INTO chores (title, area, cadence, day, assignee, pos) VALUES (?, ?, ?, ?, ?, ?)');
  for (const c of CHORES) if (!has.get(c[0])) ins.run(...c);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('seed_version', String(SEED_VERSION));
}
seed();

// ---------- auth (same scheme as WeekendPlanning) ----------
function sign(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }
function makeCookie(role) {
  const exp = Date.now() + 365 * 24 * 3600 * 1000;
  const payload = `${role}.${exp}`;
  return `${payload}.${sign(payload)}`;
}
function readSession(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('kd_sess='));
  if (!raw) return null;
  const parts = decodeURIComponent(raw.slice('kd_sess='.length)).split('.');
  if (parts.length !== 3) return null;
  const [role, exp, sig] = parts;
  if (sign(`${role}.${exp}`) !== sig || Number(exp) < Date.now()) return null;
  return role === 'b' || role === 'e' ? role : null;
}
function requireAuth(req, res, next) {
  const role = readSession(req);
  if (!role) return req.path.startsWith('/api')
    ? res.status(401).json({ error: 'login required' })
    : res.redirect('/');
  req.role = role;
  next();
}

// ---------- small cache ----------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}
async function getJSON(url, headers = {}, timeoutMs = 8000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ac.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(to); }
}

// ---------- date helpers (America/New_York) ----------
const TZ = 'America/New_York';
function localISO(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function localDow(d = new Date()) {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d));
}
function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
  return 1 + Math.round((d - firstThu) / (7 * 24 * 3600 * 1000));
}

// ---------- weather (National Weather Service) ----------
async function fetchWeather() {
  return cached('weather', 10 * 60 * 1000, async () => {
    let pts = cache.get('nws_points_v');
    if (!pts) {
      const p = await getJSON(`${NWS_BASE}/points/${LAT},${LON}`, { 'User-Agent': NWS_UA });
      pts = { hourly: p.properties.forecastHourly, daily: p.properties.forecast };
      cache.set('nws_points_v', pts);
    }
    const [hr, dy] = await Promise.all([
      getJSON(pts.hourly, { 'User-Agent': NWS_UA }),
      getJSON(pts.daily, { 'User-Agent': NWS_UA }),
    ]);
    const hours = (hr.properties.periods || []).slice(0, 12).map(p => ({
      t: p.startTime, temp: p.temperature, unit: p.temperatureUnit,
      short: p.shortForecast, precip: (p.probabilityOfPrecipitation || {}).value || 0,
      isDay: p.isDaytime,
    }));
    const days = (dy.properties.periods || []).slice(0, 4).map(p => ({
      name: p.name, temp: p.temperature, short: p.shortForecast,
      precip: (p.probabilityOfPrecipitation || {}).value || 0, isDay: p.isDaytime, detail: p.detailedForecast,
    }));
    return { hours, days };
  });
}

// ---------- MBTA ----------
async function fetchMbta() {
  return cached('mbta', 30 * 1000, async () => {
    const headers = MBTA_API_KEY ? { 'x-api-key': MBTA_API_KEY } : {};
    const out = [];
    await Promise.all(MBTA_FEEDS.map(async f => {
      let deps = [], live = true;
      try {
        const j = await getJSON(`${MBTA_BASE}/predictions?${f.params}&sort=departure_time&page[limit]=7`, headers);
        deps = (j.data || [])
          .map(p => p.attributes.departure_time || p.attributes.arrival_time)
          .filter(Boolean);
      } catch (e) { /* fall through to schedules */ }
      if (!deps.length) {
        live = false;
        try {
          const now = new Date();
          const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
          const j = await getJSON(`${MBTA_BASE}/schedules?${f.params}&filter[date]=${localISO(now)}&filter[min_time]=${hm.replace(':', '%3A')}&sort=departure_time&page[limit]=7`, headers);
          deps = (j.data || []).map(s => s.attributes.departure_time).filter(Boolean);
        } catch (e) { /* leave empty */ }
      }
      const upcoming = deps
        .map(t => ({ iso: t, min: Math.round((new Date(t) - Date.now()) / 60000) }))
        .filter(d => d.min > -1 && d.min < 240).slice(0, 6);
      const mins = upcoming.slice(0, 3).map(d => d.min);
      const later = upcoming.slice(3).map(d =>
        new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(d.iso)));
      out.push({ key: f.key, badge: f.badge, color: f.color, label: f.label, sub: f.sub, mins, later, live });
    }));
    // keep feed order stable
    out.sort((a, b) => MBTA_FEEDS.findIndex(f => f.key === a.key) - MBTA_FEEDS.findIndex(f => f.key === b.key));
    return out;
  });
}

// ---------- WeekendPlanning ----------
async function weekendLogin() {
  let ck = cache.get('wk_cookie');
  if (ck && Date.now() - ck.t < 6 * 3600 * 1000) return ck.v;
  const r = await fetch(`${WEEKEND_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: WEEKEND_PIN }),
  });
  if (!r.ok) throw new Error('weekend login failed');
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  cache.set('wk_cookie', { t: Date.now(), v: cookie });
  return cookie;
}
async function fetchWeekend() {
  return cached('weekend', 5 * 60 * 1000, async () => {
    const cookie = await weekendLogin();
    const s = await getJSON(`${WEEKEND_URL}/api/state`, { Cookie: cookie });
    const today = localISO();
    const future = (s.weekends || []).filter(w => w.end >= today).sort((a, b) => a.sat < b.sat ? -1 : 1);
    const avFor = id => {
      const av = {};
      for (const a of (s.avail || []).filter(a => a.weekend_id === id))
        av[a.person] = { state: a.state, note: a.note, golden: !!a.golden };
      return av;
    };
    const compact = w => ({ id: w.id, start: w.start, end: w.end, label: w.label, status: w.status,
      title: w.title, destination: w.destination, av: avFor(w.id) });
    const detail = w => {
      if (!w) return null;
      const items = (s.items || []).filter(i => i.weekend_id === w.id);
      return { ...compact(w), notes: w.notes, url: w.url,
        items: items.slice(0, 6).map(i => ({ day: i.day, time: i.time, text: i.text, done: !!i.done })),
        itemCount: items.length };
    };
    const next = future[0] || null;
    const pinIds = db.prepare('SELECT weekend_id FROM pins').all().map(p => p.weekend_id);
    const pinned = future.filter(w => pinIds.includes(w.id) && (!next || w.id !== next.id)).map(compact);
    const upcoming = future.slice(1, 7).filter(w => !pinIds.includes(w.id)).map(compact);
    // picker list for the settings modal: future weekends worth pinning
    const all = future.slice(0, 40).map(w => ({ id: w.id, start: w.start, end: w.end,
      title: w.title || w.destination || '', status: w.status, pinned: pinIds.includes(w.id) }));
    return { next: detail(next), pinned, upcoming, all, url: WEEKEND_URL };
  });
}

// ---------- WorkoutPlanning (best-effort; endpoint shape may evolve) ----------
async function fetchWorkouts() {
  return cached('workouts', 10 * 60 * 1000, async () => {
    const today = localISO();
    let days = {};
    try {
      const j = await getJSON(`${WORKOUT_URL}/api/state?start=${today}&end=${today}`);
      days = j.days || {};
    } catch (e) { /* leave empty */ }
    return { today: days[today] || null, raw: Object.keys(days).length ? days : null, url: WORKOUT_URL };
  });
}

// ---------- chores ----------
function choreAssignee(c, dateStr) {
  if (c.assignee !== 'alt') return c.assignee;
  return (isoWeek(dateStr) + c.id) % 2 === 0 ? 'b' : 'e';
}
function choresFor(dateStr, dow, isToday = false) {
  const rows = db.prepare('SELECT * FROM chores WHERE active = 1 ORDER BY pos, id').all();
  const out = [];
  for (const c of rows) {
    let show = false, markDate = dateStr, overdue = false;
    if (c.cadence === 'daily') show = true;
    else if (c.cadence === 'weekly') show = c.day === dow;
    else if (c.cadence === 'once' && c.due) {
      if (c.due === dateStr) show = true;
      else if (isToday && c.due < dateStr) {
        // overdue one-time chores roll forward to today until finished
        markDate = c.due;
        const marks = db.prepare('SELECT person FROM chore_marks WHERE chore_id = ? AND date = ?').all(c.id, c.due);
        const has = p => marks.some(m => m.person === p);
        const doneAll = c.assignee === 'both' ? has('b') && has('e') : marks.length > 0;
        if (!doneAll) { show = true; overdue = true; }
      }
    }
    if (!show) continue;
    const marks = db.prepare('SELECT person FROM chore_marks WHERE chore_id = ? AND date = ?').all(c.id, markDate);
    const by = { b: marks.some(m => m.person === 'b'), e: marks.some(m => m.person === 'e') };
    const assignee = choreAssignee(c, dateStr);
    const done = c.assignee === 'both' ? by.b && by.e : by.b || by.e;
    out.push({ id: c.id, title: c.title, area: c.area, cadence: c.cadence, due: c.due || '',
      markDate, overdue, assignee, configured: c.assignee, done, by });
  }
  return out;
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/', (req, res) => {
  if (readSession(req)) return res.redirect('/dash');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/api/login', (req, res) => {
  const pin = String((req.body || {}).pin || '').trim();
  const role = pin === BRENDAN_PIN ? 'b' : pin === EMMA_PIN ? 'e' : null;
  if (!role) return res.status(401).json({ error: 'nope' });
  res.setHeader('Set-Cookie',
    `kd_sess=${encodeURIComponent(makeCookie(role))}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
  res.json({ role });
});
app.get('/dash', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

app.get('/api/dashboard', requireAuth, async (req, res) => {
  const now = new Date();
  const today = localISO(now), dow = localDow(now);
  const wrap = p => p.then(data => ({ ok: true, data })).catch(e => ({ ok: false, error: String(e.message || e) }));
  const [weather, mbta, weekend, workouts] = await Promise.all([
    wrap(fetchWeather()), wrap(fetchMbta()), wrap(fetchWeekend()), wrap(fetchWorkouts()),
  ]);
  // week strip for chores: today + next 6 days
  const week = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const ds = localISO(d), ddow = localDow(d);
    week.push({ date: ds, dow: ddow, chores: choresFor(ds, ddow, i === 0) });
  }
  res.json({
    role: req.role, serverTime: now.toISOString(), today,
    weather, mbta, weekend, workouts,
    chores: { today: choresFor(today, dow, true), week },
    photos: db.prepare('SELECT id, file, caption FROM photos ORDER BY id DESC LIMIT 60').all(),
    feedbackOpen: db.prepare("SELECT COUNT(*) c FROM feedback WHERE status='new'").get().c,
  });
});

// chores CRUD + toggle
app.post('/api/chores', requireAuth, (req, res) => {
  const { title = '', area = '', cadence = 'weekly', day = -1, assignee = 'alt', due = '' } = req.body || {};
  if (!title.trim()) return res.status(400).json({ error: 'title required' });
  const cad = ['daily', 'weekly', 'once'].includes(cadence) ? cadence : 'weekly';
  if (cad === 'once' && !/^\d{4}-\d{2}-\d{2}$/.test(String(due))) return res.status(400).json({ error: 'due date required for one-time chores' });
  const pos = (db.prepare('SELECT MAX(pos) m FROM chores').get().m || 0) + 1;
  db.prepare('INSERT INTO chores (title, area, cadence, day, assignee, pos, due) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(String(title), String(area), cad, Number(day), String(assignee), pos, cad === 'once' ? String(due) : '');
  res.json({ ok: true });
});
app.patch('/api/chores/:id', requireAuth, (req, res) => {
  const c = db.prepare('SELECT id FROM chores WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'no such chore' });
  for (const f of ['title', 'area', 'cadence', 'assignee']) if (f in req.body)
    db.prepare(`UPDATE chores SET ${f} = ? WHERE id = ?`).run(String(req.body[f]), req.params.id);
  for (const f of ['day', 'pos', 'active']) if (f in req.body)
    db.prepare(`UPDATE chores SET ${f} = ? WHERE id = ?`).run(Number(req.body[f]), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/chores/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM chores WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM chore_marks WHERE chore_id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/chores/:id/toggle', requireAuth, (req, res) => {
  const date = String((req.body || {}).date || localISO());
  const person = ['b', 'e'].includes((req.body || {}).person) ? req.body.person : req.role;
  const existing = db.prepare('SELECT * FROM chore_marks WHERE chore_id = ? AND date = ? AND person = ?')
    .get(req.params.id, date, person);
  if (existing) db.prepare('DELETE FROM chore_marks WHERE chore_id = ? AND date = ? AND person = ?')
    .run(req.params.id, date, person);
  else db.prepare('INSERT INTO chore_marks (chore_id, date, person, done_at) VALUES (?, ?, ?, ?)')
    .run(req.params.id, date, person, new Date().toISOString());
  res.json({ ok: true, done: !existing });
});
app.get('/api/chores', requireAuth, (req, res) => {
  res.json({ chores: db.prepare('SELECT * FROM chores WHERE active = 1 ORDER BY pos, id').all() });
});

// photos
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'photos'),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().slice(0, 6);
      cb(null, crypto.randomBytes(8).toString('hex') + ext);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});
// reverse geocode with sqlite cache + 1 req/s politeness for Nominatim
let geoLast = 0;
async function placeName(lat, lon) {
  const key = lat.toFixed(3) + ',' + lon.toFixed(3);
  const hit = db.prepare('SELECT name FROM geo_cache WHERE key = ?').get(key);
  if (hit) return hit.name;
  const wait = Math.max(0, geoLast + 1100 - Date.now());
  if (wait) await new Promise(r => setTimeout(r, wait));
  geoLast = Date.now();
  try {
    const j = await getJSON(`${GEO_BASE}/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10`,
      { 'User-Agent': NWS_UA }, 6000);
    const a = j.address || {};
    const city = a.city || a.town || a.village || a.hamlet || a.municipality || a.county || '';
    const region = a.state || a.country || '';
    const name = [city, region].filter(Boolean).join(', ');
    if (name) db.prepare('INSERT OR REPLACE INTO geo_cache (key, name) VALUES (?, ?)').run(key, name);
    return name;
  } catch (e) { return ''; }
}
function fmtTaken(d) {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
  } catch (e) { return ''; }
}
app.post('/api/photos', requireAuth, upload.array('images', 30), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'image required' });
  const manual = String((req.body || {}).caption || '').trim();
  const results = [];
  for (const f of files) {
    let taken = '', place = '', lat = null, lon = null;
    try {
      const ex = await exifr.parse(f.path, { gps: true });
      if (ex) {
        const dt = ex.DateTimeOriginal || ex.CreateDate;
        if (dt instanceof Date && !isNaN(dt)) taken = fmtTaken(dt);
        if (typeof ex.latitude === 'number' && typeof ex.longitude === 'number') {
          lat = ex.latitude; lon = ex.longitude;
          place = await placeName(lat, lon);
        }
      }
    } catch (e) { /* no exif, fine */ }
    // manual caption wins when uploading a single photo; otherwise auto place · date
    const auto = [place, taken].filter(Boolean).join(' · ');
    const caption = (files.length === 1 && manual) ? manual : auto;
    db.prepare('INSERT INTO photos (file, caption, added_by, created, taken, place) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.filename, caption, req.role, new Date().toISOString(), taken, place);
    results.push({ file: f.filename, caption });
  }
  res.json({ ok: true, count: results.length, results });
});
app.get('/api/photos', requireAuth, (req, res) => {
  res.json({ photos: db.prepare('SELECT * FROM photos ORDER BY id DESC').all() });
});
app.patch('/api/photos/:id', requireAuth, (req, res) => {
  if ('caption' in (req.body || {}))
    db.prepare('UPDATE photos SET caption = ? WHERE id = ?').run(String(req.body.caption), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/photos/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT file FROM photos WHERE id = ?').get(req.params.id);
  if (p && p.file) fs.rm(path.join(DATA_DIR, 'photos', p.file), () => {});
  db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.get('/img/photos/:file', requireAuth, (req, res) => {
  const f = path.basename(req.params.file);
  res.sendFile(path.join(DATA_DIR, 'photos', f), err => { if (err) res.status(404).end(); });
});

// pinned weekends
app.post('/api/pins', requireAuth, (req, res) => {
  const id = String((req.body || {}).weekend_id || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) return res.status(400).json({ error: 'weekend_id required' });
  db.prepare('INSERT OR REPLACE INTO pins (weekend_id, created) VALUES (?, ?)').run(id, new Date().toISOString());
  cache.delete('weekend');
  res.json({ ok: true });
});
app.delete('/api/pins/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM pins WHERE weekend_id = ?').run(req.params.id);
  cache.delete('weekend');
  res.json({ ok: true });
});

// feedback
app.post('/api/feedback', requireAuth, (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const person = ['b', 'e'].includes((req.body || {}).person) ? req.body.person : req.role;
  db.prepare('INSERT INTO feedback (person, text, created) VALUES (?, ?, ?)')
    .run(person, text, new Date().toISOString());
  res.json({ ok: true });
});
app.get('/api/feedback', requireAuth, (req, res) => {
  res.json({ feedback: db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT 100').all() });
});
app.patch('/api/feedback/:id', requireAuth, (req, res) => {
  if ('status' in (req.body || {}))
    db.prepare('UPDATE feedback SET status = ? WHERE id = ?').run(String(req.body.status), req.params.id);
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use((req, res) => res.status(404).send('Not found'));
app.listen(PORT, () => console.log(`Kitchen Dashboard on :${PORT}, data in ${DATA_DIR}`));
