// Builds the three n8n workflows from src/noshow.js, so n8n runs exactly the tested code.
// Committed exports keep placeholders. To bake in real values for a local import:
//   CALENDAR_ID=... SHEET_ID=... BASE_URL=... LINK_SECRET=... CHANNEL=whatsapp TWILIO_ACCOUNT_SID=... \
//   TWILIO_FROM=+1... CONTENT_SID=HX... TEST_PHONE=+234... node scripts/build-workflows.js [outDir]
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = process.argv[2] || path.join(root, 'workflows');
const lib = fs.readFileSync(path.join(root, 'src', 'noshow.js'), 'utf8').replace(/\/\/ --- n8n:strip-start[\s\S]*?\/\/ --- n8n:strip-end\n?/, '').trim();
const E = process.env;
const V = {
  calendarId: E.CALENDAR_ID || 'YOUR_CALENDAR_ID@group.calendar.google.com',
  sheetId: E.SHEET_ID || 'YOUR_GOOGLE_SHEET_ID',
  baseUrl: E.BASE_URL || 'https://YOUR-N8N-PUBLIC-URL',
  secret: E.LINK_SECRET || 'CHANGE_ME_LONG_RANDOM_SECRET',
  channel: E.CHANNEL || 'whatsapp',
  twilioSid: E.TWILIO_ACCOUNT_SID || 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  twilioFrom: E.TWILIO_FROM || '+15550100100',
  contentSid: E.CONTENT_SID || 'HXb5b62575e6e4ff6129ad7c8efe1f983e',
  testPhone: E.TEST_PHONE || '+15550100101',
};
const q = (s) => JSON.stringify(s);
const CONFIG = `const CONFIG = {
  clinicName: 'Harbourview Family Clinic',
  timezone: 'Africa/Lagos',
  calendarId: ${q(V.calendarId)},
  baseUrl: ${q(V.baseUrl)},
  secret: ${q(V.secret)},
  channel: ${q(V.channel)}, // 'whatsapp' | 'sms' | 'outbox'
};
const TEST_PHONE = ${q(V.testPhone)}; // demo data sends only to this opted-in test number`;
const code = (body) => `// ===== Settings (edit here) =====\n${CONFIG}\n\n// ===== NoShow Shield library (generated from src/noshow.js, do not edit here) =====\n${lib}\n\n// ===== This node =====\n${body}`;

const googleCred = { googleApi: { id: 'clinicTriageGsa1', name: 'Google Service Account account' } };
const twilioCred = { httpBasicAuth: { id: 'noshowTwilio01', name: 'Twilio (NoShow Shield)' } };
const retry = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };
const CAL = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(V.calendarId)}/events`;

let n = 0;
const id = () => `node-${++n}`;
const sheetRead = (name, tab, pos) => ({ id: id(), name, type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, position: pos, alwaysOutputData: true, onError: 'continueRegularOutput', ...retry, parameters: { authentication: 'serviceAccount', operation: 'read', documentId: { __rl: true, mode: 'id', value: V.sheetId }, sheetName: { __rl: true, mode: 'name', value: tab }, options: {} }, credentials: googleCred });
const sheetAppend = (name, tab, pos) => ({ id: id(), name, type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, position: pos, onError: 'continueRegularOutput', ...retry, parameters: { authentication: 'serviceAccount', operation: 'append', documentId: { __rl: true, mode: 'id', value: V.sheetId }, sheetName: { __rl: true, mode: 'name', value: tab }, columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] }, options: { useAppend: true } }, credentials: googleCred });
const listEvents = (name, fromExpr, toExpr, pos, onError = 'continueRegularOutput') => ({
  id: id(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, onError, ...retry,
  parameters: { method: 'GET', url: `={{ '${CAL}?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=' + encodeURIComponent(${fromExpr}) + '&timeMax=' + encodeURIComponent(${toExpr}) }}`, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi', options: {} },
  credentials: googleCred,
});
const codeNode = (name, body, pos, mode = 'runOnceForAllItems') => ({ id: id(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, parameters: { mode, jsCode: code(body) } });
const plainCode = (name, js, pos, mode = 'runOnceForAllItems') => ({ id: id(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, parameters: { mode, jsCode: js } });
const rule = (key, value) => ({ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: id(), leftValue: `={{ $json.${key} }}`, rightValue: value, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: value });
const sw = (name, key, values, pos) => ({ id: id(), name, type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: pos, parameters: { rules: { values: values.map((v) => rule(key, v)) }, options: {} } });
const twilio = (name, params, pos) => ({
  id: id(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, onError: 'continueRegularOutput', ...retry,
  parameters: { method: 'POST', url: `https://api.twilio.com/2010-04-01/Accounts/${V.twilioSid}/Messages.json`, authentication: 'genericCredentialType', genericAuthType: 'httpBasicAuth', sendBody: true, contentType: 'form-urlencoded', bodyParameters: { parameters: params }, options: {} },
  credentials: twilioCred,
});

// Message pipeline shared by the reminder and link workflows: route -> send -> record -> Outbox.
function messagePipeline(sourceNode, x, y) {
  const route = sw('Route message', 'op', ['sms', 'whatsapp', 'outbox'], [x, y]);
  const sms = twilio('Send SMS', [{ name: 'To', value: '={{ $json.to }}' }, { name: 'From', value: V.twilioFrom }, { name: 'Body', value: '={{ $json.body }}' }], [x + 240, y - 120]);
  const wa = twilio('Send WhatsApp template', [{ name: 'To', value: "={{ 'whatsapp:' + $json.to }}" }, { name: 'From', value: `whatsapp:${V.twilioFrom}` }, { name: 'ContentSid', value: V.contentSid }, { name: 'ContentVariables', value: '={{ JSON.stringify($json.vars) }}' }], [x + 240, y]);
  const record = plainCode('Record message', `// Builds the Outbox row from the planned message + Twilio's answer (or error).
const op = $('${sourceNode}').item.json;
const res = $json || {};
const err = res.error ? (res.error.message || JSON.stringify(res.error)) : (res.code && res.message ? res.code + ' ' + res.message : '');
const status = op.op === 'outbox' ? 'logged' : (res.sid && !err ? 'sent' : 'failed');
const masked = String(op.to || '').replace(/\\d(?=\\d{4})/g, '•');
return { json: { at: new Date().toISOString(), kind: op.kind, appointment_id: op.appointment_id || '', waitlist_id: op.waitlist_id || '', patient: op.patient || '', to: masked, channel: op.op, status, twilio_sid: res.sid || '', error: err.slice(0, 200), note: op.note || '', message: op.body, link: op.link || '' } };`, [x + 480, y], 'runOnceForEachItem');
  const outbox = sheetAppend('Append to Outbox', 'Outbox', [x + 720, y]);
  return {
    nodes: [route, sms, wa, record, outbox],
    entry: route.name,
    conns: {
      [route.name]: { main: [[{ node: sms.name, type: 'main', index: 0 }], [{ node: wa.name, type: 'main', index: 0 }], [{ node: record.name, type: 'main', index: 0 }]] },
      [sms.name]: { main: [[{ node: record.name, type: 'main', index: 0 }]] },
      [wa.name]: { main: [[{ node: record.name, type: 'main', index: 0 }]] },
      [record.name]: { main: [[{ node: outbox.name, type: 'main', index: 0 }]] },
    },
  };
}
const link = (to) => [[{ node: to, type: 'main', index: 0 }]];
const wf = (name, wid, nodes, connections) => ({ id: wid, name, nodes, connections, settings: { executionOrder: 'v1', saveManualExecutions: true, timezone: 'Africa/Lagos' }, active: false, tags: [] });

// ---------- 1. Reminders ----------
n = 0;
const r = {
  sched: { id: id(), name: 'Every 15 minutes', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 200], parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } } },
  manual: { id: id(), name: 'Run now (manual)', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 360], parameters: {} },
  hook: { id: id(), name: 'Run now (link)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 520], webhookId: 'noshow-run', parameters: { httpMethod: 'GET', path: 'noshow-run', responseMode: 'onReceived', options: {} } },
  gate: plainCode('Check run key', `const key = ($input.first().json.query || {}).key;
return key === ${q(V.secret.slice(0, 12))} ? [{ json: {} }] : [];`, [120, 520]),
  list: listEvents('List next 26h of appointments', 'new Date().toISOString()', 'new Date(Date.now() + 26 * 3600000).toISOString()', [240, 280], 'stopWorkflow'),
  outbox: sheetRead('Read Outbox (sent log)', 'Outbox', [480, 280]),
  plan: codeNode('Plan reminders', `const events = ($('List next 26h of appointments').first().json.items) || [];
const sent = $('Read Outbox (sent log)').all().map((i) => i.json);
const { ops, skipped } = dueReminders(events, sent, new Date(), CONFIG);
if (skipped.length) console.log('skipped', JSON.stringify(skipped));
return ops.map((o) => ({ json: o }));`, [720, 280]),
};
let pipe = messagePipeline('Plan reminders', 960, 280);
const reminders = wf('NoShow Shield – Reminders', 'noshowReminders01', [...Object.values(r), ...pipe.nodes], {
  [r.sched.name]: { main: link(r.list.name) }, [r.manual.name]: { main: link(r.list.name) },
  [r.hook.name]: { main: link(r.gate.name) }, [r.gate.name]: { main: link(r.list.name) },
  [r.list.name]: { main: link(r.outbox.name) }, [r.outbox.name]: { main: link(r.plan.name) },
  [r.plan.name]: { main: link(pipe.entry) }, ...pipe.conns,
});

// ---------- 2. Patient links (one-tap confirm / reschedule / cancel, waitlist claim) ----------
n = 0;
const htmlHeaders = { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }] } };
const l = {
  hook: { id: id(), name: 'Patient link', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 300], webhookId: 'noshow-patient-link', parameters: { httpMethod: 'GET', path: 'noshow', responseMode: 'responseNode', options: {} } },
  list: listEvents('List calendar (next 8 days)', 'new Date(Date.now() - 3600000).toISOString()', 'new Date(Date.now() + 8 * 86400000).toISOString()', [220, 300]),
  wait: sheetRead('Read Waitlist', 'Waitlist', [440, 300]),
  act: sheetRead('Read Activity', 'Activity', [660, 300]),
  handle: codeNode('Handle link', `const query = $('Patient link').first().json.query || {};
const cal = $('List calendar (next 8 days)').first().json;
const rows = (name) => $(name).all().map((i) => i.json).filter((r) => r && Object.keys(r).length);
if (!cal || !Array.isArray(cal.items)) {
  return [{ json: { status: 'calendar_error', ops: [], html: '<!DOCTYPE html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:32px"><h1>Please try again</h1><p>We could not load your appointment just now. Please try again in a minute or call the clinic.</p></body>' } }];
}
const out = handleLink(query, cal.items, rows('Read Waitlist'), rows('Read Activity'), new Date(), CONFIG);
return [{ json: out }];`, [880, 300]),
  respond: { id: id(), name: 'Show page', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [1100, 300], parameters: { respondWith: 'text', responseBody: '={{ $json.html }}', options: htmlHeaders } },
  split: plainCode('Split actions', 'return ($json.ops || []).map((o) => ({ json: o }));', [1320, 300], 'runOnceForEachItem'),
  route: sw('Route action', 'op', ['calendar', 'activity', 'sms', 'whatsapp', 'outbox'], [1540, 300]),
  calendar: {
    id: id(), name: 'Change calendar', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1780, 100], onError: 'continueRegularOutput', ...retry,
    parameters: { method: '={{ $json.method }}', url: "={{ 'https://www.googleapis.com/calendar/v3' + $json.path }}", authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi', sendBody: '={{ !!$json.body }}', specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body || {}) }}', options: {} },
    credentials: googleCred,
  },
  calCheck: plainCode('Calendar errors to Activity', `// Only failures are logged; successes are already recorded by the planned activity row.
return $input.all().filter((it) => it.json && it.json.error).map((it) => ({ json: { at: new Date().toISOString(), action: 'calendar_error', appointment_id: '', waitlist_id: '', slot_start: '', detail: String(it.json.error.message || JSON.stringify(it.json.error)).slice(0, 300) } }));`, [2000, 100]),
  actRow: plainCode('Activity row', 'return { json: $json.row };', [1780, 260], 'runOnceForEachItem'),
  actAppend: sheetAppend('Append to Activity', 'Activity', [2220, 200]),
};
// messages from the link workflow reuse the pipeline, fed by the same router
pipe = messagePipeline('Split actions', 1780, 520);
const pipeRoute = pipe.nodes[0];
const pipeNodes = pipe.nodes.slice(1); // the link router already splits by op
const linkConns = {
  [l.hook.name]: { main: link(l.list.name) }, [l.list.name]: { main: link(l.wait.name) }, [l.wait.name]: { main: link(l.act.name) },
  [l.act.name]: { main: link(l.handle.name) }, [l.handle.name]: { main: link(l.respond.name) }, [l.respond.name]: { main: link(l.split.name) },
  [l.split.name]: { main: link(l.route.name) },
  [l.route.name]: { main: [[{ node: l.calendar.name, type: 'main', index: 0 }], [{ node: l.actRow.name, type: 'main', index: 0 }], [{ node: 'Send SMS', type: 'main', index: 0 }], [{ node: 'Send WhatsApp template', type: 'main', index: 0 }], [{ node: 'Record message', type: 'main', index: 0 }]] },
  [l.calendar.name]: { main: link(l.calCheck.name) }, [l.calCheck.name]: { main: link(l.actAppend.name) }, [l.actRow.name]: { main: link(l.actAppend.name) },
};
for (const [k, v] of Object.entries(pipe.conns)) if (k !== pipeRoute.name) linkConns[k] = v;
const links = wf('NoShow Shield – Patient links', 'noshowLinks01', [...Object.values(l), ...pipeNodes], linkConns);

// ---------- 3. Seed demo data ----------
n = 0;
const s = {
  hook: { id: id(), name: 'Seed demo data', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 300], webhookId: 'noshow-seed', parameters: { httpMethod: 'GET', path: 'noshow-seed', responseMode: 'responseNode', options: {} } },
  plan: codeNode('Plan demo data', `const key = ($('Seed demo data').first().json.query || {}).key;
if (key !== CONFIG.secret.slice(0, 12)) return [{ json: { ok: false, error: 'wrong key', ops: [] } }];
const seed = seedOps(new Date(), CONFIG, TEST_PHONE);
const ops = [...seed.ops, ...seed.waitlist.map((w) => ({ op: 'waitlist', row: w }))];
return [{ json: { ok: true, appointments: seed.ops.map((o) => o.body.summary + ' @ ' + o.body.start.dateTime), waitlist: seed.waitlist.map((w) => w.waitlist_id + ' ' + w.patient + ' (' + w.preference + ')'), ops } }];`, [220, 300]),
  respond: { id: id(), name: 'Reply', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [440, 300], parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify({ ok: $json.ok, error: $json.error, appointments: $json.appointments, waitlist: $json.waitlist }) }}', options: {} } },
  split: plainCode('Split', 'return ($json.ops || []).map((o) => ({ json: o }));', [660, 300], 'runOnceForEachItem'),
  route: sw('Route', 'op', ['calendar', 'waitlist'], [880, 300]),
  cal: {
    id: id(), name: 'Create appointment', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1100, 200], onError: 'continueRegularOutput', ...retry,
    parameters: { method: 'POST', url: "={{ 'https://www.googleapis.com/calendar/v3' + $json.path }}", authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi', sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}', options: {} },
    credentials: googleCred,
  },
  row: plainCode('Waitlist row', 'return { json: $json.row };', [1100, 400], 'runOnceForEachItem'),
  append: sheetAppend('Append to Waitlist', 'Waitlist', [1320, 400]),
};
const seed = wf('NoShow Shield – Seed demo data', 'noshowSeed01', Object.values(s), {
  [s.hook.name]: { main: link(s.plan.name) }, [s.plan.name]: { main: link(s.respond.name) }, [s.respond.name]: { main: link(s.split.name) },
  [s.split.name]: { main: link(s.route.name) }, [s.route.name]: { main: [[{ node: s.cal.name, type: 'main', index: 0 }], [{ node: s.row.name, type: 'main', index: 0 }]] },
  [s.row.name]: { main: link(s.append.name) },
});

fs.mkdirSync(outDir, { recursive: true });
for (const [file, w] of [['reminders.json', reminders], ['patient-links.json', links], ['seed-demo.json', seed]]) {
  fs.writeFileSync(path.join(outDir, file), JSON.stringify(w, null, 2) + '\n');
}
console.log('Wrote', ['reminders.json', 'patient-links.json', 'seed-demo.json'].map((f) => path.join(path.relative(root, outDir) || '.', f)).join(', '));
