/* ============================================================
   SkySearch — moteur
   Recherche : départ (pays | ville | aéroport) × arrivée × date.
   Les heures d'arrivée ne sont jamais stockées : elles sont calculées
   depuis l'heure de départ locale, la durée bloc et les fuseaux IANA.
   ============================================================ */
'use strict';

/* ---------- 1. Chargement de la base ---------- */
const D = window.SKYDATA;
if (!D) throw new Error('data.js manquant ou chargé après app');

const TZ = D.tz, AC = D.ac, TERM = D.term;

/* Aéroports : index numérique ↔ code IATA */
const AP = {};          // IATA → objet
const APL = [];         // index → objet (ordre du fichier)
D.aps.split('\n').forEach((line, i) => {
  const [iata, city, name, cc, la, lo, tzi, rk] = line.split('|');
  const o = { i: iata, c: city, n: name, cc, la: +la, lo: +lo, z: TZ[+tzi], r: +rk, x: i };
  AP[iata] = o; APL[i] = o;
});

/* Pays : code ISO2 → { nom, alias[], aéroports[] } */
const CTY = {};
D.cty.split('\n').forEach(line => {
  const [cc, name, aliases] = line.split('|');
  CTY[cc] = { cc, name, alias: aliases ? aliases.split(';') : [], aps: [] };
});
APL.forEach(a => { if (CTY[a.cc]) CTY[a.cc].aps.push(a.i); });
Object.values(CTY).forEach(c => c.aps.sort((x, y) => AP[x].r - AP[y].r || x.localeCompare(y)));

/* Compagnies */
const AL = {};
D.air.split('\n').forEach(line => { const [c, n] = line.split('|'); AL[c] = n; });

/* Villes : une ville peut avoir plusieurs aéroports (Paris → CDG, ORY) */
const CITY = {};
APL.forEach(a => {
  const key = a.cc + '|' + a.c;
  (CITY[key] = CITY[key] || { city: a.c, cc: a.cc, aps: [] }).aps.push(a.i);
});
Object.values(CITY).forEach(c => c.aps.sort((x, y) => AP[x].r - AP[y].r));

/* Exonymes : « Köln » → Cologne, « Bombay » → Mumbai */
const CAL = {};
(D.cal || '').split('\n').forEach(line => {
  if (!line) return;
  const [alias, city] = line.split('|');
  (CAL[alias] = CAL[alias] || []).push(city);
});

/* Vols : tableau compact, chargé une fois */
const FL = [];
D.fls.split('\n').forEach(line => {
  const p = line.split('|');
  FL.push({
    num: p[0], d: +p[1], a: +p[2],
    dep: +p[3], dur: +p[4],
    ac: AC[+p[5]], td: TERM[+p[6]] || '', ta: TERM[+p[7]] || ''
  });
});

/* Index par aéroport de départ : évite de balayer 14 000 vols à chaque requête */
const BY_DEP = new Map();
FL.forEach(f => {
  let arr = BY_DEP.get(f.d);
  if (!arr) BY_DEP.set(f.d, arr = []);
  arr.push(f);
});

/* ---------- 2. Utilitaires ---------- */
const deacc = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = s => deacc(String(s || '').toLowerCase().trim()).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = n => String(n).padStart(2, '0');
const fmtDur = m => `${Math.floor(m / 60)}h${pad2(m % 60)}`;
const fmtHM = m => { m = ((m % 1440) + 1440) % 1440; return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`; };
const isDate = d => d instanceof Date && !isNaN(d);

function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }

/* Décalage UTC d'un fuseau à une date donnée. Gère l'heure d'été. */
const _off = new Map();
function tzOffset(zone, date) {
  const key = zone + '|' + date.toISOString().slice(0, 10);
  if (_off.has(key)) return _off.get(key);
  let v = 0;
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).format(date);
    const m = s.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
    if (m) v = (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + (+(m[3] || 0)));
  } catch (e) { }
  _off.set(key, v);
  return v;
}
function tzLabel(zone, date) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(date);
    const v = p.find(x => x.type === 'timeZoneName');
    return v ? v.value.replace('GMT', 'UTC') : '';
  } catch (e) { return ''; }
}
function nowIn(zone) {
  try { return new Intl.DateTimeFormat('fr-FR', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }
  catch (e) { return ''; }
}
function distKm(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const A1 = AP[a], B1 = AP[b];
  if (!A1 || !B1) return null;
  const dla = r(B1.la - A1.la), dlo = r(B1.lo - A1.lo);
  const h = Math.sin(dla / 2) ** 2 + Math.cos(r(A1.la)) * Math.cos(r(B1.la)) * Math.sin(dlo / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/* ---------- 3. Résolution d'une saisie ----------
   Rend { kind:'country'|'city'|'airport', label, aps:[IATA…] }.
   Un pays rend TOUS ses aéroports, une ville tous les siens. */
function resolve(input) {
  const q = norm(input);
  if (!q) return null;

  /* a. code IATA exact */
  const up = input.trim().toUpperCase();
  if (up.length === 3 && AP[up]) {
    const a = AP[up];
    return { kind: 'airport', label: `${a.c} ${a.n}`, code: up, aps: [up], cc: a.cc };
  }

  /* b. pays : nom ou alias, correspondance exacte d'abord */
  for (const cc in CTY) {
    const c = CTY[cc];
    if (c.alias.includes(q) || norm(c.name) === q || cc.toLowerCase() === q) {
      return { kind: 'country', label: c.name, code: cc, aps: c.aps.slice(), cc };
    }
  }

  /* c. ville : correspondance exacte */
  for (const k in CITY) {
    const c = CITY[k];
    if (norm(c.city) === q) {
      return { kind: 'city', label: c.city, code: c.aps[0], aps: c.aps.slice(), cc: c.cc };
    }
  }

  /* c-bis. exonyme de ville */
  if (CAL[q]) {
    for (const cityName of CAL[q]) {
      for (const k in CITY) {
        if (CITY[k].city === cityName) {
          const c = CITY[k];
          return { kind: 'city', label: c.city, code: c.aps[0], aps: c.aps.slice(), cc: c.cc };
        }
      }
    }
  }

  /* d. nom d'aéroport exact */
  for (const i in AP) {
    if (norm(AP[i].n) === q) return { kind: 'airport', label: `${AP[i].c} ${AP[i].n}`, code: i, aps: [i], cc: AP[i].cc };
  }

  /* e. repli : première suggestion de l'autocomplétion */
  const s = suggest(input, 1);
  return s.length ? s[0].resolved : null;
}

/* ---------- 4. Autocomplétion ----------
   Classe pays, villes et aéroports par pertinence, en privilégiant
   les préfixes et les grands hubs. */
function suggest(input, limit) {
  const q = norm(input);
  if (!q) return [];
  limit = limit || 8;
  const out = [];

  for (const cc in CTY) {
    const c = CTY[cc];
    if (!c.aps.length) continue;
    let sc = -1;
    if (norm(c.name) === q || c.alias.includes(q)) sc = 0;
    else if (c.alias.some(a => a.startsWith(q)) || norm(c.name).startsWith(q)) sc = 1;
    else if (c.alias.some(a => a.includes(q))) sc = 4;
    if (sc >= 0) out.push({
      score: sc, type: 'country', title: c.name,
      sub: `${c.aps.length} aéroport${c.aps.length > 1 ? 's' : ''}`,
      badge: 'Pays',
      resolved: { kind: 'country', label: c.name, code: cc, aps: c.aps.slice(), cc }
    });
  }

  for (const k in CITY) {
    const c = CITY[k];
    const nm = norm(c.city);
    let sc = -1;
    const ex = Object.keys(CAL).filter(a => CAL[a].includes(c.city));
    if (nm === q || ex.includes(q)) sc = 0.5;
    else if (nm.startsWith(q) || ex.some(a => a.startsWith(q))) sc = 1.5;
    else if (nm.includes(q)) sc = 4.5;
    if (sc >= 0) {
      const best = AP[c.aps[0]];
      out.push({
        score: sc + (best.r - 1) * 0.3, type: 'city', title: c.city,
        sub: `${CTY[c.cc] ? CTY[c.cc].name : c.cc} · ${c.aps.join(', ')}`,
        badge: c.aps.length > 1 ? `${c.aps.length} aéroports` : c.aps[0],
        resolved: { kind: 'city', label: c.city, code: c.aps[0], aps: c.aps.slice(), cc: c.cc }
      });
    }
  }

  for (const i in AP) {
    const a = AP[i];
    const nm = norm(a.n), ci = norm(a.c);
    let sc = -1;
    if (i.toLowerCase() === q) sc = 0.2;
    else if (nm.startsWith(q)) sc = 2;
    else if (nm.includes(q) && q.length >= 3) sc = 5;
    else if (ci.startsWith(q)) sc = 3;
    if (sc >= 0) out.push({
      score: sc + (a.r - 1) * 0.3, type: 'airport', title: `${a.c} — ${a.n}`,
      sub: CTY[a.cc] ? CTY[a.cc].name : a.cc, badge: i,
      resolved: { kind: 'airport', label: `${a.c} ${a.n}`, code: i, aps: [i], cc: a.cc }
    });
  }

  /* dédoublonnage : une ville à un seul aéroport fait doublon avec cet aéroport */
  const seen = new Set(), res = [];
  out.sort((x, y) => x.score - y.score || x.title.localeCompare(y.title));
  for (const o of out) {
    const key = o.type + '|' + o.resolved.aps.join(',');
    if (seen.has(key)) continue;
    if (o.type === 'airport' && out.some(z => z.type === 'city' && z.resolved.aps.length === 1
      && z.resolved.aps[0] === o.resolved.aps[0] && z.score <= o.score)) continue;
    seen.add(key); res.push(o);
    if (res.length >= limit) break;
  }
  return res;
}

/* ---------- 5. Calcul d'un segment ----------
   Départ local + durée → arrivée locale, décalage de jour, fuseaux. */
function leg(f, date) {
  const dep = APL[f.d], arr = APL[f.a];

  /* f.dep est une heure LOCALE à l'aéroport de départ, pas une heure du
     navigateur. L'instant absolu se reconstruit depuis minuit UTC du jour
     moins le décalage de l'origine. Deux passes, car le décalage lui-même
     dépend de l'instant (bascule heure d'été). */
  const dayUTC = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  let offD = tzOffset(dep.z, new Date(dayUTC + f.dep * 60000));
  let depAbs = new Date(dayUTC + (f.dep - offD) * 60000);
  offD = tzOffset(dep.z, depAbs);
  depAbs = new Date(dayUTC + (f.dep - offD) * 60000);

  const arrAbs = new Date(depAbs.getTime() + f.dur * 60000);
  const offA = tzOffset(arr.z, arrAbs);
  const arrLocal = f.dep - offD + f.dur + offA;
  return {
    num: f.num,
    airline: AL[airlineOf(f.num)] || airlineOf(f.num),
    depIata: dep.i, arrIata: arr.i,
    depCity: dep.c, arrCity: arr.c,
    depName: dep.n, arrName: arr.n,
    depCC: dep.cc, arrCC: arr.cc,
    depZ: dep.z, arrZ: arr.z,
    depMin: f.dep, arrMin: ((arrLocal % 1440) + 1440) % 1440,
    dayShift: Math.floor(arrLocal / 1440),
    dur: f.dur, ac: f.ac, td: f.td, ta: f.ta,
    dist: distKm(dep.i, arr.i),
    tzDep: tzLabel(dep.z, depAbs), tzArr: tzLabel(arr.z, arrAbs),
    depAbs, arrAbs, live: false
  };
}
/* Les codes IATA de compagnie ne font pas toujours 2 lettres (U2, 6E, 3O). */
function airlineOf(num) {
  const two = num.slice(0, 2);
  if (AL[two] && /^\d+$/.test(num.slice(2))) return two;
  const m = num.match(/^([A-Z0-9]{2,3}?)\d{1,4}$/);
  return m ? m[1] : two;
}

/* ---------- 6. Recherche ---------- */
function search(from, to, date) {
  const fromSet = new Set(from.aps.map(i => AP[i].x));
  const toSet = new Set(to.aps.map(i => AP[i].x));
  const hits = [];
  for (const x of fromSet) {
    const arr = BY_DEP.get(x);
    if (!arr) continue;
    for (const f of arr) if (toSet.has(f.a)) hits.push(f);
  }
  return hits.map(f => leg(f, date)).sort((a, b) => a.depMin - b.depMin);
}

/* Si rien : propose le sens inverse et les pays voisins effectivement desservis */
function alternatives(from, to) {
  const fromSet = new Set(from.aps.map(i => AP[i].x));
  const toSet = new Set(to.aps.map(i => AP[i].x));
  let reverse = 0;
  for (const x of toSet) {
    const arr = BY_DEP.get(x);
    if (arr) for (const f of arr) if (fromSet.has(f.a)) reverse++;
  }
  const destCC = {};
  for (const x of fromSet) {
    const arr = BY_DEP.get(x);
    if (arr) for (const f of arr) {
      const cc = APL[f.a].cc;
      destCC[cc] = (destCC[cc] || 0) + 1;
    }
  }
  const top = Object.entries(destCC).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([cc, n]) => ({ cc, name: CTY[cc] ? CTY[cc].name : cc, n }));
  return { reverse, top };
}

/* ---------- 7. Dates ---------- */
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const longDate = d => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  d.setHours(0, 0, 0, 0);
  return isNaN(d) ? null : d;
}

/* ============================================================
   8. ENRICHISSEMENT TEMPS RÉEL (optionnel)
   ------------------------------------------------------------
   La base embarquée répond toujours. Si une clé est configurée ET que
   le trajet vise peu d'aéroports de chaque côté, on interroge en plus
   le fournisseur pour obtenir les vols réels du jour.
   Une recherche « France → Grèce » touche 22 × 10 aéroports : on ne
   lance pas 22 appels, la base locale répond seule.
   ============================================================ */

const API_MAX_AIRPORTS = 2;   // au-delà, base locale seule

const PROVIDERS = {
  aerodatabox: {
    label: 'AeroDataBox',
    doc: 'https://doc.aerodatabox.com',
    signup: 'https://rapidapi.com/aedbx-aedbx/api/aerodatabox',
    keyLabel: 'Clé RapidAPI (X-RapidAPI-Key)',
    host: 'aerodatabox.p.rapidapi.com',
    build(origin, date, key) {
      const [f, t] = window12(date);
      return {
        label: `Départs de ${origin}`,
        method: 'GET',
        url: `https://${this.host}/flights/airports/iata/${origin}/${f}/${t}`,
        query: { withLeg: 'true', direction: 'Departure', withCancelled: 'true', withCodeshared: 'false', withCargo: 'false', withPrivate: 'false' },
        headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': this.host }
      };
    },
    normalize(raw) {
      const rows = Array.isArray(raw) ? raw : [].concat((raw && raw.departures) || [], (raw && raw.arrivals) || []);
      return rows.map(f => {
        const d = f.departure || {}, a = f.arrival || {};
        return mkLive({
          num: (f.number || '').replace(/\s+/g, ''),
          airline: (f.airline && f.airline.name) || null,
          depIata: iataOf(d), arrIata: iataOf(a),
          depSched: timeOf(d.scheduledTime), arrSched: timeOf(a.scheduledTime),
          depActual: timeOf(d.revisedTime || d.runwayTime || d.predictedTime),
          arrActual: timeOf(a.revisedTime || a.runwayTime || a.predictedTime),
          td: d.terminal, ta: a.terminal, gate: d.gate, belt: a.baggageBelt,
          ac: (f.aircraft && (f.aircraft.model || f.aircraft.reg)) || null,
          status: f.status
        });
      }).filter(f => f.depIata && f.arrIata);
    }
  },
  aviationstack: {
    label: 'Aviationstack',
    doc: 'https://aviationstack.com/documentation',
    signup: 'https://aviationstack.com/signup/free',
    keyLabel: 'Access key Aviationstack',
    note: "Le palier gratuit d'Aviationstack ne sert qu'en HTTP : depuis une page HTTPS le navigateur bloque l'appel. Il faut un plan payant ou le proxy.",
    build(origin, date, key) {
      const q = { access_key: key, dep_iata: origin, limit: '100' };
      const d = ymd(date);
      if (d !== ymd(new Date())) q.flight_date = d;
      return { label: `Départs de ${origin}`, method: 'GET', url: 'https://api.aviationstack.com/v1/flights', query: q, headers: {} };
    },
    normalize(raw) {
      return ((raw && raw.data) || []).map(f => {
        const d = f.departure || {}, a = f.arrival || {};
        return mkLive({
          num: (f.flight && (f.flight.iata || f.flight.number)) || '',
          airline: (f.airline && f.airline.name) || null,
          depIata: d.iata, arrIata: a.iata,
          depSched: d.scheduled, arrSched: a.scheduled,
          depActual: d.actual || d.estimated, arrActual: a.actual || a.estimated,
          td: d.terminal, ta: a.terminal, gate: d.gate, belt: a.baggage,
          ac: (f.aircraft && (f.aircraft.iata || f.aircraft.registration)) || null,
          status: f.flight_status, delay: d.delay
        });
      }).filter(f => f.depIata && f.arrIata);
    }
  }
};

const iataOf = s => { const a = s.airport || s; return (a && (a.iata || a.iataCode)) || null; };
const timeOf = t => !t ? null : (typeof t === 'string' ? t : (t.local || t.utc || null));

/* Fenêtre de 12 h, limite de l'endpoint FIDS. */
function window12(date) {
  const today = ymd(date) === ymd(new Date());
  let s = today ? Math.max(0, new Date().getHours() - 1) : 6;
  let e = Math.min(23, s + 11);
  return [`${ymd(date)}T${pad2(s)}:00`, `${ymd(date)}T${pad2(e)}:59`];
}

function parseISOish(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  let t = String(s).trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) t += 'Z';
  t = t.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(t);
  return isNaN(d) ? null : d;
}
const STATUS_MAP = {
  scheduled: ['scheduled', 'expected', 'unknown'],
  departed: ['departed', 'enroute', 'en route', 'active', 'inflight', 'in flight', 'airborne', 'approaching'],
  landed: ['landed', 'arrived'],
  delayed: ['delayed'],
  cancelled: ['cancelled', 'canceled'],
  diverted: ['diverted']
};
function mapStatus(s) {
  if (!s) return 'scheduled';
  const l = String(s).toLowerCase().replace(/[_-]/g, ' ').trim();
  for (const k in STATUS_MAP) if (STATUS_MAP[k].some(v => l === v || l.includes(v))) return k;
  return 'scheduled';
}
const STATUS_FR = { scheduled: 'Prévu', departed: 'En vol', landed: 'Atterri', delayed: 'Retardé', cancelled: 'Annulé', diverted: 'Dérouté' };
const STATUS_CLASS = { scheduled: 's-sched', departed: 's-air', landed: 's-land', delayed: 's-late', cancelled: 's-cancel', diverted: 's-late' };

/* Vol temps réel ramené à la même forme qu'un segment local. */
function mkLive(o) {
  const dS = parseISOish(o.depSched), aS = parseISOish(o.arrSched);
  const dA = parseISOish(o.depActual), aA = parseISOish(o.arrActual);
  const dep = dA || dS, arr = aA || aS;
  let delay = o.delay != null ? Number(o.delay) : null;
  if (delay == null && dA && dS) delay = Math.round((dA - dS) / 60000);
  const A1 = AP[o.depIata], B1 = AP[o.arrIata];
  const num = (o.num || '').toUpperCase().replace(/\s+/g, '');
  return {
    num,
    airline: o.airline || AL[airlineOf(num)] || '',
    depIata: o.depIata, arrIata: o.arrIata,
    depCity: A1 ? A1.c : o.depIata, arrCity: B1 ? B1.c : o.arrIata,
    depName: A1 ? A1.n : '', arrName: B1 ? B1.n : '',
    depZ: A1 ? A1.z : null, arrZ: B1 ? B1.z : null,
    depMin: dep ? dep.getHours() * 60 + dep.getMinutes() : null,
    arrMin: arr ? arr.getHours() * 60 + arr.getMinutes() : null,
    dayShift: (dep && arr && arr.toDateString() !== dep.toDateString())
      ? Math.round((new Date(arr).setHours(0, 0, 0, 0) - new Date(dep).setHours(0, 0, 0, 0)) / 86400000) : 0,
    dur: (dep && arr) ? Math.round((arr - dep) / 60000) : null,
    ac: o.ac || '', td: o.td || '', ta: o.ta || '',
    gate: o.gate || '', belt: o.belt || '',
    dist: (A1 && B1) ? distKm(o.depIata, o.arrIata) : null,
    status: mapStatus(o.status),
    delay: (delay != null && isFinite(delay)) ? delay : null,
    schedDep: dS, schedArr: aS,
    depAbs: dep, arrAbs: arr,
    tzDep: A1 && dep ? tzLabel(A1.z, dep) : '', tzArr: B1 && arr ? tzLabel(B1.z, arr) : '',
    live: true
  };
}

/* ---------- Réglages ---------- */
const CFG = {
  get() { try { return JSON.parse(safeGet('ss3_cfg') || '{}'); } catch (e) { return {}; } },
  set(p) { const c = Object.assign(CFG.get(), p); safeSet('ss3_cfg', JSON.stringify(c)); return c; },
  provider() { return CFG.get().provider || 'local'; },
  key() { return CFG.get().key || ''; },
  proxy() { return (CFG.get().proxy || '').trim(); },
  ready() { const c = CFG.get(); return !!(c.provider && c.provider !== 'local' && (c.key || (c.proxy || '').trim())); }
};

/* ---------- Cache 90 s ---------- */
const TTL = 90000;
const mem = new Map();
const DATE_KEYS = ['schedDep', 'schedArr', 'depAbs', 'arrAbs'];
function cacheGet(k) {
  const m = mem.get(k);
  if (m && Date.now() - m.t < TTL) return m.v;
  try {
    const raw = safeGet('ss3_c_' + k);
    if (raw) {
      const o = JSON.parse(raw);
      if (Date.now() - o.t < TTL) {
        /* JSON transforme les Date en chaînes : il faut les réhydrater,
           sinon le rendu casse au premier hit de cache disque. */
        const v = o.v.map(f => {
          const c = Object.assign({}, f);
          DATE_KEYS.forEach(k2 => { if (c[k2] && !(c[k2] instanceof Date)) { const d = new Date(c[k2]); c[k2] = isNaN(d) ? null : d; } });
          return c;
        });
        mem.set(k, { t: o.t, v });
        return v;
      }
    }
  } catch (e) { }
  return null;
}
function cachePut(k, v) {
  mem.set(k, { t: Date.now(), v });
  try { safeSet('ss3_c_' + k, JSON.stringify({ t: Date.now(), v })); } catch (e) { }
}

/* ---------- Appel ---------- */
function buildRequest(origin, date) {
  const p = PROVIDERS[CFG.provider()];
  if (!p) return null;
  const req = p.build(origin, date, CFG.key());
  req.provider = CFG.provider();
  req.fullUrl = req.url + (Object.keys(req.query || {}).length ? '?' + new URLSearchParams(req.query) : '');
  const shown = Object.assign({}, req.query || {});
  if (shown.access_key) shown.access_key = '••••••••';
  req.displayUrl = req.url + (Object.keys(shown).length ? '?' + new URLSearchParams(shown) : '');
  return req;
}

async function fetchLive(from, to, date) {
  if (!CFG.ready()) return { ok: false, reason: 'off' };
  if (from.aps.length > API_MAX_AIRPORTS || to.aps.length > API_MAX_AIRPORTS)
    return { ok: false, reason: 'too-broad' };

  const toSet = new Set(to.aps);
  const all = [];
  let lastReq = null;

  for (const origin of from.aps) {
    const req = buildRequest(origin, date);
    if (!req) return { ok: false, reason: 'no-request' };
    lastReq = req;

    const ck = req.provider + '|' + req.fullUrl.replace(/[?&]access_key=[^&]*/g, '');
    const hit = cacheGet(ck);
    if (hit) { all.push(...hit.filter(f => toSet.has(f.arrIata))); continue; }

    let url = req.fullUrl, headers = Object.assign({}, req.headers);
    const proxy = CFG.proxy();
    if (proxy) { url = proxy.replace(/\/$/, '') + '/' + req.provider + '?target=' + encodeURIComponent(req.fullUrl); headers = {}; }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(url, { headers, signal: ctl.signal });
      clearTimeout(timer);
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', status: res.status, req };
      if (res.status === 429) return { ok: false, reason: 'quota', status: 429, req };
      if (!res.ok) return { ok: false, reason: 'http', status: res.status, req };
      const raw = await res.json();
      if (raw && raw.error) return { ok: false, reason: 'api', message: raw.error.message || raw.error.info || '', req };
      const list = PROVIDERS[req.provider].normalize(raw);
      cachePut(ck, list);
      all.push(...list.filter(f => toSet.has(f.arrIata)));
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') return { ok: false, reason: 'timeout', req };
      return { ok: false, reason: navigator.onLine ? 'cors' : 'offline', message: e.message, req };
    }
  }
  all.sort((a, b) => (a.depMin == null ? 1e9 : a.depMin) - (b.depMin == null ? 1e9 : b.depMin));
  return { ok: true, flights: all, req: lastReq };
}

const errLabel = r => ({ auth: 'Clé refusée', quota: 'Quota dépassé', cors: 'Appel bloqué par le navigateur', offline: 'Hors ligne', timeout: 'Délai dépassé', http: 'Erreur du fournisseur', api: 'Erreur du fournisseur' }[r] || 'Échec de la requête');

/* ---------- Liens externes ---------- */
const ICAO = { AF: 'AFR', BA: 'BAW', LH: 'DLH', KL: 'KLM', IB: 'IBE', AZ: 'ITY', TP: 'TAP', SN: 'BEL', LX: 'SWR', OS: 'AUA', A3: 'AEE', EK: 'UAE', QR: 'QTR', EY: 'ETD', TK: 'THY', AA: 'AAL', DL: 'DAL', UA: 'UAL', AC: 'ACA', SQ: 'SIA', CX: 'CPA', NH: 'ANA', JL: 'JAL', KE: 'KAL', OZ: 'AAR', BR: 'EVA', CI: 'CAL', MH: 'MAS', TG: 'THA', ET: 'ETH', MS: 'MSR', RJ: 'RJA', AI: 'AIC', WY: 'OMA', GF: 'GFA', QF: 'QFA', NZ: 'ANZ', SA: 'SAA', KQ: 'KQA', LA: 'LAN', AV: 'AVA', AM: 'AMX', CM: 'CMP', SU: 'AFL', AY: 'FIN', SK: 'SAS', LO: 'LOT', OK: 'CSA', RO: 'ROT', JU: 'ASL', OU: 'CTN', FI: 'ICE', EI: 'EIN', U2: 'EZY', FR: 'RYR', W6: 'WZZ', VY: 'VLG', TO: 'TVF', HV: 'TRA', PC: 'PGT', DY: 'NOZ', EW: 'EWG', VS: 'VIR', AT: 'RAM', TU: 'TAR', AH: 'DAH', LY: 'ELY', SV: 'SVA', KU: 'KAC', ME: 'MEA', PK: 'PIA', UL: 'ALK', BG: 'BBC', VN: 'HVN', PR: 'PAL', GA: 'GIA', AK: 'AXM', '6E': 'IGO' };
function faUrl(num) {
  const c = airlineOf(num), n = num.slice(c.length);
  return (ICAO[c] && /^\d+$/.test(n))
    ? `https://www.flightaware.com/live/flight/${ICAO[c]}${n}`
    : 'https://www.flightaware.com/live/findflight/';
}
const faRoute = (a, b) => `https://www.flightaware.com/live/findflight?origin=${a}&destination=${b}`;
const fr24Url = n => `https://www.flightradar24.com/data/flights/${String(n).toLowerCase()}`;

/* ============================================================
   9. INTERFACE
   ============================================================ */
const $ = id => document.getElementById(id);
const reduced = () => { try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
const isStandalone = () => { try { return !!navigator.standalone || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches); } catch (e) { return false; } };

const S = { from: null, to: null, date: null, flights: [], shown: 0, sort: 'dep', source: 'local', error: null, req: null };
const PAGE = 6;

/* ---------- Champs avec autocomplétion ---------- */
function setupField(inputId, acId, clearId, resId, slot) {
  const inp = $(inputId), ac = $(acId), clr = $(clearId), res = $(resId);
  let items = [], sel = -1;

  function close() { ac.className = 'ac'; inp.setAttribute('aria-expanded', 'false'); sel = -1; }

  function paint() {
    const q = inp.value.trim();
    clr.classList.toggle('on', q.length > 0);
    if (q.length < 1) { close(); ac.innerHTML = ''; return; }
    items = suggest(q, 8);
    if (!items.length) {
      ac.innerHTML = `<div class="ac-empty">Aucun pays, ville ou aéroport ne correspond à « ${esc(q)} ».</div>`;
      ac.className = 'ac on'; inp.setAttribute('aria-expanded', 'true');
      return;
    }
    const icon = { country: '🌍', city: '🏙', airport: '✈' };
    const cls = { country: 'c', city: 'v', airport: 'a' };
    ac.innerHTML = items.map((o, i) => `<button class="ac-item${i === sel ? ' sel' : ''}" type="button" role="option"
       aria-selected="${i === sel}" data-i="${i}">
      <span class="ac-ic ${cls[o.type]}" aria-hidden="true">${icon[o.type]}</span>
      <span class="ac-main"><span class="ac-t">${esc(o.title)}</span><span class="ac-s">${esc(o.sub)}</span></span>
      <span class="ac-n">${esc(o.badge)}</span></button>`).join('');
    ac.className = 'ac on'; inp.setAttribute('aria-expanded', 'true');
    ac.querySelectorAll('[data-i]').forEach(b => b.onclick = () => choose(items[+b.dataset.i]));
  }

  function choose(o) {
    if (!o) return;
    S[slot] = o.resolved;
    inp.value = o.resolved.kind === 'airport'
      ? `${o.resolved.label} (${o.resolved.code})`
      : o.resolved.label;
    inp.classList.add('ok');
    showRes();
    close();
    if (slot === 'from') $('to').focus();
  }

  function showRes() {
    const r = S[slot];
    if (!r) { res.className = 'res'; return; }
    if (r.kind === 'country') {
      const list = r.aps.slice(0, 6).join(', ') + (r.aps.length > 6 ? `, +${r.aps.length - 6}` : '');
      res.innerHTML = `<b>${r.aps.length} aéroport${r.aps.length > 1 ? 's' : ''}</b> : ${esc(list)}`;
      res.className = 'res on';
    } else if (r.kind === 'city' && r.aps.length > 1) {
      res.innerHTML = `<b>${r.aps.length} aéroports</b> : ${esc(r.aps.join(', '))}`;
      res.className = 'res on';
    } else {
      res.innerHTML = `Aéroport <b>${esc(r.aps[0])}</b>`;
      res.className = 'res on';
    }
  }

  inp.addEventListener('input', () => { S[slot] = null; inp.classList.remove('ok'); res.className = 'res'; paint(); });
  inp.addEventListener('focus', () => { if (inp.value.trim()) paint(); });
  inp.addEventListener('blur', () => setTimeout(() => {
    close();
    /* saisie libre validée au flou : on résout au mieux */
    if (!S[slot] && inp.value.trim()) {
      const r = resolve(inp.value);
      if (r) { S[slot] = r; inp.value = r.kind === 'airport' ? `${r.label} (${r.code})` : r.label; inp.classList.add('ok'); showRes(); }
    }
  }, 170));
  inp.addEventListener('keydown', e => {
    if (!items.length || ac.className.indexOf('on') < 0) {
      if (e.key === 'Enter' && inp.value.trim()) { const r = resolve(inp.value); if (r) choose({ resolved: r }); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); ac.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); ac.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[sel >= 0 ? sel : 0]); }
    else if (e.key === 'Escape') { close(); }
  });
  clr.onclick = () => { inp.value = ''; S[slot] = null; inp.classList.remove('ok'); res.className = 'res'; clr.classList.remove('on'); close(); inp.focus(); };

  return { set(r) { S[slot] = r; inp.value = r ? (r.kind === 'airport' ? `${r.label} (${r.code})` : r.label) : ''; inp.classList.toggle('ok', !!r); showRes(); clr.classList.toggle('on', !!r); } };
}

const fieldFrom = setupField('from', 'acFrom', 'xFrom', 'resFrom', 'from');
const fieldTo = setupField('to', 'acTo', 'xTo', 'resTo', 'to');

/* ---------- Rendu ---------- */
function progress(f) {
  if (!isDate(f.depAbs) || !isDate(f.arrAbs) || f.status === 'cancelled') return 0;
  const now = Date.now(), a = f.depAbs.getTime(), b = f.arrAbs.getTime();
  if (now <= a) return 0;
  if (now >= b) return 1;
  return (now - a) / (b - a);
}
function arcSVG(f, i) {
  const p = progress(f), W = 280, H = 64, y = 48;
  const path = `M12,${y} Q${W / 2},4 ${W - 12},${y}`;
  const flying = p > 0 && p < 1;
  return `<svg class="arc" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
<defs><linearGradient id="g${i}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--cyan)"/></linearGradient></defs>
<path d="${path}" class="arc-bg"/>
<path d="${path}" class="arc-fg" stroke="url(#g${i})" pathLength="1" style="stroke-dasharray:1;stroke-dashoffset:${1 - p}"/>
<circle class="arc-dot" cx="12" cy="${y}" r="3.5"/><circle class="arc-dot" cx="${W - 12}" cy="${y}" r="3.5"/>
<g class="arc-plane${flying ? ' flying' : ''}" style="offset-path:path('${path}');offset-distance:${(p * 100).toFixed(2)}%"><text y="4" text-anchor="middle" font-size="15">✈</text></g></svg>`;
}
function statusPill(f) {
  if (!f.live) return `<span class="st s-sched">Horaire théorique</span>`;
  const st = f.status || 'scheduled';
  let txt = STATUS_FR[st] || 'Prévu';
  if (st === 'delayed' && f.delay) txt = `Retard ${f.delay} min`;
  const dot = st === 'departed' ? '<span class="pdot"></span>' : '';
  return `<span class="st ${STATUS_CLASS[st] || 's-sched'}">${dot}${esc(txt)}</span>`;
}
function timeCell(f, side) {
  const min = side === 'dep' ? f.depMin : f.arrMin;
  const sched = side === 'dep' ? f.schedDep : f.schedArr;
  const act = side === 'dep' ? f.depAbs : f.arrAbs;
  const late = f.live && isDate(sched) && isDate(act) && Math.abs(act - sched) >= 60000;
  const tz = side === 'dep' ? f.tzDep : f.tzArr;
  return `<div class="t-main" style="${late ? 'color:var(--gold)' : ''}">${min == null ? '--:--' : fmtHM(min)}<span class="ap-tz">${esc(tz || '')}</span></div>`;
}

function cardHTML(f, i) {
  const cells = [];
  if (f.gate) cells.push(['Porte', f.gate]);
  if (f.td) cells.push(['Terminal dép.', f.td]);
  if (f.ta) cells.push(['Terminal arr.', f.ta]);
  if (f.belt) cells.push(['Tapis', f.belt]);
  if (f.ac) cells.push(['Appareil', f.ac]);
  if (f.dur) cells.push(['Durée', fmtDur(f.dur)]);
  return `<article class="fc" style="--i:${Math.min(i, 8)}" aria-label="Vol ${esc(f.num)} ${esc(f.depCity)} vers ${esc(f.arrCity)}">
<div class="fc-head">
  <div class="fc-left"><span class="fc-num">${esc(f.num)}</span><span class="fc-co">${esc(f.airline || '')}</span></div>
  <div class="fc-act">${statusPill(f)}</div>
</div>
<div class="fc-route">
  <div class="ap">
    <div class="ap-code">${esc(f.depIata)}</div>
    <div class="ap-city">${esc(f.depCity)}</div>
    <div class="ap-ap">${esc(f.depName)}</div>
    ${timeCell(f, 'dep')}
  </div>
  <div class="mid">
    ${arcSVG(f, i)}
    <div class="mdur">${f.dur ? fmtDur(f.dur) : ''}</div>
    <div class="mkm">${f.dist ? f.dist.toLocaleString('fr-FR') + ' km' : ''}</div>
  </div>
  <div class="ap r">
    <div class="ap-code">${esc(f.arrIata)}</div>
    <div class="ap-city">${esc(f.arrCity)}</div>
    <div class="ap-ap">${esc(f.arrName)}</div>
    ${timeCell(f, 'arr')}
    ${f.dayShift > 0 ? `<div class="nextday">+${f.dayShift} jour${f.dayShift > 1 ? 's' : ''}</div>` : ''}
  </div>
</div>
${cells.length ? `<div class="fc-dets">${cells.map(([l, v]) => `<div><div class="dl">${esc(l)}</div><div class="dv">${esc(v)}</div></div>`).join('')}</div>` : ''}
<div class="fc-links">
  <a class="lb p" href="${faUrl(f.num)}" target="_blank" rel="noopener noreferrer">Statut en direct<span class="sr-only"> (nouvel onglet)</span></a>
  <a class="lb" href="${fr24Url(f.num)}" target="_blank" rel="noopener noreferrer">FR24<span class="sr-only"> (nouvel onglet)</span></a>
  <button class="lb" type="button" data-copy="${esc(f.num)}">Copier</button>
</div></article>`;
}

function skeleton(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += `<div class="sk" style="--i:${i}">
    <div class="sk-row"><div class="sk-b w80"></div><div class="sk-b w50"></div></div>
    <div class="sk-route"><div class="sk-b w60 tall"></div><div class="sk-b w100"></div><div class="sk-b w60 tall"></div></div>
    <div class="sk-row"><div class="sk-b w40"></div><div class="sk-b w40"></div><div class="sk-b w40"></div></div></div>`;
  return s;
}

function kindWord(r) { return r.kind === 'country' ? 'pays' : r.kind === 'city' ? 'ville' : 'aéroport'; }

function render() {
  const out = $('out');
  if (!S.flights.length) { out.innerHTML = emptyHTML(); wire(); return; }

  const srcTag = S.source === 'live'
    ? `<span class="tag tag-l"><span class="pdot"></span>Vols réels du jour</span>`
    : `<span class="tag tag-w">Base embarquée · horaires théoriques</span>`;

  let html = `<div class="ctx">
    <b>${esc(S.from.label)}</b> → <b>${esc(S.to.label)}</b>
    <div class="ctx-meta">
      ${srcTag}
      <span class="tag tag-d">📅 ${esc(longDate(S.date))}</span>
      <span class="tag tag-d">${S.from.aps.length}×${S.to.aps.length} aéroports balayés</span>
    </div></div>`;

  const list = S.sort === 'dur'
    ? S.flights.slice().sort((a, b) => (a.dur || 1e9) - (b.dur || 1e9))
    : S.flights;
  const slice = list.slice(0, S.shown);

  html += `<div class="toolbar">
    <span class="count"><b>${list.length}</b> vol${list.length > 1 ? 's' : ''} trouvé${list.length > 1 ? 's' : ''}</span>
    <div class="sorts" role="group" aria-label="Trier">
      <button class="sort-b" type="button" data-sort="dep" aria-pressed="${S.sort === 'dep'}">Heure</button>
      <button class="sort-b" type="button" data-sort="dur" aria-pressed="${S.sort === 'dur'}">Durée</button>
    </div></div>`;

  html += slice.map((f, i) => cardHTML(f, i)).join('');
  if (S.shown < list.length)
    html += `<button class="more" type="button" id="moreBtn">Afficher ${Math.min(PAGE, list.length - S.shown)} vol(s) de plus</button>`;

  if (S.source !== 'live') {
    html += `<div class="note"><b>Horaires théoriques.</b> Ils viennent de la base embarquée : ni retards, ni annulations, ni portes. Le bouton <b>Statut en direct</b> ouvre FlightAware.`
      + (CFG.ready() && (S.from.aps.length > API_MAX_AIRPORTS || S.to.aps.length > API_MAX_AIRPORTS)
        ? ` Une recherche large (${S.from.aps.length}×${S.to.aps.length} aéroports) n'interroge pas le fournisseur : précisez une ville ou un aéroport pour obtenir les vols réels.` : '')
      + `</div>`;
  }
  out.innerHTML = html;
  wire();
}

function emptyHTML() {
  const e = S.error;
  if (e) {
    const M = {
      auth: "Le fournisseur a rejeté la clé. Vérifiez-la dans les réglages, et qu'elle est bien abonnée à l'API.",
      quota: 'Le quota du fournisseur est atteint.',
      cors: "La requête n'a pas abouti : le fournisseur refuse les appels directs depuis un navigateur, ou impose HTTP alors que la page est en HTTPS. Le proxy règle les deux cas.",
      offline: 'Aucune connexion.',
      timeout: 'Le fournisseur a mis plus de 12 secondes à répondre.',
      http: `Réponse HTTP ${esc(e.status || '')}.`,
      api: esc(e.message || '')
    };
    return `<div class="empty"><div class="empty-ic">⚠</div>
      <div class="empty-t">${esc(errLabel(e.reason))}</div>
      <div class="empty-d">${M[e.reason] || ''}</div>
      <div class="ex-list">
        <button class="ex" type="button" id="openCfg">⚙ Ouvrir les réglages</button>
        <button class="ex" type="button" id="useLocal">📦 Chercher dans la base embarquée</button>
      </div></div>`;
  }

  const alt = (S.from && S.to) ? alternatives(S.from, S.to) : { reverse: 0, top: [] };
  let acts = '';
  if (alt.reverse) acts += `<button class="ex" type="button" id="revBtn">⇅ ${alt.reverse} vol(s) existent dans l'autre sens : <b>${esc(S.to.label)} → ${esc(S.from.label)}</b></button>`;
  if (alt.top.length) acts += alt.top.slice(0, 4).map(t =>
    `<button class="ex" type="button" data-dest="${esc(t.cc)}">Depuis <b>${esc(S.from.label)}</b>, vers <b>${esc(t.name)}</b> · ${t.n} vols</button>`).join('');
  acts += `<a class="ex" href="${S.from && S.to ? faRoute(S.from.aps[0], S.to.aps[0]) : 'https://www.flightaware.com/live/findflight/'}" target="_blank" rel="noopener noreferrer">🔍 Chercher sur <b>FlightAware</b></a>`;

  return `<div class="empty"><div class="empty-ic">🧭</div>
    <div class="empty-t">Aucun vol direct</div>
    <div class="empty-d">La base ne contient aucun vol sans escale entre
      <b>${esc(S.from ? S.from.label : '')}</b> (${S.from ? S.from.aps.length : 0} aéroport${S.from && S.from.aps.length > 1 ? 's' : ''})
      et <b>${esc(S.to ? S.to.label : '')}</b> (${S.to ? S.to.aps.length : 0} aéroport${S.to && S.to.aps.length > 1 ? 's' : ''}).
      La liaison existe peut-être avec escale.</div>
    <div class="ex-list">${acts}</div></div>`;
}

function wire() {
  const out = $('out');
  out.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => { S.sort = b.dataset.sort; render(); });
  const mb = $('moreBtn');
  if (mb) mb.onclick = () => { S.shown = Math.min(S.shown + PAGE, S.flights.length); render(); };
  const rb = $('revBtn');
  if (rb) rb.onclick = () => { swap(); go(); };
  const oc = $('openCfg'); if (oc) oc.onclick = openCfg;
  const ul = $('useLocal'); if (ul) ul.onclick = () => { S.error = null; runLocal(); render(); };
  out.querySelectorAll('[data-dest]').forEach(b => b.onclick = () => {
    const cc = b.dataset.dest, c = CTY[cc];
    if (!c) return;
    fieldTo.set({ kind: 'country', label: c.name, code: cc, aps: c.aps.slice(), cc });
    go();
  });
  out.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    const f = S.flights.find(x => x.num === b.dataset.copy); if (!f) return;
    const t = `${f.num} — ${f.depIata} ${fmtHM(f.depMin)} → ${f.arrIata} ${fmtHM(f.arrMin)}${f.dayShift > 0 ? ' +' + f.dayShift + 'j' : ''}${f.dur ? ' · ' + fmtDur(f.dur) : ''}`;
    try { await navigator.clipboard.writeText(t); b.textContent = 'Copié ✓'; } catch (e) { b.textContent = 'Échec'; }
    setTimeout(() => b.textContent = 'Copier', 1600);
  });
}

function toast(m) {
  const t = $('toast'); t.textContent = m; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 4200);
}

/* ---------- Recherche ---------- */
let busy = false;
function runLocal() {
  S.flights = search(S.from, S.to, S.date);
  S.source = 'local';
  S.shown = Math.min(PAGE, S.flights.length);
}

async function go() {
  if (busy) return;
  if (!S.from) { toast('Choisissez un départ'); $('from').focus(); return; }
  if (!S.to) { toast('Choisissez une arrivée'); $('to').focus(); return; }
  const d = parseYmd($('date').value);
  if (!d) { toast('Choisissez une date'); $('date').focus(); return; }
  S.date = d; S.error = null; S.sort = 'dep';

  busy = true;
  const btn = $('btn'), out = $('out');
  btn.disabled = true; btn.classList.add('loading');

  const broad = S.from.aps.length > API_MAX_AIRPORTS || S.to.aps.length > API_MAX_AIRPORTS;
  if (CFG.ready() && !broad) {
    out.innerHTML = `<div class="phase"><span class="ph-dot"></span>Interrogation ${esc(PROVIDERS[CFG.provider()].label)}…</div>` + skeleton(3);
    const r = await fetchLive(S.from, S.to, S.date);
    if (r.ok && r.flights.length) {
      S.flights = r.flights; S.source = 'live'; S.req = r.req;
      S.shown = Math.min(PAGE, r.flights.length);
      finish(); return;
    }
    if (!r.ok && r.reason !== 'off' && r.reason !== 'too-broad') {
      runLocal();
      if (S.flights.length) { toast(errLabel(r.reason) + ' — repli sur la base embarquée'); }
      else { S.error = { reason: r.reason, status: r.status, message: r.message }; }
      finish(); return;
    }
  }

  if (!reduced()) {
    out.innerHTML = `<div class="phase"><span class="ph-dot"></span>Recherche dans la base…</div>` + skeleton(2);
    await new Promise(r => setTimeout(r, 220));
  }
  runLocal();
  finish();

  function finish() {
    render();
    pushRecent();
    busy = false; btn.disabled = false; btn.classList.remove('loading');
    try {
      const p = new URLSearchParams({ from: S.from.code, to: S.to.code, date: ymd(S.date) });
      history.replaceState(null, '', '?' + p);
    } catch (e) { }
    requestAnimationFrame(() => { try { out.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); } catch (e) { } });
  }
}

function swap() {
  const a = S.from, b = S.to;
  fieldFrom.set(b); fieldTo.set(a);
}

/* ---------- Récents ---------- */
function pushRecent() {
  let r = [];
  try { r = JSON.parse(safeGet('ss3_recent') || '[]'); } catch (e) { }
  const entry = { f: S.from.code, fk: S.from.kind, fl: S.from.label, t: S.to.code, tk: S.to.kind, tl: S.to.label };
  r = [entry, ...r.filter(x => !(x.f === entry.f && x.t === entry.t))].slice(0, 6);
  safeSet('ss3_recent', JSON.stringify(r));
  paintRecent();
}
function fromStored(code, kind) {
  if (kind === 'country' && CTY[code]) { const c = CTY[code]; return { kind: 'country', label: c.name, code, aps: c.aps.slice(), cc: code }; }
  if (kind === 'city') { const k = Object.keys(CITY).find(k2 => CITY[k2].aps[0] === code); if (k) { const c = CITY[k]; return { kind: 'city', label: c.city, code, aps: c.aps.slice(), cc: c.cc }; } }
  if (AP[code]) { const a = AP[code]; return { kind: 'airport', label: `${a.c} ${a.n}`, code, aps: [code], cc: a.cc }; }
  return null;
}
function paintRecent() {
  let r = [];
  try { r = JSON.parse(safeGet('ss3_recent') || '[]'); } catch (e) { }
  const wrap = $('recentWrap'), box = $('recent');
  if (!r.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  box.innerHTML = r.map((x, i) => `<button class="chip" type="button" data-r="${i}">${esc(x.fl)} → ${esc(x.tl)}</button>`).join('')
    + `<button class="chip chip-x" type="button" id="clrRecent">Effacer</button>`;
  box.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
    const x = r[+b.dataset.r];
    const f = fromStored(x.f, x.fk), t = fromStored(x.t, x.tk);
    if (f && t) { fieldFrom.set(f); fieldTo.set(t); go(); }
  });
  $('clrRecent').onclick = () => { safeSet('ss3_recent', '[]'); paintRecent(); };
}

/* ---------- Réglages ---------- */
function openCfg() {
  const c = CFG.get();
  $('cfgProvider').value = c.provider || 'local';
  $('cfgKey').value = c.key || '';
  $('cfgProxy').value = c.proxy || '';
  syncCfg(); $('cfgResult').hidden = true;
  $('cfg').classList.add('on'); $('cfg').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('cfgProvider').focus(), 60);
}
function closeCfg() { $('cfg').classList.remove('on'); $('cfg').setAttribute('aria-hidden', 'true'); }
function syncCfg() {
  const p = $('cfgProvider').value, def = PROVIDERS[p], local = p === 'local';
  $('cfgFields').hidden = local;
  $('cfgLocalNote').hidden = !local;
  $('cfgLocalNote').textContent = `${FL.length.toLocaleString('fr-FR')} vols, ${APL.length} aéroports, ${Object.keys(CTY).length} pays. Aucun appel réseau : horaires théoriques, sans retard ni porte.`;
  if (def) {
    $('cfgKeyLabel').textContent = def.keyLabel || 'Clé API';
    $('cfgSignup').href = def.signup || '#';
    $('cfgDoc').href = def.doc || '#';
    $('cfgNote').textContent = def.note || '';
    $('cfgNote').hidden = !def.note;
  }
}
function saveCfg() {
  const p = $('cfgProvider').value;
  CFG.set({ provider: p, key: $('cfgKey').value.trim(), proxy: $('cfgProxy').value.trim() });
  mem.clear(); paintStatus(); closeCfg();
  toast(p === 'local' ? 'Base embarquée uniquement' : `${PROVIDERS[p].label} configuré`);
  if (S.from && S.to) go();
}
async function testCfg() {
  const b = $('cfgTest'); b.disabled = true; b.textContent = 'Test…';
  const saved = CFG.get();
  CFG.set({ provider: $('cfgProvider').value, key: $('cfgKey').value.trim(), proxy: $('cfgProxy').value.trim() });
  const probe = { aps: ['CDG'] }, dest = { aps: ['JFK', 'LHR', 'MAD', 'FCO', 'AMS'] };
  const r = await fetchLive(probe, dest, new Date());
  CFG.set(saved);
  b.disabled = false; b.textContent = 'Tester la clé';
  const box = $('cfgResult'); box.hidden = false;
  if (r.ok) { box.className = 'cfg-res ok'; box.textContent = `Connexion réussie. ${r.flights.length} vol(s) correspondant au test.`; }
  else { box.className = 'cfg-res ko'; box.textContent = errLabel(r.reason) + (r.status ? ` (HTTP ${r.status})` : '') + (r.message ? ` — ${r.message}` : ''); }
}
function paintStatus() {
  const p = $('statusPill'), t = $('statusTxt');
  if (!navigator.onLine) { p.className = 'pill pill-off'; t.textContent = 'Hors ligne'; return; }
  if (CFG.ready()) { p.className = 'pill pill-live'; t.textContent = PROVIDERS[CFG.provider()].label; }
  else { p.className = 'pill pill-db'; t.textContent = `${FL.length.toLocaleString('fr-FR')} vols`; }
}

/* ---------- Initialisation ---------- */
(function stars() {
  if (reduced()) return;
  const s = $('starsEl'), fr = document.createDocumentFragment();
  for (let i = 0; i < 55; i++) {
    const el = document.createElement('div'), sz = Math.random() < .8 ? 1 : 2;
    el.className = 'star';
    el.style.cssText = `width:${sz}px;height:${sz}px;left:${Math.random() * 100}%;top:${Math.random() * 100}%;opacity:0;animation:blink ${2 + Math.random() * 4}s ease-in-out ${-Math.random() * 6}s infinite`;
    fr.appendChild(el);
  }
  s.appendChild(fr);
})();

$('date').value = ymd(new Date());
$('date').min = ymd(new Date(Date.now() - 86400000 * 2));
$('form').addEventListener('submit', e => { e.preventDefault(); go(); });
$('swapBtn').onclick = swap;
document.querySelectorAll('#chips [data-f]').forEach(b => b.onclick = () => {
  const f = resolve(b.dataset.f), t = resolve(b.dataset.t);
  if (f && t) { fieldFrom.set(f); fieldTo.set(t); go(); }
});
$('cfgBtn').onclick = openCfg;
$('cfgClose').onclick = closeCfg;
$('cfgSave').onclick = saveCfg;
$('cfgTest').onclick = testCfg;
$('cfgProvider').onchange = () => { syncCfg(); $('cfgResult').hidden = true; };
$('cfg').addEventListener('click', e => { if (e.target === $('cfg')) closeCfg(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('cfg').classList.contains('on')) closeCfg(); });

paintRecent(); paintStatus();
window.addEventListener('online', paintStatus);
window.addEventListener('offline', paintStatus);

/* Lien profond : ?from=FR&to=GR&date=2026-10-05 */
(function deepLink() {
  try {
    const p = new URLSearchParams(location.search);
    const f = p.get('from'), t = p.get('to'), d = p.get('date');
    if (!f || !t) return;
    const rf = resolve(f), rt = resolve(t);
    if (!rf || !rt) return;
    fieldFrom.set(rf); fieldTo.set(rt);
    if (d && parseYmd(d)) $('date').value = d;
    go();
  } catch (e) { }
})();

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredPrompt = e;
  if (safeGet('ss3_install_hidden')) return;
  $('installTxt').innerHTML = 'Installez SkySearch pour un accès hors ligne.';
  $('installBtn').hidden = false; $('installBanner').classList.add('on');
});
$('installBtn').onclick = async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt(); await deferredPrompt.userChoice;
  deferredPrompt = null; $('installBanner').classList.remove('on');
};
$('installClose').onclick = () => { $('installBanner').classList.remove('on'); safeSet('ss3_install_hidden', '1'); };
(function iosBanner() {
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !isStandalone() && !safeGet('ss3_install_hidden')) {
    $('installTxt').innerHTML = "Installer : <b>Partager ↑</b> puis <b>Sur l'écran d'accueil</b>";
    $('installBanner').classList.add('on');
  }
})();

if ('serviceWorker' in navigator)
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => { }));
