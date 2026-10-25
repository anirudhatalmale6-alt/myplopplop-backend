/* MyPlopPlop -> MsouWout, server to server (24 Oct 2026, "ONE DRIVER").
   The MsouWout driver record stays THE driver identity: MyPlopPlop asks it,
   behind the INTERNAL_SERVICE_KEY the platforms already share, and keeps only
   a reference plus the facts an approver needs. Documents are never copied -
   an administrator's screen fetches them through here when it opens them. */
const BASE = process.env.MSOUWOUT_API_URL || 'https://msouwout-backend.onrender.com';

async function ask(method, path, body) {
  const key = process.env.INTERNAL_SERVICE_KEY;
  if (!key) return { status: 503, data: { error: 'link_not_configured' } };
  /* MsouWout sleeps on Render's free plan; waking it can take most of a minute */
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 55000);
  try {
    const r = await fetch(BASE + path, {
      method, signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  } catch (e) {
    return { status: 504, data: { error: 'msouwout_unreachable' } };
  } finally { clearTimeout(t); }
}

const verify = (phone, pin) => ask('POST', '/api/drivers/internal/link-verify', { phone, pin });
const document = (id, type) => ask('GET', '/api/drivers/internal/' + encodeURIComponent(id) + '/document/' + encodeURIComponent(type));

/* "Jean Baptiste" vs "JEAN  BAPTISTE Junior": the shorter name's words all
   appear in the longer one. Anything else is shown to the approver as a
   mismatch - never linked or refused silently on a name. */
function words(n) {
  return String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}
function sameName(a, b) {
  const x = words(a), y = words(b);
  if (!x.length || !y.length) return false;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.every(w => l.indexOf(w) !== -1);
}
const VEHICLE = { motorcycle: 'moto', moto: 'moto', car: 'car', truck: 'truck', van: 'truck' };

module.exports = { verify, document, sameName, VEHICLE, BASE };
