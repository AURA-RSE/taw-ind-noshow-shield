// NoShow Shield: core logic. Runs in the tests (node) and inside n8n Code nodes
// (scripts/build-workflows.js copies it in). No dependencies, no Node built-ins:
// HMAC-SHA256 is implemented below so it works in n8n's sandbox without extra settings.

const NS_DEFAULTS = {
  clinicName: 'Harbourview Family Clinic',
  timezone: 'Africa/Lagos',
  calendarId: '',
  baseUrl: '', // public n8n URL, e.g. https://x.trycloudflare.com
  secret: '', // signs one-tap links
  channel: 'whatsapp', // 'sms' | 'whatsapp' | 'outbox'
  reminderHours: [24, 2],
  slotMinutes: 30,
  hours: { 1: [8, 17], 2: [8, 17], 3: [8, 17], 4: [8, 17], 5: [8, 17], 6: [9, 13] }, // weekday -> [open, close)
  searchDays: 7,
  maxSlotsShown: 6,
  linkTtlHours: 72,
  offerTtlMinutes: 60,
  offerFanout: 2, // how many waitlisted patients get each freed slot (first to claim wins)
};

// ---------- HMAC-SHA256 (pure JS) ----------
function nsSha256(bytes) {
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const l = bytes.length;
  const withPad = new Uint8Array(((l + 9 + 63) >> 6) << 6);
  withPad.set(bytes);
  withPad[l] = 0x80;
  const bits = l * 8;
  withPad[withPad.length - 4] = (bits >>> 24) & 255;
  withPad[withPad.length - 3] = (bits >>> 16) & 255;
  withPad[withPad.length - 2] = (bits >>> 8) & 255;
  withPad[withPad.length - 1] = bits & 255;
  const w = new Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (withPad[off + i * 4] << 24) | (withPad[off + i * 4 + 1] << 16) | (withPad[off + i * 4 + 2] << 8) | withPad[off + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = new Uint8Array(32);
  H.forEach((v, i) => { out[i * 4] = v >>> 24; out[i * 4 + 1] = (v >>> 16) & 255; out[i * 4 + 2] = (v >>> 8) & 255; out[i * 4 + 3] = v & 255; });
  return out;
}

function nsUtf8(str) {
  const out = [];
  for (const ch of String(str)) {
    let c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

function nsHmac(key, msg) {
  let k = nsUtf8(key);
  if (k.length > 64) k = nsSha256(k);
  const pad = (byte) => { const p = new Uint8Array(64); for (let i = 0; i < 64; i++) p[i] = (k[i] || 0) ^ byte; return p; };
  const m = nsUtf8(msg);
  const inner = new Uint8Array(64 + m.length); inner.set(pad(0x36)); inner.set(m, 64);
  const ih = nsSha256(inner);
  const outer = new Uint8Array(96); outer.set(pad(0x5c)); outer.set(ih, 64);
  return nsSha256(outer);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function nsB64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '') + (i + 2 < bytes.length ? B64[n & 63] : '');
  }
  return s;
}
function nsB64urlDecode(s) {
  const bytes = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 255); }
  }
  return new Uint8Array(bytes);
}
function nsUtf8Decode(bytes) {
  let s = '', i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xe0) s += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
    else if (b < 0xf0) s += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
    else { const c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63); s += String.fromCodePoint(c); }
  }
  return s;
}

// Signed, expiring token for one-tap links. Tampering or expiry -> null.
function signToken(payload, secret) {
  if (!secret) throw new Error('link secret not configured');
  const body = nsB64url(nsUtf8(JSON.stringify(payload)));
  return body + '.' + nsB64url(nsHmac(secret, body).slice(0, 16));
}
function verifyToken(token, secret, now) {
  if (!token || !secret || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || nsB64url(nsHmac(secret, body).slice(0, 16)) !== sig) return null;
  let payload;
  try { payload = JSON.parse(nsUtf8Decode(nsB64urlDecode(body))); } catch (e) { return null; }
  if (!payload || !payload.exp || (now || new Date()).getTime() > payload.exp) return null;
  return payload;
}

// ---------- time helpers ----------
function nsParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, wd: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday] };
}
// Local wall-clock time in tz -> Date (UTC instant).
function nsZoned(y, m, d, h, min, tz) {
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {
    const p = nsParts(new Date(guess), tz);
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Date.UTC(y, m - 1, d, h, min);
    guess -= diff;
  }
  return new Date(guess);
}
function nsSpoken(date, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
}
function nsDateOnly(date, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(date);
}
function nsTimeOnly(date, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
}

// ---------- appointments ----------
function nsNormalizePhone(raw) {
  const p = String(raw || '').replace(/[^+0-9]/g, '');
  const e = p.startsWith('+') ? p : (p.startsWith('0') ? '+234' + p.slice(1) : '+' + p);
  return /^\+[1-9][0-9]{7,14}$/.test(e) ? e : '';
}

// Appointment details live in the Calendar event description as "Key: value" lines.
function parseAppointment(ev) {
  if (!ev || !ev.id || !ev.start || !ev.start.dateTime) return null;
  const meta = {};
  for (const line of String(ev.description || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_ ]+?)\s*:\s*(.+?)\s*$/);
    if (m) meta[m[1].toLowerCase().replace(/\s+/g, '_')] = m[2];
  }
  return {
    id: ev.id,
    summary: ev.summary || '',
    start: new Date(ev.start.dateTime),
    end: new Date((ev.end && ev.end.dateTime) || ev.start.dateTime),
    patient: meta.patient || (ev.summary || '').split(/[–-]/)[0].trim() || 'Patient',
    phone: nsNormalizePhone(meta.phone),
    service: meta.service || 'Appointment',
    consent: /^(yes|true|y)$/i.test(meta.consent || ''),
    status: (meta.status || 'booked').toLowerCase(),
    cancelled: ev.status === 'cancelled',
    description: ev.description || '',
  };
}

function cfgOf(config) {
  return Object.assign({}, NS_DEFAULTS, config || {});
}

function linkFor(cfg, payload, action, extra) {
  const t = signToken(payload, cfg.secret);
  let u = `${cfg.baseUrl.replace(/\/$/, '')}/webhook/noshow?t=${encodeURIComponent(t)}`;
  if (action) u += `&a=${action}`;
  if (extra) u += extra;
  return u;
}

function firstName(name) {
  return String(name || '').split(/\s+/)[0] || 'there';
}

// Which reminders are due now? Windows: the 24h reminder goes out when 2h < time-to-start <= 24h,
// the 2h reminder when 0 < time-to-start <= 2h. A reminder already in the Outbox is never re-sent,
// so a missed run catches up and an extra run does nothing.
function dueReminders(events, outboxRows, now, config) {
  const cfg = cfgOf(config);
  const offsets = cfg.reminderHours.slice().sort((a, b) => b - a);
  const sent = new Set((outboxRows || []).filter((r) => r && r.appointment_id && /^(sent|queued|logged|delivered)$/i.test(String(r.status || ''))).map((r) => `${r.appointment_id}|${r.kind}`));
  const ops = [];
  const skipped = [];
  for (const ev of events || []) {
    const a = parseAppointment(ev);
    if (!a || a.cancelled || a.status === 'cancelled') continue;
    const hrs = (a.start - now) / 3600000;
    if (hrs <= 0) continue;
    for (let i = 0; i < offsets.length; i++) {
      const upper = offsets[i];
      const lower = offsets[i + 1] || 0;
      if (hrs > upper || hrs <= lower) continue;
      const kind = `reminder_${upper}h`;
      if (sent.has(`${a.id}|${kind}`)) break;
      if (!a.consent) { skipped.push({ id: a.id, reason: 'no consent' }); break; }
      if (!a.phone) { skipped.push({ id: a.id, reason: 'no valid phone' }); break; }
      const link = linkFor(cfg, { k: 'appt', id: a.id, exp: a.start.getTime() + 3600000 });
      const when = nsSpoken(a.start, cfg.timezone);
      const body = `Hi ${firstName(a.patient)}, this is ${cfg.clinicName}. Reminder: your ${a.service} is ${upper <= 2 ? 'today at ' + nsTimeOnly(a.start, cfg.timezone) : 'on ' + when}.\nConfirm, reschedule or cancel in one tap: ${link}`;
      ops.push(messageOp(cfg, { to: a.phone, body, kind, appointment_id: a.id, link, patient: a.patient, vars: { 1: nsDateOnly(a.start, cfg.timezone), 2: nsTimeOnly(a.start, cfg.timezone) } }, now));
      break;
    }
  }
  return { ops, skipped };
}

// Routes a message: 'sms' sends the full text, 'whatsapp' sends the approved appointment-reminder
// template (business-initiated WhatsApp messages must be templates), 'outbox' only logs it.
// Waitlist offers have no approved template, so on the WhatsApp channel they're logged to the Outbox.
function messageOp(cfg, m, now) {
  let op = cfg.channel === 'sms' ? 'sms' : cfg.channel === 'whatsapp' ? 'whatsapp' : 'outbox';
  let note = '';
  if (op === 'whatsapp' && m.kind !== 'reminder_24h' && m.kind !== 'reminder_2h') { op = 'outbox'; note = 'no approved WhatsApp template for this message type'; }
  return { op, channel: cfg.channel, ...m, note, created_at: now.toISOString() };
}

// Free slots in clinic hours over the next N days that don't overlap any busy event.
function freeSlots(busyEvents, now, config, opts) {
  const cfg = cfgOf(config);
  const o = opts || {};
  const durMin = o.durationMinutes || cfg.slotMinutes;
  const busy = (busyEvents || [])
    .filter((e) => e && e.status !== 'cancelled' && e.start && e.start.dateTime && e.id !== o.excludeId)
    .map((e) => [new Date(e.start.dateTime).getTime(), new Date((e.end && e.end.dateTime) || e.start.dateTime).getTime()]);
  const out = [];
  const earliest = now.getTime() + 60 * 60000; // at least 1h notice
  const today = nsParts(now, cfg.timezone);
  for (let day = 0; day <= cfg.searchDays && out.length < (o.limit || cfg.maxSlotsShown); day++) {
    const base = nsZoned(today.y, today.m, today.d, 12, 0, cfg.timezone).getTime() + day * 86400000;
    const p = nsParts(new Date(base), cfg.timezone);
    const hrs = cfg.hours[p.wd];
    if (!hrs) continue;
    for (let mins = hrs[0] * 60; mins + durMin <= hrs[1] * 60; mins += cfg.slotMinutes) {
      const s = nsZoned(p.y, p.m, p.d, Math.floor(mins / 60), mins % 60, cfg.timezone).getTime();
      const e = s + durMin * 60000;
      if (s < earliest) continue;
      if (busy.some(([bs, be]) => s < be && e > bs)) continue;
      out.push(new Date(s));
      if (out.length >= (o.limit || cfg.maxSlotsShown)) break;
    }
  }
  return out;
}

function isSlotFree(busyEvents, start, end, excludeId) {
  const s = start.getTime(), e = end.getTime();
  return !(busyEvents || []).some((ev) => ev && ev.status !== 'cancelled' && ev.id !== excludeId && ev.start && ev.start.dateTime && s < new Date((ev.end && ev.end.dateTime) || ev.start.dateTime).getTime() && e > new Date(ev.start.dateTime).getTime());
}

function inClinicHours(start, end, cfg) {
  const p = nsParts(start, cfg.timezone), q = nsParts(new Date(end.getTime() - 1), cfg.timezone);
  const hrs = cfg.hours[p.wd];
  if (!hrs || p.d !== q.d) return false;
  const sm = p.h * 60 + p.min, em = q.h * 60 + q.min + 1;
  return sm >= hrs[0] * 60 && em <= hrs[1] * 60;
}

// Waitlist rows: waitlist_id, patient, phone, service, preference (morning|afternoon|any), consent, added_at, active
function pickWaitlist(waitlist, activityRows, slotStart, config) {
  const cfg = cfgOf(config);
  const booked = new Set((activityRows || []).filter((r) => r && r.action === 'waitlist_booked').map((r) => String(r.waitlist_id)));
  const offeredThisSlot = new Set((activityRows || []).filter((r) => r && r.action === 'waitlist_offered' && r.slot_start === slotStart.toISOString()).map((r) => String(r.waitlist_id)));
  const hour = nsParts(slotStart, cfg.timezone).h;
  return (waitlist || [])
    .filter((w) => w && w.waitlist_id && /^(yes|true|y)$/i.test(String(w.active || 'yes')) && /^(yes|true|y)$/i.test(String(w.consent || '')))
    .filter((w) => nsNormalizePhone(w.phone))
    .filter((w) => !booked.has(String(w.waitlist_id)) && !offeredThisSlot.has(String(w.waitlist_id)))
    .filter((w) => { const pref = String(w.preference || 'any').toLowerCase(); return pref === 'any' || (pref === 'morning' ? hour < 12 : hour >= 12); })
    .sort((a, b) => String(a.added_at || '').localeCompare(String(b.added_at || '')))
    .slice(0, cfg.offerFanout);
}

function offerOps(freed, waitlist, activityRows, now, cfg) {
  const ops = [];
  for (const w of pickWaitlist(waitlist, activityRows, freed.start, cfg)) {
    const payload = { k: 'offer', wid: String(w.waitlist_id), s: freed.start.getTime(), e: freed.end.getTime(), svc: w.service || freed.service, exp: Math.min(now.getTime() + cfg.offerTtlMinutes * 60000, freed.start.getTime()) };
    const link = linkFor(cfg, payload);
    const body = `Hi ${firstName(w.patient)}, a ${w.service || 'appointment'} slot just opened at ${cfg.clinicName}: ${nsSpoken(freed.start, cfg.timezone)}. First to tap gets it (offer ends in ${cfg.offerTtlMinutes} min): ${link}`;
    ops.push(messageOp(cfg, { to: nsNormalizePhone(w.phone), body, kind: 'waitlist_offer', appointment_id: '', waitlist_id: String(w.waitlist_id), link, patient: w.patient, vars: { 1: nsDateOnly(freed.start, cfg.timezone), 2: nsTimeOnly(freed.start, cfg.timezone) } }, now));
    ops.push(activity('waitlist_offered', { waitlist_id: String(w.waitlist_id), slot_start: freed.start.toISOString(), detail: `offered to ${w.patient}` }, now));
  }
  if (!ops.length) ops.push(activity('slot_freed_no_match', { slot_start: freed.start.toISOString(), detail: 'no matching waitlist entry' }, now));
  return ops;
}

function activity(action, fields, now) {
  return { op: 'activity', row: Object.assign({ at: now.toISOString(), action, appointment_id: '', waitlist_id: '', slot_start: '', detail: '' }, fields) };
}

function calendarOp(cfg, method, eventId, body) {
  const base = `/calendars/${encodeURIComponent(cfg.calendarId)}/events`;
  return { op: 'calendar', method, path: eventId ? `${base}/${encodeURIComponent(eventId)}` : base, body: body || null };
}

function setStatus(description, status) {
  const lines = String(description || '').split(/\r?\n/).filter((l) => !/^\s*status\s*:/i.test(l));
  lines.push(`Status: ${status}`);
  return lines.join('\n');
}

// ---------- HTML pages ----------
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function page(cfg, title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · ${esc(cfg.clinicName)}</title><style>body{margin:0;font:16px/1.5 system-ui,-apple-system,sans-serif;background:#f5f4f0;color:#1d1d1b}main{max-width:440px;margin:0 auto;padding:32px 20px}.card{background:#fff;border:1px solid #e4e2dc;border-radius:14px;padding:22px}h1{font-size:22px;margin:0 0 8px}p{margin:8px 0}.muted{color:#6b6a66;font-size:14px}.btn{display:block;text-align:center;text-decoration:none;font-weight:600;padding:13px;border-radius:10px;margin-top:10px;background:#0b6e4f;color:#fff}.btn.alt{background:#fff;color:#0b6e4f;border:1px solid #0b6e4f}.btn.warn{background:#fff;color:#b42318;border:1px solid #e4b4ae}.slots a{display:block;padding:11px;border:1px solid #e4e2dc;border-radius:10px;margin-top:8px;text-decoration:none;color:#1d1d1b}</style></head><body><main><p class="muted">${esc(cfg.clinicName)}</p><div class="card">${bodyHtml}</div><p class="muted">This page never shows medical information.</p></main></body></html>`;
}

// ---------- the one-tap link handler ----------
// query: { t, a, s }. events: Calendar events (now-1h .. +8 days). Returns { status, html, ops }.
function handleLink(query, events, waitlist, activityRows, now, config) {
  const cfg = cfgOf(config);
  const tz = cfg.timezone;
  const tok = verifyToken(query && query.t, cfg.secret, now);
  if (!tok) return { status: 'invalid', html: page(cfg, 'Link expired', '<h1>This link has expired</h1><p>Please call the clinic to make changes to your appointment.</p>'), ops: [] };
  const action = String((query && query.a) || 'view');
  const self = (a, extra) => linkFor(cfg, tok, a, extra);

  if (tok.k === 'appt') {
    const ev = (events || []).find((e) => e.id === tok.id);
    const appt = parseAppointment(ev);
    if (!appt || appt.cancelled || appt.status === 'cancelled') return { status: 'gone', html: page(cfg, 'Not found', '<h1>Appointment not found</h1><p>It may already have been cancelled or moved. Please call the clinic if you need help.</p>'), ops: [] };
    const when = nsSpoken(appt.start, tz);
    const head = `<h1>${esc(appt.service)}</h1><p><strong>${esc(when)}</strong></p><p class="muted">For ${esc(firstName(appt.patient))}</p>`;

    if (action === 'view') {
      return { status: 'ok', html: page(cfg, 'Your appointment', `${head}${appt.status === 'confirmed' ? '<p>✅ You have confirmed this appointment.</p>' : `<a class="btn" href="${esc(self('confirm'))}">Confirm I'll attend</a>`}<a class="btn alt" href="${esc(self('reschedule'))}">Reschedule</a><a class="btn warn" href="${esc(self('cancel'))}">Cancel</a>`), ops: [activity('link_opened', { appointment_id: appt.id }, now)] };
    }
    if (action === 'confirm') {
      return {
        status: 'confirmed',
        html: page(cfg, 'Confirmed', `${head}<p>✅ Thank you, you're confirmed. See you then!</p><a class="btn alt" href="${esc(self('reschedule'))}">Need to reschedule instead?</a>`),
        ops: appt.status === 'confirmed' ? [] : [calendarOp(cfg, 'PATCH', appt.id, { description: setStatus(appt.description, 'confirmed'), colorId: '10' }), activity('confirmed', { appointment_id: appt.id }, now)],
      };
    }
    if (action === 'reschedule') {
      const slots = freeSlots(events, now, cfg, { excludeId: appt.id, durationMinutes: Math.round((appt.end - appt.start) / 60000) });
      const list = slots.length ? `<div class="slots">${slots.map((s) => `<a href="${esc(self('move', '&s=' + s.getTime()))}">${esc(nsSpoken(s, tz))}</a>`).join('')}</div>` : '<p>No free slots in the next week. Please call the clinic.</p>';
      return { status: 'choose', html: page(cfg, 'Reschedule', `${head}<p>Pick a new time:</p>${list}<a class="btn alt" href="${esc(self('view'))}">Keep my current time</a>`), ops: [] };
    }
    if (action === 'move') {
      const s = new Date(Number(query.s));
      const e = new Date(s.getTime() + (appt.end - appt.start));
      if (!(s.getTime() > now.getTime() + 30 * 60000) || !inClinicHours(s, e, cfg)) return { status: 'bad_slot', html: page(cfg, 'Unavailable', `${head}<p>That time isn't available any more.</p><a class="btn" href="${esc(self('reschedule'))}">See other times</a>`), ops: [] };
      if (!isSlotFree(events, s, e, appt.id)) return { status: 'taken', html: page(cfg, 'Taken', `${head}<p>Sorry, someone just booked that time.</p><a class="btn" href="${esc(self('reschedule'))}">See other times</a>`), ops: [] };
      const freed = { start: appt.start, end: appt.end, service: appt.service };
      return {
        status: 'moved',
        html: page(cfg, 'Rescheduled', `<h1>${esc(appt.service)}</h1><p>✅ Moved to <strong>${esc(nsSpoken(s, tz))}</strong>.</p><p class="muted">You'll get a reminder before your new time.</p>`),
        ops: [
          calendarOp(cfg, 'PATCH', appt.id, { start: { dateTime: s.toISOString() }, end: { dateTime: e.toISOString() }, description: setStatus(appt.description, 'rescheduled') }),
          activity('rescheduled', { appointment_id: appt.id, slot_start: s.toISOString(), detail: `from ${appt.start.toISOString()}` }, now),
          ...offerOps(freed, waitlist, activityRows, now, cfg),
        ],
      };
    }
    if (action === 'cancel') {
      return { status: 'confirm_cancel', html: page(cfg, 'Cancel?', `${head}<p>Cancel this appointment? Your slot will be offered to someone on the waitlist.</p><a class="btn warn" href="${esc(self('cancel_yes'))}">Yes, cancel it</a><a class="btn alt" href="${esc(self('reschedule'))}">Reschedule instead</a>`), ops: [] };
    }
    if (action === 'cancel_yes') {
      return {
        status: 'cancelled',
        html: page(cfg, 'Cancelled', `<h1>${esc(appt.service)}</h1><p>Your appointment on ${esc(when)} is cancelled. Thanks for letting us know. Your slot will go to someone on the waitlist.</p>`),
        ops: [calendarOp(cfg, 'DELETE', appt.id), activity('cancelled', { appointment_id: appt.id, slot_start: appt.start.toISOString() }, now), ...offerOps({ start: appt.start, end: appt.end, service: appt.service }, waitlist, activityRows, now, cfg)],
      };
    }
  }

  if (tok.k === 'offer') {
    const s = new Date(tok.s), e = new Date(tok.e);
    const w = (waitlist || []).find((r) => String(r.waitlist_id) === String(tok.wid));
    const head = `<h1>${esc(tok.svc || 'Appointment')}</h1><p><strong>${esc(nsSpoken(s, tz))}</strong></p>`;
    const alreadyBooked = (activityRows || []).some((r) => r && r.action === 'waitlist_booked' && String(r.waitlist_id) === String(tok.wid) && r.slot_start === s.toISOString());
    if (alreadyBooked) return { status: 'booked', html: page(cfg, 'Booked', `${head}<p>✅ This slot is already yours.</p>`), ops: [] };
    if (!w) return { status: 'gone', html: page(cfg, 'Unavailable', `${head}<p>This offer is no longer available.</p>`), ops: [] };
    if (!isSlotFree(events, s, e)) return { status: 'taken', html: page(cfg, 'Taken', `${head}<p>Sorry, someone else took this slot first. You're still on the waitlist and we'll message you when another opens.</p>`), ops: [] };
    if (action === 'view') return { status: 'offer', html: page(cfg, 'Slot available', `${head}<p>This slot is available for ${esc(firstName(w.patient))}.</p><a class="btn" href="${esc(self('claim'))}">Book it</a>`), ops: [] };
    if (action === 'claim') {
      const description = [`Patient: ${w.patient}`, `Phone: ${nsNormalizePhone(w.phone)}`, `Service: ${tok.svc || w.service || 'Appointment'}`, 'Consent: yes', 'Status: booked', `Source: waitlist ${w.waitlist_id}`].join('\n');
      return {
        status: 'booked',
        html: page(cfg, 'Booked', `${head}<p>✅ Booked for ${esc(firstName(w.patient))}. You'll get a reminder beforehand.</p>`),
        ops: [calendarOp(cfg, 'POST', null, { summary: `${w.patient} – ${tok.svc || w.service || 'Appointment'}`, description, start: { dateTime: s.toISOString() }, end: { dateTime: e.toISOString() } }), activity('waitlist_booked', { waitlist_id: String(w.waitlist_id), slot_start: s.toISOString(), detail: `booked from waitlist` }, now)],
      };
    }
  }
  return { status: 'unknown', html: page(cfg, 'Not available', '<h1>Something went wrong</h1><p>Please call the clinic.</p>'), ops: [] };
}

// Demo data: fictional patients, all messages go to the one opted-in test phone.
function seedOps(now, config, testPhone) {
  const cfg = cfgOf(config);
  const phone = nsNormalizePhone(testPhone);
  const half = 30 * 60000;
  const at = (hoursAhead) => Math.ceil((now.getTime() + hoursAhead * 3600000) / half) * half; // next :00/:30
  const mk = (name, service, startMs) => calendarOp(cfg, 'POST', null, {
    summary: `${name} – ${service}`,
    description: [`Patient: ${name}`, `Phone: ${phone}`, `Service: ${service}`, 'Consent: yes', 'Status: booked'].join('\n'),
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(startMs + cfg.slotMinutes * 60000).toISOString() },
  });
  return {
    ops: [
      mk('Ada Test', 'Check-up', at(1.5)),
      mk('Bayo Test', 'Dental cleaning', at(20)),
      mk('Chi Test', 'Follow-up visit', at(30)),
    ],
    waitlist: [
      { waitlist_id: 'W-001', patient: 'Dami Test', phone, service: 'Check-up', preference: 'any', consent: 'yes', added_at: new Date(now.getTime() - 86400000).toISOString(), active: 'yes' },
      { waitlist_id: 'W-002', patient: 'Efe Test', phone, service: 'Any', preference: 'afternoon', consent: 'yes', added_at: new Date(now.getTime() - 3600000).toISOString(), active: 'yes' },
    ],
  };
}

// --- n8n:strip-start
module.exports = { NS_DEFAULTS, nsSha256, nsHmac, nsB64url, signToken, verifyToken, nsZoned, nsParts, parseAppointment, dueReminders, freeSlots, isSlotFree, pickWaitlist, handleLink, seedOps, nsNormalizePhone };
// --- n8n:strip-end
