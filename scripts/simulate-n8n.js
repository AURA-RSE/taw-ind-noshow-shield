// Runs the generated n8n Code nodes outside n8n with stubbed $ / $input, to prove the exported
// workflows work end to end: seed -> reminders -> patient link (reschedule, cancel, claim).
// Usage: node scripts/simulate-n8n.js   (builds with test values into a temp folder first)
const { execFileSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noshow-'));
execFileSync('node', [path.join(__dirname, 'build-workflows.js'), dir], { env: { ...process.env, CALENDAR_ID: 'cal@group.calendar.google.com', BASE_URL: 'https://demo.example', LINK_SECRET: 'sim-secret-1234567890', TEST_PHONE: '+15550100101', CHANNEL: 'whatsapp' } });
const load = (f) => JSON.parse(fs.readFileSync(path.join(dir, f)));
const js = (wf, name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;
const run = (src, ctx) => new Function('$', '$input', '$json', 'console', src)(ctx.$, ctx.$input, ctx.$json, { log() {} });
const items = (arr) => ({ first: () => ({ json: arr[0] }), all: () => arr.map((j) => ({ json: j })), item: { json: arr[0] } });
const assert = require('assert');

// Fake Google Calendar + Sheets state
let cal = []; const sheets = { Outbox: [], Waitlist: [], Activity: [] }; let idn = 0;
function applyCalendar(op) {
  const id = decodeURIComponent((op.path.split('/events/')[1] || ''));
  if (op.method === 'POST') cal.push({ id: 'ev' + (++idn), status: 'confirmed', ...op.body });
  if (op.method === 'PATCH') Object.assign(cal.find((e) => e.id === id), op.body);
  if (op.method === 'DELETE') cal = cal.filter((e) => e.id !== id);
}

// 1. Seed
const seed = load('seed-demo.json');
const bad = run(js(seed, 'Plan demo data'), { $: (n) => items([{ query: { key: 'nope' } }]) });
assert.equal(bad[0].json.ok, false);
const planned = run(js(seed, 'Plan demo data'), { $: () => items([{ query: { key: 'sim-secret-1' } }]) })[0].json;
for (const op of planned.ops) op.op === 'calendar' ? applyCalendar(op) : sheets.Waitlist.push(op.row);
console.log('seeded:', planned.appointments.length, 'appointments,', planned.waitlist.length, 'waitlist');

// 2. Reminders
const rem = load('reminders.json');
const plan = (outbox) => run(js(rem, 'Plan reminders'), { $: (n) => n.startsWith('List') ? items([{ items: cal }]) : items(outbox) }).map((i) => i.json);
const due = plan([{}]); // empty sheet -> alwaysOutputData gives one empty item
console.log('reminders due:', due.map((d) => `${d.kind} -> ${d.op}`).join(', '));
assert.deepEqual(due.map((d) => d.kind), ['reminder_2h', 'reminder_24h']);
for (const d of due) {
  const twilioRes = d.op === 'whatsapp' ? { sid: 'SM' + d.kind, status: 'queued' } : {};
  sheets.Outbox.push(run(js(rem, 'Record message'), { $: () => items([d]), $json: twilioRes }).json);
}
assert.equal(plan(sheets.Outbox).length, 0, 'no duplicate reminders on the next run');
const failed = run(js(rem, 'Record message'), { $: () => items([due[0]]), $json: { error: { message: '63016 outside window' } } }).json;
assert.equal(failed.status, 'failed');
console.log('outbox rows:', sheets.Outbox.map((r) => `${r.kind}:${r.status}:${r.to}`).join(', '));

// 3. Patient link: open reminder link -> reschedule -> move; then cancel another -> waitlist claim
const lw = load('patient-links.json');
const handle = (query) => run(js(lw, 'Handle link'), { $: (n) => n === 'Patient link' ? items([{ query }]) : n.startsWith('List') ? items([{ items: cal }]) : items(n === 'Read Waitlist' ? sheets.Waitlist : sheets.Activity.length ? sheets.Activity : [{}]) })[0].json;
const execOps = (ops) => { for (const o of ops) { if (o.op === 'calendar') applyCalendar(o); else if (o.op === 'activity') sheets.Activity.push(o.row); else sheets.Outbox.push(run(js(lw, 'Record message'), { $: () => items([o]), $json: {} }).json); } };
const qs = (u) => Object.fromEntries(new URL(u.replace(/&amp;/g, '&')).searchParams);
const reminderLink = sheets.Outbox.find((r) => r.kind === 'reminder_24h').link;
let r = handle(qs(reminderLink)); assert.equal(r.status, 'ok'); execOps(r.ops);
r = handle({ ...qs(reminderLink), a: 'reschedule' }); assert.equal(r.status, 'choose');
const moveUrl = r.html.match(/href="([^"]*a=move[^"]*)"/)[1];
r = handle(qs(moveUrl)); assert.equal(r.status, 'moved'); execOps(r.ops);
console.log('moved -> ops:', r.ops.map((o) => o.op + (o.row ? ':' + o.row.action : o.kind ? ':' + o.kind : '')).join(', '));
const offer = sheets.Outbox.filter((o) => o.kind === 'waitlist_offer');
assert.ok(offer.length >= 1 && offer.every((o) => o.channel === 'outbox'));
r = handle(qs(offer[0].link)); assert.equal(r.status, 'offer');
r = handle({ ...qs(offer[0].link), a: 'claim' }); assert.equal(r.status, 'booked'); execOps(r.ops);
if (offer[1]) { r = handle({ ...qs(offer[1].link), a: 'claim' }); assert.equal(r.status, 'taken'); }
const twoH = sheets.Outbox.find((x) => x.kind === 'reminder_2h').link;
r = handle({ ...qs(twoH), a: 'cancel_yes' }); assert.equal(r.status, 'cancelled'); execOps(r.ops);
r = handle(qs(twoH)); assert.equal(r.status, 'gone');
const calErr = run(js(lw, 'Calendar errors to Activity'), { $input: { all: () => [{ json: { id: 'ok' } }, { json: { error: { message: '404 Not Found' } } }] } });
assert.equal(calErr.length, 1);
const calDown = run(js(lw, 'Handle link'), { $: (n) => n === 'Patient link' ? items([{ query: qs(reminderLink) }]) : n.startsWith('List') ? items([{ error: { message: 'timeout' } }]) : items([{}]) })[0].json;
assert.equal(calDown.status, 'calendar_error');
console.log('activity:', sheets.Activity.map((a) => a.action).join(', '));
console.log('calendar now:', cal.map((e) => e.summary).join(' | '));
console.log('\nALL SIMULATIONS PASSED');
