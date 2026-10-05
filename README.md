# SkySearch

Recherche de vols sur une base embarquée. Trois champs : départ, arrivée, date.

Le départ et l'arrivée acceptent un **pays**, une **ville** ou un **aéroport**. Saisir `France` interroge les 22 aéroports français, `Paris` interroge CDG et ORY, `CDG` interroge ce seul aéroport.

---

## La base

| | |
|---|---|
| Aéroports | 317, répartis sur 100 pays |
| Compagnies | 127 |
| Vols | 14 222 |
| Routes | 13 280, toutes dans les deux sens |
| Paires de pays desservies | 7 246 |

Tous les aéroports du registre sont desservis, et les 100 pays ont au moins un départ.

### Le point important sur le modèle de données

**Aucune heure d'arrivée n'est stockée.** Chaque vol porte son heure de départ locale et sa durée bloc :

```js
AF6019 → ['CDG', 'NRT', 1411, 807, 'B777-300ER', '2E', '1']
//        dép    arr    23:31  13h27
```

L'heure d'arrivée, le décalage de jour, le libellé de fuseau et la distance sont **calculés à l'exécution** depuis les fuseaux IANA. Une durée ne peut donc pas contredire la géographie, et le passage à l'heure d'été est géré sans intervention : le même vol Paris-New York affiche `UTC+1 → EDT` le 28 mars et `UTC+2 → EDT` le 29.

Les durées sont dérivées de la distance orthodromique, puis validées contre une enveloppe de vitesse réaliste. Les 14 222 vols passent ce contrôle.

---

## Utilisation

```bash
cd skysearch1
python3 -m http.server 8000
```

Puis `http://localhost:8000`. Un service worker est nécessaire pour le mode hors ligne : il faut du HTTP, pas d'ouverture directe du fichier.

### Lien profond

`index.html?from=FR&to=GR&date=2026-10-05` lance la recherche directement. `from` et `to` acceptent un code pays ISO2, un code IATA, ou un nom.

---

## Temps réel (optionnel)

La base répond toujours. Avec une clé configurée dans ⚙, SkySearch interroge en plus un fournisseur pour obtenir les **vols réels du jour** avec statut, retard, porte et tapis bagages.

| Fournisseur | Ce qu'il apporte |
|---|---|
| AeroDataBox | statut, retards, portes, terminaux, tapis |
| Aviationstack | statut, retards, terminaux |

### La règle des deux aéroports

Une recherche `France → Grèce` balaie 22 × 10 aéroports. Interroger le fournisseur voudrait dire 22 appels pour une seule recherche. L'app ne le fait pas : **au-delà de deux aéroports d'un côté ou de l'autre, la base embarquée répond seule**, et l'interface le dit. Pour obtenir les vols réels, il faut préciser une ville ou un aéroport.

### Où va votre clé

L'app est une page statique, elle ne peut rien cacher. La clé est stockée dans le `localStorage` du navigateur et envoyée au seul fournisseur choisi. Tant que chacun saisit sa propre clé, c'est le bon modèle.

**Si vous publiez l'app avec votre clé, elle devient lisible par tous.** Déployez alors `worker.js`, un Worker Cloudflare qui garde la clé côté serveur, ajoute les en-têtes CORS manquants et réécrit en HTTPS les fournisseurs qui n'offrent que HTTP en gratuit.

```bash
npm i -g wrangler
wrangler init skysearch-proxy     # remplacer src/index.js par worker.js
wrangler secret put AERODATABOX_KEY
wrangler deploy
```

Collez l'URL du Worker dans ⚙ › Proxy et laissez le champ clé vide.

### Repli

| Situation | Réaction |
|---|---|
| Clé refusée, quota, CORS, timeout | bascule sur la base, notification |
| Recherche trop large | base seule, avertissement dans les résultats |
| Hors ligne | base seule, badge « Hors ligne » |

Les réponses sont mises en cache 90 secondes, en mémoire et sur disque.

---

## Saisie

L'autocomplétion classe pays, villes et aéroports par pertinence et affiche le nombre d'aéroports derrière chaque entrée. Elle accepte les graphies locales et les exonymes : `Köln`, `Bombay`, `Saigon`, `Peking`, `Wien`, `Majorque`, `Joburg`, `Tahiti`, `Corse`, `NYC`.

Les accents et la casse sont ignorés : `grece`, `Grèce` et `GREECE` donnent le même résultat.

Quand aucun vol direct n'existe, l'écran vide propose le sens inverse s'il est desservi, et les pays réellement atteignables depuis le départ saisi.

---

## Structure

```
index.html     interface
app.js         moteur (résolution, recherche, rendu, API)
data.js        base générée — ne pas éditer à la main
sw.js          service worker
worker.js      proxy Cloudflare (optionnel)
manifest.json  manifeste PWA
icon-*.svg     icônes
tools/         scripts de génération de la base
```

### Régénérer la base

```bash
cd tools
python3 genflights.py     # construit le réseau et le valide
python3 encode.py         # produit data.js
```

`airports.py` tient le registre des aéroports et des pays. Ajouter un aéroport demande son code IATA, sa ville, son nom, son pays, ses coordonnées, son fuseau IANA et un rang de hub (1 à 3). Le générateur s'occupe des routes, des durées et des compagnies.

---

## Limites connues

- **Les horaires sont plausibles, pas réels.** Les routes, fréquences et numéros de vol sont générés : ils respectent la géographie, les hubs et les compagnies nationales, mais ne correspondent pas aux programmes publiés des compagnies. Pour du réel, il faut une clé API.
- **Les numéros de vol étant générés, le lien « Statut en direct » peut ne rien trouver** sur un vol issu de la base. En mode temps réel, les numéros sont ceux du fournisseur et les liens fonctionnent.
- Uniquement des vols sans escale. Aucun calcul de correspondance.
- **Les intégrations API n'ont pas été testées contre les serveurs réels**, seulement contre des fixtures reproduisant la forme documentée des réponses. Le bouton « Tester la clé » sert à valider au premier usage.

---

## Tests

- résolution de 28 saisies (pays, villes, aéroports, alias, accents, casse) ;
- expansion pays vérifiée sur 8 pays ;
- recherches pays→pays, ville→ville, mixtes, sur 19 combinaisons ;
- **arrivées recalculées indépendamment via `Intl` sur 1 016 vols : 0 divergence, 0 décalage de jour faux** ;
- bascules heure d'été des deux côtés de l'Atlantique ;
- durées contrôlées contre la distance orthodromique sur les 14 222 vols ;
- enrichissement API : requête générée, clé transmise en en-tête, filtrage destination, 4 chemins d'échec avec repli ;
- règle des deux aéroports : 0 appel réseau sur une recherche large ;
- fuzz sur 24 entrées dégénérées, rendu de 500 vols, échappement HTML, clé absente du DOM.

## Licence

Usage personnel. Les horaires de la base sont indicatifs et ne constituent pas une information de vol officielle.
