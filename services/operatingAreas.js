/* 6 Nov 2026, Jeffery (Koli option A): the wider search after 15 minutes may only use drivers "within our approved
   operating areas, not simply anywhere within 30 km or anywhere in Haiti."
   The approved areas are MsouWout's active GREEN zones (its zones table, the same ones its trip validation uses), each
   with its hours (06:00-20:00 today) read in Haiti time. Fetched from MsouWout (internal key), kept 10 minutes.
   FAIL CLOSED: if MsouWout cannot be asked and nothing fresh is known, there is NO approved area - the wider search
   simply does not happen (the normal 15 km search is untouched). */
const link = require('../utils/msouwoutLink');
const TTL_MS = 10 * 60 * 1000, STALE_MS = 60 * 60 * 1000;
let cache = { at: 0, areas: [] };

function pointInPolygon(lng, lat, poly) {
  const rings = poly && poly.type === 'Polygon' ? [poly.coordinates] : poly && poly.type === 'MultiPolygon' ? poly.coordinates : [];
  for (const rs of rings) {
    const c = rs && rs[0]; if (!c || c.length < 3) continue;
    let inside = false;
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      const xi = c[i][0], yi = c[i][1], xj = c[j][0], yj = c[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}
/* the minute of the day and the weekday in Haiti, whatever the server's own clock zone */
function haitiClock(now) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Port-au-Prince', hour12: false, hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(now || new Date()).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});
  const h = Number(p.hour) % 24, m = Number(p.minute);
  return { min: h * 60 + m, day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
function hm(s) { const m = String(s || '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
function openNow(a, now) {
  const c = haitiClock(now);
  if (Array.isArray(a.days) && a.days.length && a.days.map(Number).indexOf(c.day) === -1) return false;
  const f = hm(a.from), u = hm(a.until);
  if (f === null || u === null) return true;
  return f <= u ? (c.min >= f && c.min <= u) : (c.min >= f || c.min <= u);
}
async function get() {
  if (Date.now() - cache.at < TTL_MS) return cache.areas;
  const r = await link.operatingAreas();
  if (r.status === 200 && r.data && Array.isArray(r.data.areas)) { cache = { at: Date.now(), areas: r.data.areas }; return cache.areas; }
  if (Date.now() - cache.at < STALE_MS) return cache.areas;
  console.warn('[AREAS] MsouWout operating areas unavailable (' + r.status + ') - no wider search until it answers');
  return [];
}
/* [lng, lat] inside an approved area that is open right now */
function inArea(areas, lng, lat, now) {
  return (areas || []).some(function (a) { return openNow(a, now) && pointInPolygon(lng, lat, a.polygon); });
}
function areaName(areas, lng, lat, now) {
  const a = (areas || []).find(function (x) { return openNow(x, now) && pointInPolygon(lng, lat, x.polygon); });
  return a ? a.name : '';
}
function _reset() { cache = { at: 0, areas: [] }; }
module.exports = { get, inArea, areaName, openNow, pointInPolygon, haitiClock, _reset };
