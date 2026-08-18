// Kitchen Dashboard — B + E
// Node 22 (node:sqlite) + Express 4. Same stack pattern as WeekendPlanning.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
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

// MBTA feeds: label, route badge, query. Stop ids verified against api-v3.mbta.com.
const MBTA_FEEDS = [
  { key: 'red', badge: 'RL', color: '#DA291C', label: 'Red Line · Central → Kendall/MIT',
    params: 'filter[stop]=place-cntsq&filter[route]=Red&filter[direction_id]=0' },
  { key: 'bus1', badge: '1', color: '#FFC72C', label: '1 bus · Mass Ave opp Lee St → BMC',
    params: 'filter[stop]=69&filter[route]=1&filter[direction_id]=1' },
  { key: 'bus47', badge: '47', color: '#FFC72C', label: '47 bus · Central (Green St) → Longwood/BCH',
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
        const j = await getJSON(`${MBTA_BASE}/predictions?${f.params}&sort=departure_time&page[limit]=4`, headers);
        deps = (j.data || [])
          .map(p => p.attributes.departure_time || p.attributes.arrival_time)
          .filter(Boolean);
      } catch (e) { /* fall through to schedules */ }
      if (!deps.length) {
        live = false;
        try {
          const now = new Date();
          const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
          const j = await getJSON(`${MBTA_BASE}/schedules?${f.params}&filter[date]=${localISO(now)}&filter[min_time]=${hm.replace(':', '%3A')}&sort=departure_time&page[limit]=4`, headers);
          deps = (j.data || []).map(s => s.attributes.departure_time).filter(Boolean);
        } catch (e) { /* leave empty */ }
      }
      const mins = deps
        .map(t => Math.round((new Date(t) - Date.now()) / 60000))
        .filter(m => m > -1 && m < 180).slice(0, 3);
      out.push({ key: f.key, badge: f.badge, color: f.color, label: f.label, mins, live });
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
    const upcoming = (s.weekends || []).filter(w => w.end >= today).sort((a, b) => a.sat < b.sat ? -1 : 1);
    const next = upcoming[0] || null;
    const nextPlanned = upcoming.find(w => ['planning', 'planned'].includes(w.status) && (!next || w.id !== next.id)) ||
      (next && ['planning', 'planned'].includes(next.status) ? null : null);
    const shape = w => {
      if (!w) return null;
      const av = {}; for (const a of (s.avail || []).filter(a => a.weekend_id === w.id)) av[a.person] = { state: a.state, note: a.note, golden: !!a.golden };
      const items = (s.items || []).filter(i => i.weekend_id === w.id);
      return { id: w.id, start: w.start, end: w.end, label: w.label, status: w.status,
        title: w.title, destination: w.destination, notes: w.notes, url: w.url, av,
        items: items.slice(0, 8).map(i => ({ day: i.day, time: i.time, text: i.text, done: !!i.done })),
        itemCount: items.length };
    };
    return { next: shape(next), nextPlanned: shape(nextPlanned), url: WEEKEND_URL };
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
function choresFor(dateStr, dow) {
  const rows = db.prepare('SELECT * FROM chores WHERE active = 1 ORDER BY pos, id').all();
  const logs = db.prepare('SELECT * FROM chore_log WHERE date = ?').all(dateStr);
  return rows
    .filter(c => c.cadence === 'daily' || c.day === dow)
    .map(c => {
      const log = logs.find(l => l.chore_id === c.id);
      return { id: c.id, title: c.title, area: c.area, cadence: c.cadence,
        assignee: choreAssignee(c, dateStr), configured: c.assignee,
        done: !!log, doneBy: log ? log.person : null };
    });
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
    week.push({ date: ds, dow: ddow, chores: choresFor(ds, ddow) });
  }
  res.json({
    role: req.role, serverTime: now.toISOString(), today,
    weather, mbta, weekend, workouts,
    chores: { today: choresFor(today, dow), week },
    photos: db.prepare('SELECT id, file, caption FROM photos ORDER BY id DESC LIMIT 60').all(),
    feedbackOpen: db.prepare("SELECT COUNT(*) c FROM feedback WHERE status='new'").get().c,
  });
});

// chores CRUD + toggle
app.post('/api/chores', requireAuth, (req, res) => {
  const { title = '', area = '', cadence = 'weekly', day = -1, assignee = 'alt' } = req.body || {};
  if (!title.trim()) return res.status(400).json({ error: 'title required' });
  const pos = (db.prepare('SELECT MAX(pos) m FROM chores').get().m || 0) + 1;
  db.prepare('INSERT INTO chores (title, area, cadence, day, assignee, pos) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(title), String(area), cadence === 'daily' ? 'daily' : 'weekly', Number(day), String(assignee), pos);
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
  db.prepare('DELETE FROM chore_log WHERE chore_id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/chores/:id/toggle', requireAuth, (req, res) => {
  const date = String((req.body || {}).date || localISO());
  const person = ['b', 'e'].includes((req.body || {}).person) ? req.body.person : req.role;
  const existing = db.prepare('SELECT * FROM chore_log WHERE chore_id = ? AND date = ?').get(req.params.id, date);
  if (existing) db.prepare('DELETE FROM chore_log WHERE chore_id = ? AND date = ?').run(req.params.id, date);
  else db.prepare('INSERT INTO chore_log (chore_id, date, person, done_at) VALUES (?, ?, ?, ?)')
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
app.post('/api/photos', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'image required' });
  db.prepare('INSERT INTO photos (file, caption, added_by, created) VALUES (?, ?, ?, ?)')
    .run(req.file.filename, String((req.body || {}).caption || ''), req.role, new Date().toISOString());
  res.json({ ok: true });
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
