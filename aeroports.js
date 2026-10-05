/* Page « Aéroports » : table filtrable construite depuis data.js.
   Pas de framework, juste un filtre sur une table rendue une fois. */
'use strict';

const D = window.SKYDATA;
const TZ = D.tz;

const APS = D.aps.split('\n').map((line, i) => {
  const [iata, city, name, cc, la, lo, tzi, rk] = line.split('|');
  return { i: iata, c: city, n: name, cc, z: TZ[+tzi], r: +rk, x: i };
});

const CTY = {};
D.cty.split('\n').forEach(line => {
  const [cc, name, aliases] = line.split('|');
  CTY[cc] = { name, alias: aliases ? aliases.split(';') : [] };
});

/* Comptage des départs et arrivées par aéroport */
const dep = new Int32Array(APS.length), arr = new Int32Array(APS.length);
let nFlights = 0;
D.fls.split('\n').forEach(line => {
  const p = line.split('|');
  dep[+p[1]]++; arr[+p[2]]++; nFlights++;
});

const deacc = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = s => deacc(String(s || '').toLowerCase().trim());
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const rows = APS.map(a => ({
  ...a,
  country: CTY[a.cc] ? CTY[a.cc].name : a.cc,
  dep: dep[a.x], arr: arr[a.x],
  hay: norm([a.i, a.c, a.n, CTY[a.cc] ? CTY[a.cc].name : a.cc,
    ...(CTY[a.cc] ? CTY[a.cc].alias : [])].join(' '))
}));

let sortKey = 'country', sortDir = 1;

function compare(a, b) {
  let v;
  if (sortKey === 'dep') v = a.dep - b.dep;
  else if (sortKey === 'iata') v = a.i.localeCompare(b.i);
  else if (sortKey === 'city') v = a.c.localeCompare(b.c, 'fr');
  else v = a.country.localeCompare(b.country, 'fr') || a.r - b.r || a.c.localeCompare(b.c, 'fr');
  return v * sortDir;
}

function paint() {
  const q = norm(document.getElementById('filter').value);
  const list = (q ? rows.filter(r => r.hay.includes(q)) : rows).slice().sort(compare);

  document.getElementById('count').textContent = q
    ? `${list.length} aéroport${list.length > 1 ? 's' : ''} sur ${rows.length}`
    : `${rows.length} aéroports dans ${Object.keys(CTY).length} pays, ${nFlights.toLocaleString('fr-FR')} vols`;

  const tb = document.getElementById('tbody');
  if (!list.length) {
    tb.innerHTML = `<tr><td colspan="5" style="color:var(--text3);padding:1rem 0">
      Aucun aéroport ne correspond. Essayez un code IATA, une ville ou un pays.</td></tr>`;
    return;
  }

  tb.innerHTML = list.map(r => `<tr>
    <td class="code">${esc(r.i)}</td>
    <td>${esc(r.c)}${r.n && r.n !== r.c ? `<br><span class="apn">${esc(r.n)}</span>` : ''}</td>
    <td>${esc(r.country)}</td>
    <td class="num">${r.dep}</td>
    <td class="num opt">${r.arr}</td>
  </tr>`).join('');
}

document.querySelectorAll('th[data-k]').forEach(th => {
  th.style.cursor = 'pointer';
  th.onclick = () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir = -sortDir;
    else { sortKey = k; sortDir = (k === 'dep') ? -1 : 1; }
    document.querySelectorAll('th[data-k]').forEach(x => x.removeAttribute('aria-sort'));
    th.setAttribute('aria-sort', sortDir === 1 ? 'ascending' : 'descending');
    paint();
  };
});

document.getElementById('filter').addEventListener('input', paint);
document.getElementById('clear').onclick = () => {
  document.getElementById('filter').value = '';
  paint();
  document.getElementById('filter').focus();
};

/* Pré-filtrage par lien : aeroports.html?q=France */
(function () {
  try {
    const q = new URLSearchParams(location.search).get('q');
    if (q) document.getElementById('filter').value = q;
  } catch (e) { }
})();

paint();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => { }));
}
