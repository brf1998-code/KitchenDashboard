// Local mock of the three upstreams, for testing in a sandbox with no egress.
// Not deployed. Run: node mock-upstreams.js (listens on :4000)
const express = require('express');
const app = express();
app.use(express.json());
const iso = d => d.toISOString();
const mins = n => new Date(Date.now() + n * 60000);

// --- WeekendPlanning (mounted at /wk) ---
app.post('/wk/api/login', (req, res) => {
  res.setHeader('Set-Cookie', 'wp_sess=mock; Path=/');
  res.json({ role: 'b' });
});
app.get('/wk/api/state', (req, res) => res.json({
  weekends: [
    { id: '2026-08-22', sat: '2026-08-22', start: '2026-08-22', end: '2026-08-23', label: '',
      status: 'planning', title: 'Concord bike day', destination: 'Concord, MA',
      notes: 'Minuteman trail if weather holds.', url: '' },
    { id: '2026-09-05', sat: '2026-09-05', start: '2026-09-05', end: '2026-09-07', label: 'Labor Day (long weekend)',
      status: 'planned', title: 'Portland, ME', destination: 'Portland, Maine',
      notes: 'Airbnb booked. Lobster rolls at Highroller.', url: '' },
    { id: '2026-08-29', sat: '2026-08-29', start: '2026-08-29', end: '2026-08-30', label: '',
      status: 'open', title: '', destination: '', notes: '', url: '' },
    { id: '2026-09-12', sat: '2026-09-12', start: '2026-09-12', end: '2026-09-13', label: '',
      status: 'open', title: '', destination: '', notes: '', url: '' },
    { id: '2026-09-19', sat: '2026-09-19', start: '2026-09-19', end: '2026-09-20', label: '',
      status: 'candidate', title: '', destination: '', notes: '', url: '' },
    { id: '2026-10-10', sat: '2026-10-10', start: '2026-10-10', end: '2026-10-12', label: "Indigenous Peoples' Day (long weekend)",
      status: 'open', title: '', destination: '', notes: '', url: '' },
    { id: '2026-11-14', sat: '2026-11-14', start: '2026-11-14', end: '2026-11-15', label: '',
      status: 'planned', title: "Molly's wedding", destination: 'Newport, RI', notes: '', url: '' },
  ],
  avail: [
    { weekend_id: '2026-08-22', person: 'b', state: 'free', note: '', golden: 0 },
    { weekend_id: '2026-08-22', person: 'e', state: 'busy', note: 'On call until Sat 2 PM', golden: 0 },
    { weekend_id: '2026-09-05', person: 'b', state: 'free', note: '', golden: 0 },
    { weekend_id: '2026-09-05', person: 'e', state: 'free', note: 'Golden weekend', golden: 1 },
  ],
  items: [
    { weekend_id: '2026-08-22', day: 'Sat', time: '9:00', text: 'Bikes on the commuter rail', done: 0 },
    { weekend_id: '2026-08-22', day: 'Sat', time: '12:30', text: 'Lunch in Concord center', done: 0 },
    { weekend_id: '2026-08-22', day: 'Sun', time: '', text: 'Lazy morning + farmers market', done: 0 },
  ],
  events: [], ideas: [], links: [], calToken: 'mock',
}));

// --- MBTA ---
app.get('/predictions', (req, res) => {
  const stop = (req.query.filter || {}).stop || req.query['filter[stop]'];
  const offsets = stop === 'place-cntsq' ? [3, 9, 17, 26, 38, 51] : stop === '69' ? [6, 21, 44, 68] : [11, 41, 71];
  res.json({ data: offsets.map((m, i) => ({ id: 'p' + i, attributes: { departure_time: iso(mins(m)) } })) });
});
app.get('/schedules', (req, res) => res.json({ data: [] }));

// --- NWS ---
const base = 'http://localhost:4000';
app.get('/points/:pt', (req, res) => res.json({ properties: {
  forecastHourly: base + '/hourly', forecast: base + '/daily' } }));
app.get('/hourly', (req, res) => res.json({ properties: { periods:
  Array.from({ length: 12 }, (_, i) => ({
    startTime: iso(mins(i * 60)), temperature: [78, 80, 82, 83, 83, 82, 79, 76, 73, 71, 69, 68][i],
    temperatureUnit: 'F', shortForecast: i < 5 ? 'Sunny' : i < 8 ? 'Partly Cloudy' : 'Clear',
    probabilityOfPrecipitation: { value: i === 6 ? 25 : 0 }, isDaytime: i < 6,
  })) } }));
app.get('/daily', (req, res) => res.json({ properties: { periods: [
  { name: 'Today', temperature: 83, shortForecast: 'Sunny', probabilityOfPrecipitation: { value: 0 }, isDaytime: true, detailedForecast: '' },
  { name: 'Tonight', temperature: 66, shortForecast: 'Clear', probabilityOfPrecipitation: { value: 0 }, isDaytime: false, detailedForecast: '' },
  { name: 'Wednesday', temperature: 85, shortForecast: 'Chance Showers', probabilityOfPrecipitation: { value: 40 }, isDaytime: true, detailedForecast: '' },
  { name: 'Wednesday Night', temperature: 68, shortForecast: 'Showers Likely', probabilityOfPrecipitation: { value: 60 }, isDaytime: false, detailedForecast: '' },
] } }));

// --- WorkoutPlanning (mounted at /wo) ---
const DOW3 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const todayD = new Date();
app.get('/wo/api/:weekId', (req, res) => {
  const id = req.params.weekId;
  if (!id.startsWith('wkplan-')) return res.json({ days: {} });
  if (id.includes('emma')) return res.json({ weekId: id, title: 'Week of Aug 17–23', days: [
    { d: DOW3[todayD.getDay()], name: 'Tempo Run + Core', type: 'run', dur: '~45 min',
      block: 'after shift', items: [{ n: 'Tempo run', r: '4 mi', s: '' }, { n: 'Plank circuit', r: '45s', s: 3 }] },
  ] });
  return res.json({ weekId: id, title: 'Week of Aug 17–23', days: [
    { d: DOW3[todayD.getDay()], date: `${todayD.getMonth()+1}/${todayD.getDate()}`,
      name: 'Lower — Squat Calibration', type: 'lift', dur: '~55 min work', block: '5:00–7:00 AM',
      items: [{ n: 'Back Squat', r: 5, s: 4 }, { n: 'Romanian Deadlift', r: 8, s: 3 },
        { n: 'Split Squat', r: 10, s: 3 }, { n: 'Calf Raise', r: 12, s: 3 }] },
  ] });
});

// --- Nominatim reverse geocode ---
app.get('/reverse', (req, res) => res.json({
  address: { city: 'Cambridge', state: 'Massachusetts' } }));

app.listen(4000, () => console.log('mock upstreams on :4000'));
