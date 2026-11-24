// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const n = require('../src/noshow');

const CFG = { calendarId: 'cal@group.calendar.google.com', baseUrl: 'https://demo.example', secret: 'test-secret', channel: 'whatsapp' };
const NOW = new Date('2026-11-24T09:00:00Z'); // Tue 10:00 Lagos
const PHONE = '+15550100101';
const ev = (id, startIso, mins = 30, extra = {}) => ({
  id,
  status: 'confirmed',
  summary: `Ada Test – Check-up`,
  description: ['Patient: Ada Test', `Phone: ${extra.phone ?? PHONE}`, 'Service: Check-up', `Consent: ${extra.consent ?? 'yes'}`, `Status: ${extra.status ?? 'booked'}`].join('\n'),
  start: { dateTime: startIso },
  end: { dateTime: new Date(new Date(startIso).getTime() + mins * 60000).toISOString() },
});
const q = (url) => Object.fromEntries(new URL(url).searchParams);

test('signed links: round trip, tampering and expiry are rejected', () => {
  const t = n.signToken({ k: 'appt', id: 'e1', exp: NOW.getTime() + 60000 }, 'sec');
  assert.equal(n.verifyToken(t, 'sec', NOW).id, 'e1');
  assert.equal(n.verifyToken(t, 'other', NOW), null);
  const [body, sig] = t.split('.');
  assert.equal(n.verifyToken(body.slice(0, -2) + 'AA.' + sig, 'sec', NOW), null);
  assert.equal(n.verifyToken(t, 'sec', new Date(NOW.getTime() + 120000)), null);
  assert.equal(n.verifyToken('garbage', 'sec', NOW), null);
  assert.equal(n.verifyToken(undefined, 'sec', NOW), null);
});

test('reminders: 24h window, 2h window, dedupe, consent and phone checks', () => {
  const events = [
    ev('in20h', '2026-11-25T05:00:00Z'), // 20h away -> 24h reminder
    ev('in90m', '2026-11-24T10:30:00Z'), // 1.5h away -> 2h reminder
    ev('in30h', '2026-11-25T15:00:00Z'), // 30h away -> nothing yet
    ev('past', '2026-11-24T08:00:00Z'),
    ev('noconsent', '2026-11-24T19:00:00Z', 30, { consent: 'no' }),
    ev('nophone', '2026-11-24T19:30:00Z', 30, { phone: 'abc' }),
    ev('cancelled', '2026-11-24T20:00:00Z', 30, { status: 'cancelled' }),
  ];
  const r = n.dueReminders(events, [], NOW, CFG);
  assert.deepEqual(r.ops.map((o) => [o.appointment_id, o.kind]), [['in20h', 'reminder_24h'], ['in90m', 'reminder_2h']]);
  assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ['no consent', 'no valid phone']);
  assert.match(r.ops[0].body, /^Hi Ada, this is Harbourview Family Clinic\. Reminder: your Check-up is on Wed 25 Nov/);
  assert.match(r.ops[1].body, /is today at 11:30 am/);
  assert.match(r.ops[0].link, /^https:\/\/demo\.example\/webhook\/noshow\?t=/);
  assert.deepEqual(r.ops[0].vars, { 1: 'Wed 25 Nov', 2: '6:00 am' });
  // already sent -> not sent again; a failed send is retried next run
  const again = n.dueReminders(events, [{ appointment_id: 'in20h', kind: 'reminder_24h', status: 'sent' }, { appointment_id: 'in90m', kind: 'reminder_2h', status: 'failed' }], NOW, CFG);
  assert.deepEqual(again.ops.map((o) => o.appointment_id), ['in90m']);
});

test('free slots respect clinic hours, notice period and busy events', () => {
  const busy = [ev('b1', '2026-11-24T10:00:00Z', 60)]; // 11:00-12:00 Lagos
  const slots = n.freeSlots(busy, NOW, { ...CFG, maxSlotsShown: 6 });
  const local = slots.map((s) => n.nsParts(s, 'Africa/Lagos')).map((p) => `${p.d} ${p.h}:${String(p.min).padStart(2, '0')}`);
  assert.deepEqual(local, ['24 12:00', '24 12:30', '24 13:00', '24 13:30', '24 14:00', '24 14:30']); // 11:00 has <1h notice? no: 11:00 is busy; 10:30 is < 1h
  const sat = n.freeSlots([], new Date('2026-11-28T11:30:00Z'), CFG, { limit: 3 }); // Sat 12:30 Lagos, closes 13:00
  assert.equal(n.nsParts(sat[0], 'Africa/Lagos').wd, 1); // Sunday closed -> Monday
});

test('one-tap page: view, confirm, invalid link', () => {
  const events = [ev('a1', '2026-11-25T09:00:00Z')];
  const t = n.signToken({ k: 'appt', id: 'a1', exp: NOW.getTime() + 86400000 }, CFG.secret);
  const view = n.handleLink({ t }, events, [], [], NOW, CFG);
  assert.equal(view.status, 'ok');
  assert.match(view.html, /Confirm I'll attend/);
  assert.doesNotMatch(view.html, /\+1555/); // no phone numbers on the page
  const conf = n.handleLink({ t, a: 'confirm' }, events, [], [], NOW, CFG);
  assert.equal(conf.ops[0].method, 'PATCH');
  assert.match(conf.ops[0].body.description, /Status: confirmed$/);
  assert.equal(n.handleLink({ t: t + 'x' }, events, [], [], NOW, CFG).status, 'invalid');
  assert.equal(n.handleLink({ t }, [], [], [], NOW, CFG).status, 'gone');
});

const WAIT = [
  { waitlist_id: 'W-2', patient: 'Efe Test', phone: PHONE, service: 'Any', preference: 'afternoon', consent: 'yes', added_at: '2026-11-23T10:00:00Z', active: 'yes' },
  { waitlist_id: 'W-1', patient: 'Dami Test', phone: PHONE, service: 'Check-up', preference: 'any', consent: 'yes', added_at: '2026-11-22T10:00:00Z', active: 'yes' },
  { waitlist_id: 'W-3', patient: 'No Consent', phone: PHONE, preference: 'any', consent: 'no', added_at: '2026-11-20T10:00:00Z', active: 'yes' },
  { waitlist_id: 'W-4', patient: 'Morning Only', phone: PHONE, preference: 'morning', consent: 'yes', added_at: '2026-11-21T10:00:00Z', active: 'yes' },
];

test('reschedule: list slots, move, reject taken slot, freed slot goes to the waitlist', () => {
  const events = [ev('a1', '2026-11-25T13:00:00Z'), ev('other', '2026-11-26T09:00:00Z')]; // a1 Wed 14:00 Lagos
  const t = n.signToken({ k: 'appt', id: 'a1', exp: NOW.getTime() + 86400000 }, CFG.secret);
  const choose = n.handleLink({ t, a: 'reschedule' }, events, WAIT, [], NOW, CFG);
  assert.equal(choose.status, 'choose');
  const firstLink = choose.html.match(/href="([^"]*a=move[^"]*)"/)[1].replace(/&amp;/g, '&');
  const moved = n.handleLink(q(firstLink), events, WAIT, [], NOW, CFG);
  assert.equal(moved.status, 'moved');
  const kinds = moved.ops.map((o) => o.op + (o.row ? ':' + o.row.action : ''));
  assert.deepEqual(kinds, ['calendar', 'activity:rescheduled', 'outbox', 'activity:waitlist_offered', 'outbox', 'activity:waitlist_offered']);
  // afternoon slot (14:00): W-1 (oldest, any) then W-2 (afternoon); W-3 no consent, W-4 morning only
  assert.deepEqual(moved.ops.filter((o) => o.kind === 'waitlist_offer').map((o) => o.waitlist_id), ['W-1', 'W-2']);
  const taken = n.handleLink({ t, a: 'move', s: String(new Date('2026-11-26T09:00:00Z').getTime()) }, events, WAIT, [], NOW, CFG);
  assert.equal(taken.status, 'taken');
  const closed = n.handleLink({ t, a: 'move', s: String(new Date('2026-11-25T22:00:00Z').getTime()) }, events, WAIT, [], NOW, CFG);
  assert.equal(closed.status, 'bad_slot');
});

test('cancel needs a second tap, then deletes and offers the slot', () => {
  const events = [ev('a1', '2026-11-25T08:00:00Z')]; // 09:00 Lagos -> morning
  const t = n.signToken({ k: 'appt', id: 'a1', exp: NOW.getTime() + 86400000 }, CFG.secret);
  assert.equal(n.handleLink({ t, a: 'cancel' }, events, WAIT, [], NOW, CFG).ops.length, 0);
  const yes = n.handleLink({ t, a: 'cancel_yes' }, events, WAIT, [], NOW, CFG);
  assert.equal(yes.ops[0].method, 'DELETE');
  assert.deepEqual(yes.ops.filter((o) => o.kind === 'waitlist_offer').map((o) => o.waitlist_id), ['W-4', 'W-1']); // morning slot
});

test('waitlist: no repeat offers, booked patients skipped, empty waitlist logged', () => {
  const slot = new Date('2026-11-25T13:00:00Z');
  const act = [{ action: 'waitlist_offered', waitlist_id: 'W-1', slot_start: slot.toISOString() }, { action: 'waitlist_booked', waitlist_id: 'W-2', slot_start: 'x' }];
  assert.deepEqual(n.pickWaitlist(WAIT, act, slot, CFG).map((w) => w.waitlist_id), []);
  const events = [ev('a1', '2026-11-25T13:00:00Z')];
  const t = n.signToken({ k: 'appt', id: 'a1', exp: NOW.getTime() + 86400000 }, CFG.secret);
  const res = n.handleLink({ t, a: 'cancel_yes' }, events, [], [], NOW, CFG);
  assert.equal(res.ops.at(-1).row.action, 'slot_freed_no_match');
});

test('waitlist claim: first tap books, second patient sees "taken", expired offer rejected', () => {
  const s = new Date('2026-11-25T13:00:00Z'), e = new Date('2026-11-25T13:30:00Z');
  const mk = (wid) => n.signToken({ k: 'offer', wid, s: s.getTime(), e: e.getTime(), svc: 'Check-up', exp: NOW.getTime() + 3600000 }, CFG.secret);
  const view = n.handleLink({ t: mk('W-1') }, [], WAIT, [], NOW, CFG);
  assert.match(view.html, /Book it/);
  const claim = n.handleLink({ t: mk('W-1'), a: 'claim' }, [], WAIT, [], NOW, CFG);
  assert.equal(claim.status, 'booked');
  assert.equal(claim.ops[0].method, 'POST');
  assert.match(claim.ops[0].body.description, /Source: waitlist W-1/);
  const second = n.handleLink({ t: mk('W-2'), a: 'claim' }, [{ id: 'new', status: 'confirmed', start: { dateTime: s.toISOString() }, end: { dateTime: e.toISOString() } }], WAIT, [], NOW, CFG);
  assert.equal(second.status, 'taken');
  assert.equal(n.handleLink({ t: mk('W-1'), a: 'claim' }, [], WAIT, [], new Date(NOW.getTime() + 2 * 3600000), CFG).status, 'invalid');
});

test('channel routing: SMS sends everything, WhatsApp sends reminder templates only', () => {
  const rem = n.dueReminders([ev('in20h', '2026-11-25T05:00:00Z')], [], NOW, { ...CFG, channel: 'sms' });
  assert.equal(rem.ops[0].op, 'sms');
  assert.equal(n.dueReminders([ev('in20h', '2026-11-25T05:00:00Z')], [], NOW, CFG).ops[0].op, 'whatsapp');
  const t = n.signToken({ k: 'appt', id: 'a1', exp: NOW.getTime() + 86400000 }, CFG.secret);
  const sms = n.handleLink({ t, a: 'cancel_yes' }, [ev('a1', '2026-11-25T08:00:00Z')], WAIT, [], NOW, { ...CFG, channel: 'sms' });
  assert.ok(sms.ops.some((o) => o.op === 'sms' && o.kind === 'waitlist_offer'));
  const wa = n.handleLink({ t, a: 'cancel_yes' }, [ev('a1', '2026-11-25T08:00:00Z')], WAIT, [], NOW, CFG);
  assert.ok(wa.ops.filter((o) => o.kind === 'waitlist_offer').every((o) => o.op === 'outbox' && /template/.test(o.note)));
});

test('outbox channel and seed data', () => {
  const r = n.dueReminders([ev('in20h', '2026-11-25T05:00:00Z')], [], NOW, { ...CFG, channel: 'outbox' });
  assert.equal(r.ops[0].op, 'outbox');
  const seed = n.seedOps(NOW, CFG, '0701 563 9553');
  assert.equal(seed.ops.length, 3);
  assert.match(seed.ops[0].body.description, /Phone: \+2347015639553/);
  const ahead = seed.ops.map((o) => (new Date(o.body.start.dateTime) - NOW) / 3600000);
  assert.ok(ahead[0] >= 1.5 && ahead[0] < 2 && ahead[1] >= 20 && ahead[1] <= 20.5 && ahead[2] > 24);
  const dueNow = n.dueReminders(seed.ops.map((o, i) => ({ id: 's' + i, status: 'confirmed', ...o.body })), [], NOW, CFG);
  assert.deepEqual(dueNow.ops.map((o) => o.kind), ['reminder_2h', 'reminder_24h']);
});
