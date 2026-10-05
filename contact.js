/* Page contact.
   GitHub Pages ne sert que des fichiers statiques : aucun serveur ne peut
   recevoir un POST. Le formulaire construit donc une URL d'issue GitHub
   pré-remplie, ce qui évite un service tiers, un compte et un secret à
   stocker. Les propositions arrivent là où elles seront traitées. */
'use strict';

const REPO = 'njegou/skysearch1';

const PREFIX = {
  feature: 'Fonctionnalité',
  airport: 'Aéroport manquant',
  data: 'Donnée incorrecte',
  bug: 'Dysfonctionnement',
  other: 'Autre'
};

const $ = id => document.getElementById(id);

function build() {
  const type = $('type').value;
  const title = $('title').value.trim();
  const body = $('body').value.trim();
  const who = $('who').value.trim();

  const fullTitle = `[${PREFIX[type] || 'Autre'}] ${title}`;

  let fullBody = body;
  if (who) fullBody += `\n\n---\nProposé par : ${who}`;
  fullBody += `\n\nEnvoyé depuis la page contact de SkySearch.`;

  return {
    title: fullTitle,
    body: fullBody,
    url: `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(fullTitle)}&body=${encodeURIComponent(fullBody)}`
  };
}

function validate() {
  const title = $('title').value.trim();
  const body = $('body').value.trim();
  const ok = title.length >= 4 && body.length >= 10;
  $('send').disabled = !ok;
  $('copy').disabled = !ok;
  return ok;
}

function note(msg, warn) {
  const el = $('formNote');
  el.textContent = msg;
  el.className = 'notice' + (warn ? ' warn' : '');
  el.hidden = false;
}

['type', 'title', 'body', 'who'].forEach(id => {
  $(id).addEventListener('input', () => { validate(); $('preview').textContent = buildPreview(); });
  $(id).addEventListener('change', () => { validate(); $('preview').textContent = buildPreview(); });
});

function buildPreview() {
  if (!$('title').value.trim() && !$('body').value.trim()) return '';
  const r = build();
  return r.title + '\n\n' + r.body;
}

$('form').addEventListener('submit', e => {
  e.preventDefault();
  if (!validate()) { note('Donnez un titre de quatre caractères et une description de dix.', true); return; }
  const r = build();
  /* 8 Ko est la limite pratique d'une URL ; au-delà on invite à copier. */
  if (r.url.length > 8000) {
    note('La description est trop longue pour un lien. Utilisez « Copier le texte », puis collez-le dans une issue GitHub.', true);
    return;
  }
  window.open(r.url, '_blank', 'noopener');
  note('Un onglet GitHub vient de s\'ouvrir avec votre proposition pré-remplie. Elle n\'est envoyée qu\'une fois que vous validez la création de l\'issue.');
});

$('copy').onclick = async () => {
  if (!validate()) return;
  const r = build();
  try {
    await navigator.clipboard.writeText(r.title + '\n\n' + r.body);
    note('Texte copié. Collez-le où vous voulez.');
  } catch (e) {
    note('La copie automatique a échoué. Sélectionnez le texte de l\'aperçu ci-dessous.', true);
  }
};

$('reset').onclick = () => {
  $('form').reset();
  $('preview').textContent = '';
  $('formNote').hidden = true;
  validate();
};

/* Pré-remplissage par lien : contact.html?type=airport&title=ABC manquant */
(function prefill() {
  try {
    const p = new URLSearchParams(location.search);
    const t = p.get('type'), ti = p.get('title'), b = p.get('body');
    if (t && PREFIX[t]) $('type').value = t;
    if (ti) $('title').value = ti;
    if (b) $('body').value = b;
  } catch (e) { }
  validate();
  $('preview').textContent = buildPreview();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => { }));
}
