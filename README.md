# SkySearch

Recherche d'horaires de vols par pays, ville ou aéroport.
En ligne : <https://njegou.github.io/skysearch1/>

Trois champs : départ, arrivée, date. Saisir `France` interroge les 22 aéroports français,
`Paris` interroge CDG et ORY, `CDG` interroge ce seul aéroport.

---

## La base

| | |
|---|---|
| Aéroports | 317, sur 100 pays |
| Compagnies | 127 |
| Vols | 14 222 |
| Routes | 13 280, toutes dans les deux sens |
| Paires de pays desservies | 7 246 |

Tous les aéroports du registre sont desservis, et chacun des 100 pays a au moins un départ.

### Le modèle de données

**Aucune heure d'arrivée n'est stockée.** Chaque vol porte son heure de départ locale et sa
durée bloc :

```js
AF6019 → ['CDG', 'NRT', 1411, 807, 'B777-300ER', '2E', '1']
//        dép    arr   23:31  13h27
```

L'arrivée, le décalage de jour, le libellé de fuseau et la distance sont calculés à l'exécution
depuis les fuseaux IANA. Une durée ne peut donc pas contredire la géographie, et le changement
d'heure est géré sans intervention.

Les durées sont dérivées de la distance orthodromique puis validées contre une enveloppe de
vitesse réaliste. Les 14 222 vols passent ce contrôle.

---

## Pages

| Page | Contenu |
|---|---|
| `index.html` | recherche |
| `aeroports.html` | les 317 aéroports, filtrables et triables |
| `docs.html` | fonctionnement, modèle de données, mode temps réel, proxy |
| `objectif.html` | pourquoi le projet existe et ce qu'il ne fera pas |
| `contact.html` | proposer une fonctionnalité |

---

## Design

Le parti pris est celui d'un document de consultation, pas d'une vitrine : typographie système,
une seule couleur d'accent, aucune animation décorative, des lignes de texte plutôt que des
cartes. Le thème sombre suit le réglage du système.

Contrastes vérifiés : tout le texte dépasse 4,5:1 dans les deux thèmes, les contours de champ
dépassent 3:1 (WCAG 1.4.11).

### Adaptations iPhone

- champs à 16px, en dessous iOS zoome au focus
- `viewport-fit=cover` et `env(safe-area-inset-*)` sur les quatre côtés
- aucun `100vh`, cassé par la barre d'outils de Safari iOS
- cibles tactiles de 44px pour les contrôles, 34px pour les liens d'action
- `touch-action: manipulation` contre le délai de 300 ms
- `-webkit-text-size-adjust` contre le redimensionnement en paysage
- navigation qui passe à la ligne au lieu de défiler : aucun onglet caché
- colonne Arrivées masquée sous 34rem, elle double Départs sur un réseau bidirectionnel

---

## Utilisation locale

```bash
python3 -m http.server 8000
```

Puis `http://localhost:8000`. Le service worker exige HTTP ou HTTPS : ouvrir le fichier
directement depuis le disque désactive le mode hors ligne.

### Liens de partage

```
index.html?from=FR&to=GR&date=2026-10-05
index.html?from=CDG&to=JFK
aeroports.html?q=Grèce
contact.html?type=airport&title=BRU%20manquant
```

---

## Temps réel (optionnel)

La base répond toujours. Avec une clé renseignée via **Source des données** en pied de page,
SkySearch interroge en plus un fournisseur pour obtenir les vols réels du jour : statut, retard,
porte, tapis bagages.

| Fournisseur | Apport |
|---|---|
| AeroDataBox | statut, retards, portes, terminaux, tapis |
| Aviationstack | statut, retards, terminaux |

### La règle des deux aéroports

`France → Grèce` balaie 22 × 10 aéroports. Interroger le fournisseur demanderait 22 appels pour
une recherche. Au-delà de deux aéroports d'un côté, **la base répond seule** et l'interface le
signale.

### Où va la clé

Page statique, donc rien ne peut être caché. La clé reste dans le `localStorage` du navigateur
et n'est transmise qu'au fournisseur choisi. Tant que chaque utilisateur saisit la sienne, le
modèle tient.

**Si vous publiez l'application avec votre clé, elle devient lisible par tous.** Déployez alors
`worker.js`, un Worker Cloudflare qui garde la clé côté serveur, ajoute les en-têtes CORS
manquants et réécrit en HTTPS les fournisseurs limités à HTTP.

```bash
npm i -g wrangler
wrangler init skysearch-proxy     # remplacer src/index.js par worker.js
wrangler secret put AERODATABOX_KEY
wrangler deploy
```

### Repli

Clé refusée, quota, CORS, délai dépassé, réponse vide : bascule sur la base avec un message.
Les réponses sont mises en cache 90 secondes.

---

## Régénérer la base

```bash
cd tools
python3 genflights.py
python3 encode.py
```

`airports.py` tient le registre des aéroports, des pays et des alias de villes. Ajouter un
aéroport demande son code IATA, sa ville, son nom, son pays, ses coordonnées, son fuseau IANA
et un rang de hub de 1 à 3. Le générateur s'occupe des routes, des durées et des compagnies.

Ne modifiez pas `data.js` à la main, il est écrasé à chaque génération.

---

## Limites

- **Horaires générés.** Routes, fréquences et numéros de vol sont plausibles et
  géographiquement cohérents, mais ne correspondent pas aux programmes publiés des compagnies.
- **Numéros générés**, donc le lien « statut en direct » peut ne rien trouver pour un vol de la
  base. En mode temps réel, les numéros viennent du fournisseur et les liens fonctionnent.
- **Vols sans escale uniquement.** Aucun calcul de correspondance.
- **Aucun prix.** Les raisons sont sur la page Objectif : il n'existe plus d'accès gratuit à des
  tarifs réels depuis la fermeture d'Amadeus Self-Service en juillet 2026.
- **Les intégrations API n'ont pas été testées contre les serveurs réels**, seulement contre des
  fixtures reproduisant la forme documentée des réponses. Le bouton « Tester la clé » sert à
  valider au premier usage.

---

## Tests

- résolution de 28 saisies : pays, villes, aéroports, alias, exonymes, accents, casse
- recherches pays, ville et aéroport sur 19 combinaisons
- **arrivées recalculées indépendamment via `Intl` sur 1 016 vols : 0 divergence,
  0 décalage de jour faux**, bascules d'heure d'été comprises
- durées contrôlées contre la distance orthodromique sur les 14 222 vols
- enrichissement API : requête générée, clé en en-tête, filtrage destination,
  5 chemins d'échec avec repli, règle des deux aéroports
- pages secondaires : filtre et tri de la table, génération et encodage de l'URL d'issue,
  validation du formulaire, pré-remplissage par lien
- fuzz sur 24 entrées dégénérées, rendu de 508 vols, échappement HTML, clé absente du DOM
- rendu réel sous Chromium à 390 px et 1100 px, thèmes clair et sombre,
  débordement horizontal nul sur les cinq pages

## Licence

Usage personnel. Les horaires de la base sont indicatifs et n'ont aucune valeur contractuelle.
