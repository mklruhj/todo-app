'use strict';
/* ---------- Constants ---------- */
const CATS = {
  Work: '#4f46e5', Study: '#0ea5e9', Health: '#10b981', Personal: '#f59e0b', Finance: '#8b5cf6', Other: '#64748b'
};
const DAYN = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ---------- Server API ---------- */
let db = { tasks: [], log: {} };
let user = null;

async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth')) { showAuth('login'); throw new Error('Your session expired. Please sign in again.'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
// Runs a server call; on failure shows the error and reloads data from the server so the UI never drifts.
async function sync(promise, okMsg) {
  try { const r = await promise; if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message); await refresh(); throw e; }
}
async function refresh() {
  try { db = await api('GET', '/api/data'); render(); } catch (_) {}
}

/* ---------- Dates ---------- */
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
const todayStr = () => fmt(new Date());
const longDate = s => { const d = parse(s); return `${WD[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`; };
const weekStart = s => { const d = parse(s); const off = (d.getDay() + 6) % 7; return addDays(s, -off); }; // Monday
const range = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Domain ---------- */
function occurs(t, ds) {
  if (ds < t.start) return false;
  if (t.end && ds > t.end) return false;
  if (t.repeat === 'once') return ds === t.start;
  return t.days.includes(parse(ds).getDay());
}
const tasksOn = ds => db.tasks.filter(t => occurs(t, ds));
const statusOf = (ds, id) => (db.log[ds] && db.log[ds][id]) || 'pending';
// Applies status changes locally (instant UI) and persists them in one request.
// Clicking the status a task already has toggles it back to pending.
function setStatuses(ds, changes) {
  const entries = changes.map(([id, st]) => {
    db.log[ds] = db.log[ds] || {};
    const next = st === 'pending' || db.log[ds][id] === st ? 'pending' : st;
    if (next === 'pending') delete db.log[ds][id]; else db.log[ds][id] = next;
    if (!Object.keys(db.log[ds]).length) delete db.log[ds];
    return { taskId: id, status: next };
  });
  if (entries.length) sync(api('PUT', '/api/log', { date: ds, entries })).catch(() => {});
}
const setStatus = (ds, id, st) => setStatuses(ds, [[id, st]]);
function dayStats(ds) {
  const t = tasksOn(ds); let done = 0, missed = 0, pending = 0;
  t.forEach(x => { const s = statusOf(ds, x.id); s === 'done' ? done++ : s === 'missed' ? missed++ : pending++; });
  return { total: t.length, done, missed, pending };
}
function agg(dates) {
  const today = todayStr(); const r = { total: 0, done: 0, missed: 0, pending: 0, days: 0, perfect: 0 };
  dates.forEach(ds => {
    if (ds > today) return;
    const s = dayStats(ds); if (!s.total) return;
    r.days++; r.total += s.total; r.done += s.done; r.missed += s.missed; r.pending += s.pending;
    if (s.done === s.total) r.perfect++;
  });
  // rate: today's unmarked tasks are not held against you yet
  const denom = r.total - (dates.includes(today) ? dayStats(today).pending : 0);
  r.rate = denom > 0 ? Math.round(r.done / denom * 100) : 0;
  r.denom = denom;
  return r;
}
function streaks() {
  const today = todayStr();
  const starts = db.tasks.map(t => t.start).sort();
  if (!starts.length) return { cur: 0, best: 0 };
  let cur = 0, best = 0, run = 0;
  range(starts[0], today).forEach(ds => {
    const s = dayStats(ds); if (!s.total) return;
    if (s.done === s.total) { run++; best = Math.max(best, run); }
    else if (ds === today && s.pending) { /* today still being reviewed — don't break the streak yet */ }
    else run = 0;
  });
  cur = run;
  return { cur, best };
}
const level = (s) => !s.total ? 0 : (r => r >= 100 ? 4 : r >= 70 ? 3 : r >= 40 ? 2 : 1)(Math.round(s.done / s.total * 100));

/* ---------- State ---------- */
const state = { view: 'today', date: todayStr(), period: 'week', anchor: todayStr(), histMonth: todayStr().slice(0, 7) };
const $ = s => document.querySelector(s);

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 2200); }
/* ---------- Render ---------- */
function render() {
  if (!user) return;
  document.documentElement.dataset.theme = user.theme || 'light';
  $('#userName').textContent = user.name;
  $('#userEmail').textContent = user.email;
  $('#userAvatar').textContent = user.name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  $('#sideStreak').textContent = streaks().cur;
  const v = { today: viewToday, tasks: viewTasks, analytics: viewAnalytics, history: viewHistory, settings: viewSettings }[state.view];
  $('#view').innerHTML = v();
}

function ring(pct, color = 'var(--done)') {
  const r = 52, c = 2 * Math.PI * r;
  return `<div class="ring"><svg viewBox="0 0 120 120" width="120" height="120"><circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--border)" stroke-width="11"/>
  <circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="11" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}" transform="rotate(-90 60 60)" style="transition:stroke-dashoffset .5s"/></svg><div class="pct">${pct}%</div></div>`;
}
const statBox = (l, v, h, cls = '') => `<div class="card stat"><div class="lbl">${l}</div><div class="val ${cls}">${v}</div><div class="hint">${h}</div></div>`;

/* Today */
function viewToday() {
  const ds = state.date, today = todayStr(), isToday = ds === today, future = ds > today;
  const list = tasksOn(ds).sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority]));
  const s = dayStats(ds);
  const pct = s.total ? Math.round(s.done / s.total * 100) : 0;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const msg = !s.total ? 'No tasks planned for this day.' : s.pending === 0 ? (s.done === s.total ? 'Perfect day — everything completed! 🎉' : 'Day reviewed. Tomorrow is a fresh start.') : `${s.pending} task${s.pending > 1 ? 's' : ''} waiting for your review.`;
  return `
  <div class="page-head">
    <div><h1>${isToday ? greet + '!' : 'Daily Plan'}</h1><div class="sub">${longDate(ds)}${isToday ? ' · Today' : ''}</div></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <div class="datenav">
        <button class="icon-btn" data-act="day" data-n="-1" title="Previous day">‹</button>
        <div class="cur">${isToday ? 'Today' : longDate(ds)}</div>
        <button class="icon-btn" data-act="day" data-n="1" title="Next day">›</button>
        ${isToday ? '' : '<button class="btn sm" data-act="goToday">Today</button>'}
      </div>
      <button class="btn primary" data-act="addTask">＋ Add Task</button>
    </div>
  </div>
  <div class="card hero">
    ${ring(pct)}
    <div class="hero-info">
      <div class="big">${msg}</div>
      <div class="sub">${s.done} of ${s.total} completed</div>
      <div class="pills"><span class="pill done">✓ ${s.done} Done</span><span class="pill miss">✕ ${s.missed} Not completed</span><span class="pill pend">○ ${s.pending} Pending</span></div>
    </div>
  </div>
  ${s.pending && !future ? `<div class="review-bar"><div><b>🌙 Night review</b><div style="opacity:.85;font-size:13px">Tick what you finished. Anything left can be marked as not completed in one click.</div></div>
    <div style="display:flex;gap:8px"><button class="btn sm" data-act="allDone">Mark all done</button><button class="btn sm" data-act="restMissed">Mark rest as not completed</button></div></div>` : ''}
  ${list.length ? list.map(t => taskRow(t, ds, future)).join('') : `<div class="card empty"><div class="em">📝</div><b>Nothing planned</b><div>Add a task to get started.</div></div>`}`;
}
function taskRow(t, ds, future) {
  const st = statusOf(ds, t.id), c = CATS[t.category] || CATS.Other;
  return `<div class="task s-${st}" style="--c:${c}">
    <div class="t-main"><div class="t-title">${esc(t.title)}</div>
      <div class="t-meta"><span class="tag">${esc(t.category)}</span><span class="prio-${t.priority}">● ${t.priority}</span>${t.repeat !== 'once' ? '<span>↻ ' + repeatLabel(t) + '</span>' : ''}${t.notes ? '<span>· ' + esc(t.notes) + '</span>' : ''}</div></div>
    <div class="actions">
      <button class="act yes ${st === 'done' ? 'on' : ''}" data-act="set" data-id="${t.id}" data-st="done" ${future ? 'disabled style="opacity:.5"' : ''}>✓ Done</button>
      <button class="act no ${st === 'missed' ? 'on' : ''}" data-act="set" data-id="${t.id}" data-st="missed" ${future ? 'disabled style="opacity:.5"' : ''}>✕ Not done</button>
    </div></div>`;
}
function repeatLabel(t) {
  if (t.repeat === 'once') return 'One-time';
  if (t.days.length === 7) return 'Every day';
  if (t.days.length === 5 && ![0, 6].some(d => t.days.includes(d))) return 'Weekdays';
  return t.days.map(d => WD[d]).join(', ');
}

/* Tasks */
function viewTasks() {
  const today = todayStr();
  const active = db.tasks.filter(t => !t.end || t.end >= today).filter(t => t.repeat !== 'once' || t.start >= today);
  const rec = active.filter(t => t.repeat !== 'once'), once = active.filter(t => t.repeat === 'once').sort((a, b) => a.start.localeCompare(b.start));
  const row = t => `<tr><td><b>${esc(t.title)}</b>${t.notes ? `<div class="sub">${esc(t.notes)}</div>` : ''}</td>
    <td><span class="tag" style="--c:${CATS[t.category] || CATS.Other}">${esc(t.category)}</span></td>
    <td class="prio-${t.priority}">${t.priority}</td>
    <td>${t.repeat === 'once' ? longDate(t.start) : DAYN.map((d, i) => `<span class="dayc ${t.days.includes(i) ? 'on' : ''}">${d}</span>`).join('')}</td>
    <td style="text-align:right;white-space:nowrap"><button class="btn sm" data-act="editTask" data-id="${t.id}">Edit</button> <button class="btn sm danger" data-act="delTask" data-id="${t.id}">${t.repeat === 'once' ? 'Delete' : 'Stop'}</button></td></tr>`;
  const head = '<thead><tr><th>Task</th><th>Category</th><th>Priority</th><th>Schedule</th><th></th></tr></thead>';
  return `<div class="page-head"><div><h1>My Tasks</h1><div class="sub">Plan recurring habits and one-off tasks</div></div><button class="btn primary" data-act="addTask">＋ Add Task</button></div>
  <div class="card" style="margin-bottom:18px"><h2>Recurring tasks</h2>${rec.length ? `<div style="overflow-x:auto"><table class="table">${head}<tbody>${rec.map(row).join('')}</tbody></table></div>` : '<div class="empty">No recurring tasks yet.</div>'}</div>
  <div class="card"><h2>Upcoming one-time tasks</h2>${once.length ? `<div style="overflow-x:auto"><table class="table">${head}<tbody>${once.map(row).join('')}</tbody></table></div>` : '<div class="empty">No upcoming one-time tasks.</div>'}</div>
  <p class="sub" style="margin-top:12px">Stopping a recurring task keeps all of its past history in your reports.</p>`;
}

/* Analytics */
function periodInfo() {
  const a = state.anchor, p = state.period;
  if (p === 'week') { const s = weekStart(a); const e = addDays(s, 6); return { start: s, end: e, label: `${parse(s).getDate()} ${MONTHS[parse(s).getMonth()].slice(0, 3)} – ${parse(e).getDate()} ${MONTHS[parse(e).getMonth()].slice(0, 3)} ${parse(e).getFullYear()}` }; }
  if (p === 'month') { const d = parse(a); const s = fmt(new Date(d.getFullYear(), d.getMonth(), 1)); const e = fmt(new Date(d.getFullYear(), d.getMonth() + 1, 0)); return { start: s, end: e, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` }; }
  const y = parse(a).getFullYear(); return { start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
}
function shiftAnchor(n) {
  const d = parse(state.anchor);
  if (state.period === 'week') d.setDate(d.getDate() + 7 * n);
  else if (state.period === 'month') { d.setDate(1); d.setMonth(d.getMonth() + n); }
  else d.setFullYear(d.getFullYear() + n);
  state.anchor = fmt(d);
}
function viewAnalytics() {
  const pi = periodInfo(), dates = range(pi.start, pi.end), a = agg(dates), st = streaks();
  // chart buckets
  let buckets;
  if (state.period === 'year') {
    buckets = MONTHS.map((m, i) => { const y = parse(pi.start).getFullYear(); const ds = range(fmt(new Date(y, i, 1)), fmt(new Date(y, i + 1, 0))); const r = agg(ds); return { label: m.slice(0, 3), done: r.done, missed: r.missed, pending: ds[0] > todayStr() ? 0 : r.pending, key: ds[0] }; });
  } else {
    buckets = dates.map(ds => { const s = dayStats(ds), f = ds > todayStr(); return { label: state.period === 'week' ? WD[parse(ds).getDay()] : String(parse(ds).getDate()), done: f ? 0 : s.done, missed: f ? 0 : s.missed, pending: f ? 0 : s.pending, key: ds }; });
  }
  // per task
  const perTask = db.tasks.map(t => {
    let sch = 0, dn = 0, ms = 0;
    dates.forEach(ds => { if (ds <= todayStr() && occurs(t, ds)) { sch++; const s = statusOf(ds, t.id); if (s === 'done') dn++; else if (s === 'missed') ms++; } });
    return { t, sch, dn, ms, rate: sch ? Math.round(dn / sch * 100) : 0 };
  }).filter(x => x.sch).sort((x, y) => y.rate - x.rate);
  // per category
  const cats = {}; perTask.forEach(x => { const c = x.t.category; cats[c] = cats[c] || { sch: 0, dn: 0 }; cats[c].sch += x.sch; cats[c].dn += x.dn; });
  return `
  <div class="page-head"><div><h1>Analytics</h1><div class="sub">Your consistency at a glance</div></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <div class="seg">${['week', 'month', 'year'].map(p => `<button class="${state.period === p ? 'on' : ''}" data-act="period" data-p="${p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}</div>
      <div class="datenav"><button class="icon-btn" data-act="shift" data-n="-1">‹</button><div class="cur">${pi.label}</div><button class="icon-btn" data-act="shift" data-n="1">›</button></div>
    </div></div>
  <div class="grid g4" style="margin-bottom:18px">
    ${statBox('Completion rate', a.rate + '%', `${a.done} of ${a.denom} tasks`, 'c-pri')}
    ${statBox('Completed', a.done, `${a.perfect} perfect day${a.perfect === 1 ? '' : 's'}`, 'c-done')}
    ${statBox('Not completed', a.missed + (a.pending - (dates.includes(todayStr()) ? dayStats(todayStr()).pending : 0)), 'missed or unmarked', 'c-miss')}
    ${statBox('Current streak', st.cur + ' 🔥', `Best: ${st.best} day${st.best === 1 ? '' : 's'}`)}
  </div>
  <div class="card" style="margin-bottom:18px"><h2>${state.period === 'year' ? 'Monthly' : 'Daily'} activity</h2>${chart(buckets)}
    <div class="legend"><span><i style="background:var(--done)"></i>Done</span><span><i style="background:var(--miss)"></i>Not completed</span><span><i style="background:var(--pend)"></i>Unmarked</span></div></div>
  <div class="card" style="margin-bottom:18px"><h2>Consistency map</h2>${heat(pi, dates)}</div>
  <div class="grid g2">
    <div class="card"><h2>Task performance</h2>${perTask.length ? `<table class="table"><thead><tr><th>Task</th><th>Done</th><th style="width:36%">Rate</th></tr></thead><tbody>${perTask.map(x => `<tr><td><b>${esc(x.t.title)}</b></td><td>${x.dn}/${x.sch}</td><td><div style="display:flex;gap:8px;align-items:center"><div class="bar" style="flex:1"><i style="width:${x.rate}%"></i></div><b>${x.rate}%</b></div></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No data for this period.</div>'}</div>
    <div class="card"><h2>By category</h2>${Object.keys(cats).length ? Object.entries(cats).map(([c, v]) => { const r = Math.round(v.dn / v.sch * 100); return `<div style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;margin-bottom:5px"><span class="tag" style="--c:${CATS[c] || CATS.Other}">${esc(c)}</span><b>${r}%</b></div><div class="bar"><i style="width:${r}%;background:${CATS[c] || CATS.Other}"></i></div></div>`; }).join('') : '<div class="empty">No data for this period.</div>'}</div>
  </div>`;
}
function chart(b) {
  const W = 900, H = 240, L = 32, B = 28, T = 10, n = b.length;
  const max = Math.max(1, ...b.map(x => x.done + x.missed + x.pending));
  const ph = H - B - T, bw = (W - L) / n, w = Math.min(34, bw * .62);
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Activity chart">`;
  const ticks = Math.min(max, 4);
  for (let i = 0; i <= ticks; i++) { const v = Math.round(max * i / ticks), y = T + ph - ph * v / max; svg += `<line x1="${L}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--border)"/><text x="${L - 8}" y="${y + 4}" text-anchor="end">${v}</text>`; }
  b.forEach((x, i) => {
    const cx = L + bw * i + bw / 2; let y = T + ph; const parts = [['done', 'var(--done)'], ['missed', 'var(--miss)'], ['pending', 'var(--pend)']];
    parts.forEach(([k, col]) => { if (x[k]) { const h = ph * x[k] / max; y -= h; svg += `<rect x="${cx - w / 2}" y="${y}" width="${w}" height="${h}" fill="${col}" rx="3"><title>${x.label}: ${x[k]} ${k}</title></rect>`; } });
    if (n <= 12 || i % 2 === 0) svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${x.label}</text>`;
  });
  return svg + '</svg>';
}
function heat(pi, dates) {
  const today = todayStr();
  if (state.period === 'year') {
    const first = parse(pi.start); const pads = (first.getDay() + 6) % 7; const cells = Array(pads).fill(null).concat(dates);
    while (cells.length % 7) cells.push(null);
    let out = '<div class="year-heat">';
    for (let c = 0; c < cells.length; c += 7) out += '<div class="col">' + cells.slice(c, c + 7).map(ds => ds ? `<div class="sq l${ds > today ? 0 : level(dayStats(ds))}" title="${longDate(ds)}"></div>` : '<div class="sq none"></div>').join('') + '</div>';
    return out + '</div>';
  }
  const pads = (parse(pi.start).getDay() + 6) % 7;
  let out = '<div class="cal">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="dow">${d}</div>`).join('');
  if (state.period === 'month') out += Array(pads).fill('<div class="cell blank"></div>').join('');
  dates.forEach(ds => { const s = dayStats(ds), f = ds > today; out += `<button class="cell l${f ? 0 : level(s)} ${ds === today ? 'today' : ''}" data-act="openDay" data-date="${ds}"><span>${parse(ds).getDate()}</span><small>${s.total ? `${s.done}/${s.total}` : '–'}</small></button>`; });
  return out + '</div>';
}

/* History */
function viewHistory() {
  const [y, m] = state.histMonth.split('-').map(Number);
  const first = `${y}-${pad(m)}-01`, last = fmt(new Date(y, m, 0)), today = todayStr();
  const days = range(first, last).filter(d => d <= today && tasksOn(d).length).reverse();
  return `<div class="page-head"><div><h1>History</h1><div class="sub">Every day, task by task</div></div>
    <div class="datenav"><button class="icon-btn" data-act="hmonth" data-n="-1">‹</button><div class="cur">${MONTHS[m - 1]} ${y}</div><button class="icon-btn" data-act="hmonth" data-n="1">›</button></div></div>
  <div class="card">${days.length ? days.map(ds => { const s = dayStats(ds), d = parse(ds); return `<div class="hist-day"><div class="d">${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}<small>${WD[d.getDay()]}</small></div><div class="hist-items">${tasksOn(ds).map(t => { const st = statusOf(ds, t.id); return `<span class="hi ${st}">${st === 'done' ? '✓' : st === 'missed' ? '✕' : '○'} ${esc(t.title)}</span>`; }).join('')}</div><button class="btn sm" data-act="openDay" data-date="${ds}">${s.done}/${s.total} · Edit</button></div>`; }).join('') : '<div class="empty"><div class="em">🗂️</div>No records for this month.</div>'}</div>`;
}


/* Settings */
function viewSettings() {
  return `<div class="page-head"><div><h1>Settings</h1><div class="sub">Your account, appearance and data</div></div></div>
  <div class="card" style="margin-bottom:18px"><h2>Profile</h2>
    <form id="profileForm" class="row2" style="align-items:end">
      <div class="field" style="margin:0"><label>Name</label><input name="name" required maxlength="60" value="${esc(user.name)}"></div>
      <div class="field" style="margin:0"><label>Email</label><input value="${esc(user.email)}" disabled></div>
      <div><button class="btn primary">Save name</button></div>
    </form>
  </div>
  <div class="card" style="margin-bottom:18px"><h2>Change password</h2>
    <form id="pwForm" class="row2" style="align-items:end">
      <div class="field" style="margin:0"><label>Current password</label><input type="password" name="current" required autocomplete="current-password"></div>
      <div class="field" style="margin:0"><label>New password</label><input type="password" name="next" required minlength="8" autocomplete="new-password"></div>
      <div><button class="btn primary">Update password</button></div>
    </form>
    <p class="sub" style="margin-top:10px">Changing your password signs you out on all other devices.</p>
  </div>
  <div class="card" style="margin-bottom:18px">
    <div class="settings-row"><div><b>Dark mode</b><div class="sub">Easier on the eyes at night — saved to your account</div></div><button class="btn" data-act="theme">${user.theme === 'dark' ? '☀️ Switch to light' : '🌙 Switch to dark'}</button></div>
    <div class="settings-row"><div><b>Export backup</b><div class="sub">Download all your tasks and records as a JSON file</div></div><button class="btn" data-act="export">⬇ Export</button></div>
    <div class="settings-row"><div><b>Import backup</b><div class="sub">Restore from an exported file (replaces your current tasks and history)</div></div><button class="btn" data-act="import">⬆ Import</button><input type="file" id="file" accept="application/json" hidden></div>
  </div>
  <div class="card danger-zone">
    <div class="settings-row"><div><b>Sign out</b><div class="sub">Signed in as ${esc(user.email)}</div></div><button class="btn" data-act="logout">Sign out</button></div>
    <div class="settings-row"><div><b>Erase all tasks</b><div class="sub">Deletes every task and all history, but keeps your account</div></div><button class="btn danger" data-act="wipe">Erase data</button></div>
    <div class="settings-row"><div><b>Delete account</b><div class="sub">Permanently deletes your account and all of its data</div></div><button class="btn danger" data-act="deleteAccount">Delete account</button></div>
  </div>`;
}

/* ---------- Modal ---------- */
function openModal(html) { const m = $('#modal'); m.innerHTML = `<div class="modal">${html}</div>`; m.hidden = false; const f = m.querySelector('input:not([type=hidden])'); f && f.focus(); }
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }

function taskModal(id) {
  const t = db.tasks.find(x => x.id === id) || { title: '', category: 'Work', priority: 'medium', repeat: 'once', days: [1, 2, 3, 4, 5], start: state.date, notes: '' };
  const rep = t.repeat === 'once' ? 'once' : t.days.length === 7 ? 'daily' : 'custom';
  openModal(`<h2>${id ? 'Edit task' : 'New task'}</h2>
  <form id="tf" data-id="${id || ''}">
    <div class="field"><label>Task</label><input name="title" required maxlength="120" placeholder="e.g. Study DSA for 1 hour" value="${esc(t.title)}"></div>
    <div class="row2">
      <div class="field"><label>Category</label><select name="category">${Object.keys(CATS).map(c => `<option ${c === t.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Priority</label><select name="priority">${['high', 'medium', 'low'].map(p => `<option value="${p}" ${p === t.priority ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Repeat</label>
      <div class="chips" id="repChips">${[['once', 'Once'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['custom', 'Custom days']].map(([v, l]) => `<button type="button" class="chip ${v === rep ? 'on' : ''}" data-rep="${v}">${l}</button>`).join('')}</div>
      <input type="hidden" name="repeat" value="${rep}">
    </div>
    <div class="field" id="dayRow" ${rep === 'custom' ? '' : 'hidden'}><label>Days of week</label><div class="chips">${WD.map((d, i) => `<button type="button" class="chip ${t.days.includes(i) ? 'on' : ''}" data-day="${i}">${d}</button>`).join('')}</div></div>
    <div class="field"><label id="dateLbl">${rep === 'once' ? 'Date' : 'Starting from'}</label><input type="date" name="start" required value="${t.start}"></div>
    <div class="field"><label>Notes (optional)</label><input name="notes" maxlength="160" value="${esc(t.notes || '')}"></div>
    <div class="modal-foot"><button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn primary">${id ? 'Save changes' : 'Add task'}</button></div>
  </form>`);
}
function dayModal(ds) {
  const list = tasksOn(ds);
  openModal(`<h2>${longDate(ds)}</h2>${list.length ? list.map(t => { const st = statusOf(ds, t.id); return `<div class="task s-${st}" style="--c:${CATS[t.category] || CATS.Other}"><div class="t-main"><div class="t-title">${esc(t.title)}</div></div><div class="actions"><button class="act yes ${st === 'done' ? 'on' : ''}" data-act="mset" data-date="${ds}" data-id="${t.id}" data-st="done">✓</button><button class="act no ${st === 'missed' ? 'on' : ''}" data-act="mset" data-date="${ds}" data-id="${t.id}" data-st="missed">✕</button></div></div>`; }).join('') : '<div class="empty">No tasks on this day.</div>'}
  <div class="modal-foot"><button class="btn" data-act="closeModal">Close</button></div>`);
}
function deleteAccountModal() {
  openModal(`<h2>Delete your account?</h2>
  <p class="sub" style="margin-bottom:16px">This permanently deletes your account, all tasks and all history. It cannot be undone.</p>
  <form id="delAccForm"><div class="field"><label>Enter your password to confirm</label><input type="password" name="password" required autocomplete="current-password"></div>
  <div class="modal-foot"><button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn primary" style="background:var(--miss);border-color:var(--miss)">Delete forever</button></div></form>`);
}

/* ---------- Auth screen ---------- */
function showAuth(mode, error = '') {
  user = null; db = { tasks: [], log: {} };
  closeModal();
  $('#boot').hidden = true; $('#app').hidden = true; $('#auth').hidden = false;
  document.documentElement.dataset.theme = 'light';
  const reg = mode === 'register';
  const f = $('#authForm'); f.dataset.mode = mode;
  f.innerHTML = `<h2>${reg ? 'Create your account' : 'Welcome back'}</h2>
    <div class="sub">${reg ? 'Start tracking your days in under a minute.' : 'Sign in to continue tracking your progress.'}</div>
    ${error ? `<div class="auth-err">${esc(error)}</div>` : ''}
    ${reg ? '<div class="field"><label>Full name</label><input name="name" required maxlength="60" autocomplete="name" placeholder="Your name"></div>' : ''}
    <div class="field"><label>Email</label><input type="email" name="email" required autocomplete="email" placeholder="you@example.com"></div>
    <div class="field"><label>Password</label><input type="password" name="password" required ${reg ? 'minlength="8" autocomplete="new-password" placeholder="At least 8 characters"' : 'autocomplete="current-password" placeholder="Your password"'}></div>
    <button class="btn primary">${reg ? 'Create account' : 'Sign in'}</button>
    <div class="auth-switch">${reg ? 'Already have an account?' : "Don't have an account?"} <button type="button" data-act="authMode" data-mode="${reg ? 'login' : 'register'}">${reg ? 'Sign in' : 'Create one'}</button></div>`;
  f.querySelector('input').focus();
}
async function enterApp(u) {
  user = u;
  db = await api('GET', '/api/data');
  state.view = 'today'; state.date = todayStr();
  $('#boot').hidden = true; $('#auth').hidden = true; $('#app').hidden = false;
  render();
}

/* ---------- Events ---------- */
document.addEventListener('click', async e => {
  const nav = e.target.closest('.nav-item');
  if (nav) { state.view = nav.dataset.view; render(); return; }
  if (e.target.id === 'modal') return closeModal();
  const chip = e.target.closest('[data-rep],[data-day]');
  if (chip) {
    const f = $('#tf');
    if (chip.dataset.rep) {
      f.querySelectorAll('[data-rep]').forEach(c => c.classList.toggle('on', c === chip));
      f.repeat.value = chip.dataset.rep; $('#dayRow').hidden = chip.dataset.rep !== 'custom';
      $('#dateLbl').textContent = chip.dataset.rep === 'once' ? 'Date' : 'Starting from';
    } else chip.classList.toggle('on');
    return;
  }
  const el = e.target.closest('[data-act]'); if (!el) return;
  const d = el.dataset, ds = state.date;
  switch (d.act) {
    case 'authMode': showAuth(d.mode); return;
    case 'logout': try { await api('POST', '/api/auth/logout'); } catch (_) {} showAuth('login'); return;
    case 'day': state.date = addDays(ds, +d.n); break;
    case 'goToday': state.date = todayStr(); break;
    case 'set': setStatus(ds, d.id, d.st); break;
    case 'mset': setStatus(d.date, d.id, d.st); dayModal(d.date); render(); return;
    case 'allDone': setStatuses(ds, tasksOn(ds).filter(t => statusOf(ds, t.id) === 'pending').map(t => [t.id, 'done'])); toast('All remaining tasks marked done'); break;
    case 'restMissed': setStatuses(ds, tasksOn(ds).filter(t => statusOf(ds, t.id) === 'pending').map(t => [t.id, 'missed'])); toast('Day closed. Rest marked as not completed'); break;
    case 'addTask': taskModal(); return;
    case 'editTask': taskModal(d.id); return;
    case 'delTask': {
      const t = db.tasks.find(x => x.id === d.id);
      if (!confirm(t.repeat === 'once' ? 'Delete this task?' : 'Stop this recurring task from today? Past history is kept.')) return;
      try {
        if (t.repeat === 'once') {
          await sync(api('DELETE', `/api/tasks/${t.id}`));
          db.tasks = db.tasks.filter(x => x.id !== t.id);
          Object.keys(db.log).forEach(k => { delete db.log[k][t.id]; if (!Object.keys(db.log[k]).length) delete db.log[k]; });
        } else {
          const r = await sync(api('DELETE', `/api/tasks/${t.id}`, { end: addDays(todayStr(), -1) }));
          Object.assign(t, r.task);
        }
        toast('Task removed');
      } catch (_) { return; }
      break;
    }
    case 'closeModal': closeModal(); return;
    case 'period': state.period = d.p; break;
    case 'shift': shiftAnchor(+d.n); break;
    case 'openDay': dayModal(d.date); return;
    case 'hmonth': { const [y, m] = state.histMonth.split('-').map(Number); const x = new Date(y, m - 1 + +d.n, 1); state.histMonth = `${x.getFullYear()}-${pad(x.getMonth() + 1)}`; break; }
    case 'theme': {
      const theme = user.theme === 'dark' ? 'light' : 'dark';
      user.theme = theme; render();
      try { user = (await api('PATCH', '/api/me', { theme })).user; } catch (err) { toast(err.message); }
      return;
    }
    case 'export': {
      try {
        const data = await api('GET', '/api/export');
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        a.download = `daytrack-backup-${todayStr()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } catch (err) { toast(err.message); }
      return;
    }
    case 'import': $('#file').click(); return;
    case 'wipe':
      if (!confirm('Erase ALL your tasks and history? This cannot be undone.')) return;
      try { await sync(api('DELETE', '/api/data'), 'All data erased'); db = { tasks: [], log: {} }; } catch (_) { return; }
      break;
    case 'deleteAccount': deleteAccountModal(); return;
  }
  render();
});

document.addEventListener('change', e => {
  if (e.target.id !== 'file') return;
  const f = e.target.files[0]; if (!f) return;
  e.target.value = '';
  if (!confirm('Importing replaces all your current tasks and history. Continue?')) return;
  const r = new FileReader();
  r.onload = async () => {
    let parsed;
    try { parsed = JSON.parse(r.result); } catch (_) { return toast('Invalid backup file'); }
    try { db = await api('POST', '/api/import', parsed); toast('Backup restored'); render(); } catch (err) { toast(err.message); }
  };
  r.readAsText(f);
});

document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, v = Object.fromEntries(new FormData(f));
  const btn = f.querySelector('button:not([type=button])');
  const busy = on => { if (btn) btn.disabled = on; };

  if (f.id === 'authForm') {
    const reg = f.dataset.mode === 'register';
    busy(true);
    try {
      const r = await api('POST', reg ? '/api/auth/register' : '/api/auth/login', v);
      await enterApp(r.user);
      toast(reg ? `Welcome, ${r.user.name}!` : `Welcome back, ${r.user.name}!`);
    } catch (err) {
      showAuth(f.dataset.mode, err.message);
      const nf = $('#authForm');
      if (v.email) nf.email.value = v.email;
      if (reg && v.name) nf.elements.name.value = v.name;
    }
    return;
  }

  if (f.id === 'tf') {
    const id = f.dataset.id;
    let days = [...f.querySelectorAll('[data-day].on')].map(c => +c.dataset.day);
    const repeat = v.repeat === 'once' ? 'once' : 'weekly';
    if (v.repeat === 'daily') days = [0, 1, 2, 3, 4, 5, 6]; else if (v.repeat === 'weekdays') days = [1, 2, 3, 4, 5];
    if (repeat === 'weekly' && !days.length) { toast('Pick at least one day'); return; }
    const data = { title: v.title.trim(), category: v.category, priority: v.priority, repeat, days, start: v.start, notes: v.notes.trim() };
    if (!data.title) return;
    busy(true);
    try {
      const r = await api(id ? 'PUT' : 'POST', id ? `/api/tasks/${id}` : '/api/tasks', data);
      if (id) db.tasks = db.tasks.map(t => t.id === id ? r.task : t); else db.tasks.push(r.task);
      closeModal(); toast(id ? 'Task updated' : 'Task added');
      if (state.view === 'today' && data.start !== state.date && repeat === 'once') state.date = data.start;
      render();
    } catch (err) { toast(err.message); busy(false); }
    return;
  }

  if (f.id === 'profileForm') {
    busy(true);
    try { user = (await api('PATCH', '/api/me', { name: v.name })).user; toast('Name updated'); render(); } catch (err) { toast(err.message); busy(false); }
    return;
  }

  if (f.id === 'pwForm') {
    busy(true);
    try { await api('POST', '/api/me/password', v); toast('Password updated'); f.reset(); } catch (err) { toast(err.message); }
    busy(false);
    return;
  }

  if (f.id === 'delAccForm') {
    busy(true);
    try { await api('DELETE', '/api/me', v); toast('Account deleted'); showAuth('register'); } catch (err) { toast(err.message); busy(false); }
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

/* ---------- Boot ---------- */
(async () => {
  try { const r = await api('GET', '/api/me'); await enterApp(r.user); }
  catch (_) { if (!user) showAuth('login'); }
})();
