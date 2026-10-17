// netlify/functions/backup-scheduled.mjs (v211)
//
// Nightly copy of everything the syndicate can't afford to lose: /state
// (members, history, dues, drafts, settings). Runs at about 2:15am
// Melbourne time and keeps 30 days of copies.
//
//   /backups/{key}      = { at, kind, state }        full copy
//   /backupIndex/{key}  = { at, kind, bytes, weeks, lastWeek }   small summary
//                                                     Admin lists from this
//
// Admin → Tools → Backups lists them and can restore one (it takes a safety
// copy of the current data first). The same run also tidies up old error
// reports (30 days) and old slip-reader cache entries (90 days).
//
// Uses the Firebase service account (FIREBASE_CLIENT_EMAIL /
// FIREBASE_PRIVATE_KEY), the same one Syndy uses.

import { getFirebaseAccessToken } from './lib/firebase-token.mjs';

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const KEEP_DAYS = 30;
const DAY = 86400000;

function melbourneDate(d = new Date()){
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export async function runBackup(kind = 'nightly'){
  const token = await getFirebaseAccessToken();
  const url = (path, q = '') => `${FIREBASE_URL}${path}.json?access_token=${token}${q}`;
  const res = await fetch(url('/state'));
  if(!res.ok) throw new Error(`Couldn't read /state (HTTP ${res.status})`);
  const text = await res.text();
  const state = JSON.parse(text);
  if(!state || typeof state !== 'object') throw new Error('/state is empty, nothing backed up');
  const at = Date.now();
  const key = kind === 'nightly' ? melbourneDate() : `${melbourneDate()}-${kind}-${at}`;
  const history = Array.isArray(state.history) ? state.history : [];
  const summary = { at, kind, bytes: text.length, weeks: history.length, lastWeek: history.length ? (history[history.length - 1].label || null) : null, members: Array.isArray(state.members) ? state.members.length : 0 };
  const put = await fetch(url(`/backups/${key}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at, kind, state }) });
  if(!put.ok) throw new Error(`Backup write failed (HTTP ${put.status})`);
  await fetch(url(`/backupIndex/${key}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary) });

  // keep 30 days of copies
  const idx = await fetch(url('/backupIndex')).then(r => r.ok ? r.json() : null).catch(() => null) || {};
  const cutoff = at - KEEP_DAYS * DAY;
  const old = Object.entries(idx).filter(([, v]) => v && v.at && v.at < cutoff).map(([k]) => k);
  for(const k of old){
    await fetch(url(`/backups/${k}`), { method: 'DELETE' });
    await fetch(url(`/backupIndex/${k}`), { method: 'DELETE' });
  }

  // tidy: error reports older than 30 days, slip cache older than 90
  const tidy = async (path, days) => {
    const data = await fetch(url(path)).then(r => r.ok ? r.json() : null).catch(() => null) || {};
    const lim = at - days * DAY;
    const patch = {};
    Object.entries(data).forEach(([k, v]) => { if(v && v.at && v.at < lim) patch[k] = null; });
    if(Object.keys(patch).length) await fetch(url(path), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    return Object.keys(patch).length;
  };
  const errorsRemoved = await tidy('/clientErrors', 30).catch(() => 0);
  const cacheRemoved = await tidy('/slipScanCache', 90).catch(() => 0);
  return { key, ...summary, removedBackups: old.length, errorsRemoved, cacheRemoved };
}

export default async () => {
  try{
    const out = await runBackup('nightly');
    console.log('Backup done:', JSON.stringify(out));
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }catch(e){
    console.error('Backup failed:', e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = {
  // 15:15 UTC = 2:15am in Melbourne during daylight saving (1:15am outside it)
  schedule: '15 15 * * *'
};
