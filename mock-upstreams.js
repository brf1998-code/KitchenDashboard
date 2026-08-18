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
  const offsets = stop === 'place-cntsq' ? [3, 9, 17] : stop === '69' ? [6, 21] : [11, 41];
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
app.get('/wo/api/state', (req, res) => res.json({ days: {
  [new Date().toISOString().slice(0, 10)]: {
    Brendan: 'Push day — bench 4x6, OHP 3x8, dips, 20 min zone 2',
    Emma: 'Tempo run 4 mi + core',
  } } }));

app.listen(4000, () => console.log('mock upstreams on :4000'));
