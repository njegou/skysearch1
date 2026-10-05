/**
 * SkySearch — proxy Cloudflare Worker
 * ------------------------------------------------------------
 * À quoi il sert :
 *   1. Garder la clé API côté serveur. Une page statique ne peut rien cacher :
 *      toute clé saisie dans le navigateur est lisible par l'utilisateur.
 *      Tant que chacun met SA clé, ce n'est pas un problème. Dès que vous
 *      publiez l'app avec VOTRE clé, il vous faut ce proxy.
 *   2. Ajouter les en-têtes CORS que certains fournisseurs n'envoient pas.
 *   3. Réécrire en HTTPS les fournisseurs qui n'exposent que HTTP en gratuit
 *      (Aviationstack), sinon le navigateur bloque pour contenu mixte.
 *
 * Déploiement :
 *   npm i -g wrangler
 *   wrangler init skysearch-proxy      (puis remplacer src/index.js par ce fichier)
 *   wrangler secret put AERODATABOX_KEY
 *   wrangler secret put AVIATIONSTACK_KEY
 *   wrangler deploy
 *
 * Puis collez l'URL du Worker dans SkySearch › ⚙ › Proxy.
 */

const ALLOWED_HOSTS = new Set([
  'aerodatabox.p.rapidapi.com',
  'api.aviationstack.com'
]);

/* Restreignez ceci à votre domaine une fois en production. */
const ALLOWED_ORIGINS = ['*'];

/* Cache court : les données de vol bougent, mais pas à la seconde. */
const CACHE_TTL = 60;

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (request.method !== 'GET')
      return json({ error: { message: 'Méthode non autorisée' } }, 405, origin);

    const url = new URL(request.url);
    const provider = url.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
    const target = url.searchParams.get('target');

    if (!target)
      return json({ error: { message: 'Paramètre "target" manquant' } }, 400, origin);

    let t;
    try {
      t = new URL(target);
    } catch {
      return json({ error: { message: 'URL cible invalide' } }, 400, origin);
    }

    /* Liste blanche stricte : sans elle, ce Worker devient un proxy ouvert. */
    if (!ALLOWED_HOSTS.has(t.hostname))
      return json({ error: { message: `Hôte non autorisé : ${t.hostname}` } }, 403, origin);

    const headers = {};

    if (provider === 'aerodatabox') {
      if (!env.AERODATABOX_KEY)
        return json({ error: { message: 'AERODATABOX_KEY non configurée sur le Worker' } }, 500, origin);
      headers['X-RapidAPI-Key'] = env.AERODATABOX_KEY;
      headers['X-RapidAPI-Host'] = t.hostname;
    } else if (provider === 'aviationstack') {
      if (!env.AVIATIONSTACK_KEY)
        return json({ error: { message: 'AVIATIONSTACK_KEY non configurée sur le Worker' } }, 500, origin);
      /* La clé passe en query : on la remplace côté serveur. */
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
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
      });
    } catch (e) {
      return json({ error: { message: 'Fournisseur injoignable : ' + e.message } }, 502, origin);
    }

    const body = await upstream.text();
    const out = new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
        ...corsHeaders(origin)
      }
    });
    out.headers.set('X-SkySearch-Cache', 'MISS');

    if (upstream.ok) ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  }
};
