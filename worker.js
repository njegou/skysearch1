/**
 * SkySearch — proxy Cloudflare Worker
 * ============================================================
 * Deux rôles distincts.
 *
 * 1. RELAIS pour les fournisseurs d'horaires (AeroDataBox, Aviationstack).
 *    Garde la clé côté serveur, ajoute les en-têtes CORS manquants, et
 *    réécrit en HTTPS les fournisseurs qui n'exposent que HTTP en gratuit.
 *    Optionnel : chaque utilisateur peut aussi saisir sa propre clé dans
 *    le navigateur.
 *
 * 2. PRIX via SerpApi (Google Flights). Celui-ci n'est PAS optionnel :
 *    SerpApi ne peut pas être appelé depuis un navigateur, et son offre
 *    gratuite plafonne à 250 requêtes par mois. Une clé exposée côté client
 *    serait vidée en quelques minutes. Le Worker est le seul chemin.
 *
 * Déploiement :
 *   npm i -g wrangler
 *   wrangler init skysearch-proxy     (remplacer src/index.js par ce fichier)
 *   wrangler secret put SERPAPI_KEY
 *   wrangler secret put AERODATABOX_KEY      (si vous utilisez les horaires)
 *   wrangler secret put AVIATIONSTACK_KEY    (idem)
 *   wrangler kv namespace create SKYCACHE
 *   # reporter l'id affiché dans wrangler.toml :
 *   #   [[kv_namespaces]]
 *   #   binding = "SKYCACHE"
 *   #   id = "..."
 *   wrangler deploy
 *
 * Puis coller l'URL du Worker dans SkySearch, Source des données, Proxy.
 *
 * Sans binding KV le Worker fonctionne quand même, en se rabattant sur le
 * cache d'arête de Cloudflare. Le compteur de quota est alors inopérant :
 * déployez le KV si vous tenez à protéger vos 250 requêtes.
 */

/* ---------- Réglages ---------- */

const ALLOWED_HOSTS = new Set([
  'aerodatabox.p.rapidapi.com',
  'api.aviationstack.com'
]);

/* Mettez votre domaine ici en production, par exemple
   ['https://njegou.github.io']. '*' laisse n'importe quel site
   consommer votre quota. */
const ALLOWED_ORIGINS = ['*'];

const SCHEDULE_TTL = 60;          // horaires : secondes
const PRICE_TTL = 86400;          // prix : 24 heures
const PRICE_MONTHLY_CAP = 220;    // marge sous les 250 gratuites de SerpApi

/* ---------- Utilitaires ---------- */

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

const json = (obj, status, origin, extra) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...(extra || {}) }
  });

const IATA = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- Compteur mensuel ----------
   Protège l'offre gratuite : sans lui, un robot vide le quota du mois
   en une poignée de minutes. Repose sur KV ; sans KV, pas de garde-fou. */

async function quotaCheck(env) {
  if (!env.SKYCACHE) return { ok: true, used: null, cap: PRICE_MONTHLY_CAP, guarded: false };
  const key = 'quota:' + new Date().toISOString().slice(0, 7);   // quota:2026-10
  const used = parseInt(await env.SKYCACHE.get(key) || '0', 10);
  return { ok: used < PRICE_MONTHLY_CAP, used, cap: PRICE_MONTHLY_CAP, guarded: true, key };
}

async function quotaBump(env, q) {
  if (!env.SKYCACHE || !q.guarded) return;
  /* 40 jours de rétention : la clé du mois suivant prend le relais seule. */
  await env.SKYCACHE.put(q.key, String((q.used || 0) + 1), { expirationTtl: 60 * 60 * 24 * 40 });
}

/* ---------- Normalisation SerpApi ----------
   La réponse brute de SerpApi pèse plusieurs centaines de kilo-octets.
   On ne renvoie au navigateur que ce que SkySearch affiche. */

function normalizePrices(raw, currency) {
  const best = Array.isArray(raw.best_flights) ? raw.best_flights : [];
  const other = Array.isArray(raw.other_flights) ? raw.other_flights : [];
  const all = best.concat(other);

  const options = all.slice(0, 12).map(it => {
    const legs = Array.isArray(it.flights) ? it.flights : [];
    const first = legs[0] || {};
    const last = legs[legs.length - 1] || {};
    return {
      price: typeof it.price === 'number' ? it.price : null,
      stops: Math.max(0, legs.length - 1),
      duration: it.total_duration || null,
      airline: first.airline || null,
      /* SerpApi écrit « AF 1680 » : on compacte pour comparer aux numéros
         affichés par SkySearch. */
      numbers: legs.map(l => String(l.flight_number || '').replace(/\s+/g, '')).filter(Boolean),
      depTime: (first.departure_airport && first.departure_airport.time) || null,
      arrTime: (last.arrival_airport && last.arrival_airport.time) || null
    };
  }).filter(o => o.price != null);

  /* cheapest porte sur TOUTES les options, escales comprises ; cheapestDirect
     sur les seuls vols sans escale. SkySearch n'affiche que du direct, mais
     signaler qu'une escale coûte nettement moins cher reste une information
     utile, à condition de l'étiqueter. */
  const direct = options.filter(o => o.stops === 0);
  const low = options.length ? Math.min(...options.map(o => o.price)) : null;

  const ins = raw.price_insights || {};
  return {
    currency: currency || raw.search_parameters && raw.search_parameters.currency || 'EUR',
    cheapest: low,
    cheapestDirect: direct.length ? Math.min(...direct.map(o => o.price)) : null,
    typical: Array.isArray(ins.typical_price_range) ? ins.typical_price_range : null,
    level: ins.price_level || null,          // low | typical | high
    options,
    googleUrl: raw.search_metadata && raw.search_metadata.google_flights_url || null
  };
}

/* ---------- Point d'entrée ---------- */

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET')
      return json({ error: { message: 'Méthode non autorisée' } }, 405, origin);

    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];

    if (route === 'serpapi') return handlePrices(url, env, ctx, origin);
    if (route === 'health') {
      const q = await quotaCheck(env);
      return json({
        ok: true,
        serpapi: !!env.SERPAPI_KEY,
        aerodatabox: !!env.AERODATABOX_KEY,
        aviationstack: !!env.AVIATIONSTACK_KEY,
        kv: !!env.SKYCACHE,
        quota: q.guarded ? { used: q.used, cap: q.cap } : null
      }, 200, origin);
    }
    return handleSchedules(route, url, env, ctx, origin);
  }
};

/* ---------- Prix ---------- */

async function handlePrices(url, env, ctx, origin) {
  if (!env.SERPAPI_KEY)
    return json({ error: { code: 'no-key', message: 'SERPAPI_KEY non configurée sur le Worker' } }, 500, origin);

  const from = (url.searchParams.get('from') || '').toUpperCase();
  const to = (url.searchParams.get('to') || '').toUpperCase();
  const date = url.searchParams.get('date') || '';
  const currency = (url.searchParams.get('currency') || 'EUR').toUpperCase();

  /* Validation stricte : ces paramètres partent dans une requête payée.
     On refuse tout ce qui n'est pas exactement un couple d'aéroports
     et une date, plutôt que de gaspiller une requête. */
  if (!IATA.test(from) || !IATA.test(to) || from === to)
    return json({ error: { code: 'bad-params', message: 'Codes IATA invalides' } }, 400, origin);
  if (!DATE.test(date))
    return json({ error: { code: 'bad-params', message: 'Date invalide' } }, 400, origin);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const asked = new Date(date + 'T00:00:00Z');
  const days = Math.round((asked - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  if (isNaN(days) || days < 0 || days > 330)
    return json({ error: { code: 'bad-date', message: 'Date hors plage réservable' } }, 400, origin);

  const cacheKey = `price:${from}:${to}:${date}:${currency}`;

  /* 1. Cache KV. C'est lui qui rend les 250 requêtes mensuelles tenables :
     une route consultée vingt fois dans la journée ne coûte qu'une requête. */
  if (env.SKYCACHE) {
    const hit = await env.SKYCACHE.get(cacheKey);
    if (hit) return json(JSON.parse(hit), 200, origin, { 'X-SkySearch-Cache': 'HIT' });
  }

  /* 2. Garde-fou de quota. */
  const q = await quotaCheck(env);
  if (!q.ok) {
    return json({
      error: {
        code: 'quota',
        message: `Plafond mensuel atteint (${q.used}/${q.cap}). Il se réinitialise le 1er du mois.`
      }
    }, 429, origin);
  }

  /* 3. Appel réel. */
  const api = new URL('https://serpapi.com/search.json');
  api.searchParams.set('engine', 'google_flights');
  api.searchParams.set('departure_id', from);
  api.searchParams.set('arrival_id', to);
  api.searchParams.set('outbound_date', date);
  api.searchParams.set('type', '2');            // aller simple
  api.searchParams.set('currency', currency);
  api.searchParams.set('hl', 'fr');
  api.searchParams.set('gl', 'fr');
  api.searchParams.set('api_key', env.SERPAPI_KEY);

  let upstream, raw;
  try {
    upstream = await fetch(api.toString(), { signal: AbortSignal.timeout(20000) });
    raw = await upstream.json();
  } catch (e) {
    return json({ error: { code: 'upstream', message: 'SerpApi injoignable : ' + e.message } }, 502, origin);
  }

  if (!upstream.ok || raw.error) {
    const msg = raw && raw.error ? raw.error : `HTTP ${upstream.status}`;
    /* Une erreur ne consomme pas le quota SerpApi : on ne l'incrémente pas. */
    return json({ error: { code: 'upstream', message: String(msg) } }, upstream.status === 401 ? 401 : 502, origin);
  }

  const out = normalizePrices(raw, currency);
  out.from = from; out.to = to; out.date = date;
  out.fetchedAt = new Date().toISOString();

  await quotaBump(env, q);
  if (env.SKYCACHE) {
    ctx.waitUntil(env.SKYCACHE.put(cacheKey, JSON.stringify(out), { expirationTtl: PRICE_TTL }));
  }

  return json(out, 200, origin, {
    'X-SkySearch-Cache': 'MISS',
    'Cache-Control': `public, max-age=${PRICE_TTL}`
  });
}

/* ---------- Horaires ---------- */

async function handleSchedules(provider, url, env, ctx, origin) {
  const target = url.searchParams.get('target');
  if (!target)
    return json({ error: { message: 'Paramètre « target » manquant' } }, 400, origin);

  let t;
  try { t = new URL(target); }
  catch { return json({ error: { message: 'URL cible invalide' } }, 400, origin); }

  /* Liste blanche stricte : sans elle, ce Worker devient un relais ouvert. */
  if (!ALLOWED_HOSTS.has(t.hostname))
    return json({ error: { message: `Hôte non autorisé : ${t.hostname}` } }, 403, origin);

  const headers = {};
  if (provider === 'aerodatabox') {
    if (!env.AERODATABOX_KEY)
      return json({ error: { message: 'AERODATABOX_KEY non configurée' } }, 500, origin);
    headers['X-RapidAPI-Key'] = env.AERODATABOX_KEY;
    headers['X-RapidAPI-Host'] = t.hostname;
  } else if (provider === 'aviationstack') {
    if (!env.AVIATIONSTACK_KEY)
      return json({ error: { message: 'AVIATIONSTACK_KEY non configurée' } }, 500, origin);
    t.searchParams.set('access_key', env.AVIATIONSTACK_KEY);
    t.protocol = 'https:';
  } else {
    return json({ error: { message: `Fournisseur inconnu : ${provider}` } }, 400, origin);
  }

  const cache = caches.default;
  const cacheKey = new Request(t.toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const r = new Response(cached.body, cached);
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => r.headers.set(k, v));
    r.headers.set('X-SkySearch-Cache', 'HIT');
    return r;
  }

  let upstream;
  try {
    upstream = await fetch(t.toString(), {
      headers,
      cf: { cacheTtl: SCHEDULE_TTL, cacheEverything: true }
    });
  } catch (e) {
    return json({ error: { message: 'Fournisseur injoignable : ' + e.message } }, 502, origin);
  }

  const body = await upstream.text();
  const out = new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${SCHEDULE_TTL}`,
      ...corsHeaders(origin)
    }
  });
  out.headers.set('X-SkySearch-Cache', 'MISS');
  if (upstream.ok) ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}
