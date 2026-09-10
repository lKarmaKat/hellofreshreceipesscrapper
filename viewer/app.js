// Viewer des recettes.
// Toutes les données viennent de l'API du serveur Python (serveur/app.py) :
//   GET /api/recettes          -> { recettes: [...], erreurs: [...] }  (sans le corps)
//   GET /api/recettes/<slug>   -> une recette + `corps` (markdown, images déjà en absolu)
// Le viewer ne parse aucun .md ni YAML : le serveur a déjà tout normalisé.

// ==================== ÉTAT ====================
let recettes = [];
const filtresActifs = { tags: new Set(), cuisines: new Set() };
let termeRecherche = '';
let dureeMax = null;         // borne haute en minutes ; null = pas de filtre durée
let dureeMaxPossible = 0;    // plafond du slider = durée la plus longue observée
let saisonMois = null;       // 1-12 = mois de référence du filtre saison ; null = filtre off
let saisonSeuil = 60;        // % minimum de légumes de saison pour rester dans la grille
const cacheDetails = new Map();   // slug -> objet détail (avec corps)
let slugModaleCourante = null;

// ==================== OUTILS ====================
function echapperHtml(valeur) {
  return String(valeur ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Les cuisines sont des slugs anglais ("fusion-cuisine") : on les rend lisibles
// pour l'affichage, mais on filtre toujours sur le slug brut.
function humaniserCuisine(slug) {
  return slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function metaCourte(r) {
  const bouts = [];
  if (r.temps_total_min) bouts.push(`${r.temps_total_min} min`);
  if (r.calories_kcal) bouts.push(`${Math.round(r.calories_kcal)} kcal`);
  return bouts.join(' · ');
}

function metaComplete(r) {
  const bouts = [];
  if (r.temps_total_min) bouts.push(`${r.temps_total_min} min`);
  if (r.calories_kcal) bouts.push(`${Math.round(r.calories_kcal)} kcal`);
  if (r.difficulte) bouts.push(`difficulté ${r.difficulte}/3`);
  if (r.portions) bouts.push(`${r.portions} portion${r.portions > 1 ? 's' : ''}`);
  return bouts.join(' · ');
}

function badgesHtml(r) {
  const cuisines = (r.cuisine || []).map(
    (c) => `<span class="badge badge-cuisine">${echapperHtml(humaniserCuisine(c))}</span>`
  );
  const tags = (r.tags || []).map(
    (t) => `<span class="badge badge-tag">${echapperHtml(t.nom)}</span>`
  );
  const manuel = r.source === 'manuel' ? ['<span class="badge badge-manuel">manuel</span>'] : [];
  return [...cuisines, ...tags, ...manuel].join('');
}

// ==================== CHARGEMENT ====================
async function init() {
  wireEvenements();

  let data;
  try {
    const rep = await fetch('/api/recettes');
    if (!rep.ok) throw new Error(`HTTP ${rep.status}`);
    data = await rep.json();
  } catch (e) {
    afficherGrilleVide(`Impossible de charger les recettes (${e.message}). Le serveur est-il lancé ?`);
    return;
  }

  recettes = data.recettes || [];
  afficherErreurs(data.erreurs || []);
  construireFiltres();
  appliquerFiltres();
}

function afficherErreurs(erreurs) {
  if (!erreurs.length) return;
  const zone = document.getElementById('erreurs');
  const n = erreurs.length;
  zone.textContent =
    `${n} recette${n > 1 ? 's' : ''} en erreur : ${erreurs.map((e) => e.slug || '?').join(', ')}` +
    ' — voir la console pour le détail.';
  zone.hidden = false;
  console.warn('[recettes] erreurs signalées par le serveur :', erreurs);
}

// ==================== FILTRES ====================
function construireFiltres() {
  const parFr = (a, b) => a.localeCompare(b, 'fr');
  const tags = [...new Set(recettes.flatMap((r) => (r.tags || []).map((t) => t.nom)))].sort(parFr);
  const cuisines = [...new Set(recettes.flatMap((r) => r.cuisine || []))].sort(parFr);

  remplirGroupeFiltre('filtres-tags', 'tags', tags.map((v) => ({ valeur: v, label: v })));
  remplirGroupeFiltre('filtres-cuisines', 'cuisines',
    cuisines.map((v) => ({ valeur: v, label: humaniserCuisine(v) })));
  configurerSliderDuree();
  configurerFiltreSaison();
}

// Filtre "légumes de saison" : le serveur fournit par recette `saison`
//   { legumes_saisonniers: [{ nom, mois: [1..12] }], legumes_toute_annee: [nom], applicable }
// On choisit un mois de référence (défaut : mois courant) et un seuil % ; une
// recette reste dans la grille si (part de ses légumes de saison ce mois-là) >=
// seuil. Les recettes sans aucun légume identifié (`applicable: false`) ne sont
// pas filtrables : renderGrille les regroupe dans une section "Hors catégorie".
function configurerFiltreSaison() {
  const groupe = document.getElementById('filtres-saison');
  const select = document.getElementById('saison-mois');
  const seuil = document.getElementById('saison-seuil');

  const utilisable = recettes.some((r) => r.saison && r.saison.applicable);
  saisonMois = null;
  if (!utilisable) {
    groupe.hidden = true;
    return;
  }
  groupe.hidden = false;

  saisonMois = new Date().getMonth() + 1;   // défaut : mois courant
  select.value = String(saisonMois);
  seuil.value = String(saisonSeuil);
  majFiltreSaison();

  select.onchange = () => {
    saisonMois = select.value ? Number(select.value) : null;
    majFiltreSaison();
    appliquerFiltres();
  };
  seuil.oninput = () => {
    saisonSeuil = Number(seuil.value);
    majFiltreSaison();
    appliquerFiltres();
  };
}

function majFiltreSaison() {
  document.getElementById('saison-seuil-ligne').hidden = saisonMois === null;
  document.getElementById('saison-seuil-valeur').textContent = `${saisonSeuil} %`;
}

// null = pas de légume identifié (recette "hors catégorie") ;
// sinon { num, denom, pct } pour le mois donné.
function scoreSaison(r, mois) {
  const s = r.saison;
  if (!s || !s.applicable) return null;
  const toujours = (s.legumes_toute_annee || []).length;
  const saisonniers = s.legumes_saisonniers || [];
  const denom = toujours + saisonniers.length;
  if (!denom) return null;
  const num = toujours + saisonniers.filter((l) => (l.mois || []).includes(mois)).length;
  return { num, denom, pct: Math.round((num / denom) * 100) };
}

// Slider "durée max" : filtre sur `temps_total_min`. Le plafond s'aligne sur la
// recette la plus longue (arrondi à 5 min). Curseur au maximum = pas de filtre.
// Une recette sans `temps_total_min` (saisie manuelle) est masquée dès que le
// filtre est actif : on ne peut pas la situer sur l'échelle.
function configurerSliderDuree() {
  const slider = document.getElementById('duree-slider');
  const groupe = document.getElementById('filtres-duree');

  const durees = recettes
    .map((r) => r.temps_total_min)
    .filter((n) => typeof n === 'number' && n > 0);

  dureeMax = null;
  if (!durees.length) {
    groupe.hidden = true;
    slider.disabled = true;
    return;
  }

  dureeMaxPossible = Math.ceil(Math.max(...durees) / 5) * 5;
  groupe.hidden = false;
  slider.disabled = false;
  slider.min = 0;
  slider.max = dureeMaxPossible;
  slider.step = 5;
  slider.value = dureeMaxPossible;
  majLibelleDuree();

  slider.oninput = () => {
    const v = Number(slider.value);
    dureeMax = v >= dureeMaxPossible ? null : v;
    majLibelleDuree();
    appliquerFiltres();
  };
}

function majLibelleDuree() {
  document.getElementById('duree-valeur').textContent =
    dureeMax === null ? '(toutes)' : `≤ ${dureeMax} min`;
}

function remplirGroupeFiltre(idConteneur, typeFiltre, options) {
  const conteneur = document.getElementById(idConteneur);
  conteneur.querySelectorAll('.option-filtre, p.vide').forEach((el) => el.remove());

  if (!options.length) {
    const p = document.createElement('p');
    p.className = 'vide';
    p.textContent = '—';
    conteneur.appendChild(p);
    return;
  }

  for (const { valeur, label } of options) {
    const lab = document.createElement('label');
    lab.className = 'option-filtre';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = valeur;
    cb.addEventListener('change', () => {
      if (cb.checked) filtresActifs[typeFiltre].add(valeur);
      else filtresActifs[typeFiltre].delete(valeur);
      appliquerFiltres();
    });
    lab.append(cb, ' ', label);
    conteneur.appendChild(lab);
  }
}

function reinitialiserFiltres() {
  filtresActifs.tags.clear();
  filtresActifs.cuisines.clear();
  termeRecherche = '';
  document.getElementById('recherche').value = '';
  document.querySelectorAll('.option-filtre input').forEach((cb) => (cb.checked = false));

  const slider = document.getElementById('duree-slider');
  if (!slider.disabled) {
    slider.value = dureeMaxPossible;
    dureeMax = null;
    majLibelleDuree();
  }

  const groupeSaison = document.getElementById('filtres-saison');
  if (!groupeSaison.hidden) {
    saisonMois = new Date().getMonth() + 1;
    saisonSeuil = 60;
    document.getElementById('saison-mois').value = String(saisonMois);
    document.getElementById('saison-seuil').value = String(saisonSeuil);
    majFiltreSaison();
  }

  appliquerFiltres();
}

// ==================== RECHERCHE / FILTRAGE ====================
function correspondRecherche(r) {
  if (!termeRecherche) return true;
  const champs = [
    r.titre,
    r.sous_titre,
    ...(r.ingredients || []).map((i) => i.nom),
    ...(r.tags || []).map((t) => t.nom),
    ...(r.cuisine || []).map(humaniserCuisine),
  ];
  return champs.some((c) => c && c.toLowerCase().includes(termeRecherche));
}

function appliquerFiltres() {
  const tagsChoisis = [...filtresActifs.tags];
  const cuisinesChoisies = filtresActifs.cuisines;

  const filtrees = recettes.filter((r) => {
    const tagsRecette = (r.tags || []).map((t) => t.nom);
    const okTags = tagsChoisis.every((t) => tagsRecette.includes(t));  // ET entre tags
    const okCuisine = cuisinesChoisies.size === 0
      || (r.cuisine || []).some((c) => cuisinesChoisies.has(c));       // OU entre cuisines
    const okDuree = dureeMax === null
      || (typeof r.temps_total_min === 'number' && r.temps_total_min <= dureeMax);
    return okTags && okCuisine && okDuree && correspondRecherche(r);
  });

  if (saisonMois === null) {
    renderGrille(filtrees, []);
    return;
  }

  // Filtre saison actif : on scinde en "assez de saison" / "hors catégorie".
  const principales = [];
  const horsCategorie = [];
  for (const r of filtrees) {
    const sc = scoreSaison(r, saisonMois);
    if (sc === null) horsCategorie.push(r);
    else if (sc.pct >= saisonSeuil) principales.push(r);
    // sinon : recette identifiée mais trop peu de saison -> masquée
  }
  renderGrille(principales, horsCategorie);
}

// ==================== AFFICHAGE GRILLE ====================
function afficherGrilleVide(message) {
  document.getElementById('grille').innerHTML = '';
  const compteur = document.getElementById('compteur');
  compteur.className = 'compteur vide';
  compteur.textContent = message;
}

function carteHtml(r) {
  const meta = metaCourte(r);
  const sc = saisonMois === null ? null : scoreSaison(r, saisonMois);
  const badgeSaison = sc
    ? `<span class="badge badge-saison">${sc.num}/${sc.denom} de saison</span>`
    : '';
  return `
      <article class="carte" data-slug="${echapperHtml(r.slug)}">
        <div class="carte-img-conteneur">
          <div class="carte-img-fallback">${echapperHtml(r.titre)}</div>
          ${r.image_principale ? `<img src="${echapperHtml(r.image_principale)}" alt="" loading="lazy">` : ''}
        </div>
        <div class="carte-body">
          <h3>${echapperHtml(r.titre)}</h3>
          ${meta ? `<div class="carte-meta">${echapperHtml(meta)}</div>` : ''}
          <div class="ligne-badges">${badgeSaison}${badgesHtml(r)}</div>
        </div>
      </article>`;
}

function renderGrille(liste, horsCategorie = []) {
  const compteur = document.getElementById('compteur');
  const grille = document.getElementById('grille');

  if (!liste.length && !horsCategorie.length) {
    afficherGrilleVide(recettes.length
      ? 'Aucune recette ne correspond aux filtres.'
      : 'Aucune recette. Ajoute des dossiers dans recettes/.');
    return;
  }

  compteur.className = 'compteur';
  const n = liste.length;
  compteur.textContent = `${n} recette${n > 1 ? 's' : ''}`
    + (horsCategorie.length ? ` · ${horsCategorie.length} hors catégorie` : '');

  let html = liste.map(carteHtml).join('');
  if (horsCategorie.length) {
    html += '<h2 class="grille-section">Hors catégorie'
      + ' <span>aucun légume identifié pour juger la saison</span></h2>'
      + horsCategorie.map(carteHtml).join('');
  }
  grille.innerHTML = html;

  grille.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => img.remove());
  });
}

// ==================== MODALE DÉTAIL ====================
async function ouvrirRecette(slug) {
  const overlay = document.getElementById('overlay');
  const contenu = document.getElementById('modale-contenu');

  slugModaleCourante = slug;
  overlay.classList.add('actif');
  contenu.innerHTML = '<p class="modale-chargement">Chargement…</p>';

  let detail = cacheDetails.get(slug);
  if (!detail) {
    try {
      const rep = await fetch(`/api/recettes/${encodeURIComponent(slug)}`);
      if (!rep.ok) throw new Error(`HTTP ${rep.status}`);
      detail = await rep.json();
      cacheDetails.set(slug, detail);
    } catch (e) {
      if (slugModaleCourante === slug) {
        contenu.innerHTML = `<p class="modale-erreur">Impossible de charger cette recette (${echapperHtml(e.message)}).</p>`;
      }
      return;
    }
  }

  if (slugModaleCourante !== slug) return;  // fermée / autre recette ouverte entre-temps
  contenu.innerHTML = rendreDetail(detail);
  contenu.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => img.remove());  // vignette / photo d'étape absente
  });
  document.getElementById('modale').scrollTop = 0;
}

function rendreDetail(r) {
  const parts = [`<h1>${echapperHtml(r.titre)}</h1>`];

  if (r.sous_titre) parts.push(`<p class="modale-sous-titre">${echapperHtml(r.sous_titre)}</p>`);

  const meta = metaComplete(r);
  if (meta) parts.push(`<div class="modale-meta">${echapperHtml(meta)}</div>`);

  const badges = badgesHtml(r);
  if (badges) parts.push(`<div class="ligne-badges modale-badges">${badges}</div>`);

  if ((r.ingredients || []).length) {
    const titre = r.portions ? `Ingrédients (pour ${r.portions})` : 'Ingrédients';
    // Espace réservé pour les ingrédients sans vignette, mais seulement si la
    // recette en a au moins une (sinon on n'indente rien pour rien).
    const avecImages = r.ingredients.some((i) => i.image);
    parts.push(
      `<h2>${echapperHtml(titre)}</h2><ul class="liste-ingredients">` +
      r.ingredients.map((i) => {
        const vignette = i.image
          ? `<img class="ingredient-img" src="${echapperHtml(i.image)}" alt="" loading="lazy">`
          : (avecImages ? '<span class="ingredient-img ingredient-img--absente" aria-hidden="true"></span>' : '');
        const qte = i.quantite
          ? `<span class="ingredient-qte">${echapperHtml(i.quantite)}</span>`
          : '';
        return `<li>${vignette}<span class="ingredient-texte">` +
          `<span class="ingredient-nom">${echapperHtml(i.nom)}</span>${qte}</span></li>`;
      }).join('') +
      '</ul>'
    );
  }

  if ((r.allergenes || []).length) {
    parts.push(`<h2>Allergènes</h2><p>${r.allergenes.map(echapperHtml).join(', ')}</p>`);
  }

  if (r.corps && r.corps.trim()) {
    // `corps` = markdown de confiance (généré par le scraper ou écrit à la main),
    // liens d'images déjà résolus en absolu par le serveur. marked ne sanitise pas :
    // acceptable ici (outil local, contenu maison).
    parts.push(`<div class="modale-corps">${marked.parse(r.corps)}</div>`);
  }

  if (r.url) {
    parts.push(
      `<a class="modale-lien-source" href="${echapperHtml(r.url)}" target="_blank" rel="noopener">` +
      "Voir la recette d'origine ↗</a>"
    );
  }

  return parts.join('\n');
}

function fermerModale() {
  slugModaleCourante = null;
  document.getElementById('overlay').classList.remove('actif');
  document.getElementById('modale-contenu').innerHTML = '';
}

// ==================== ÉVÉNEMENTS ====================
function wireEvenements() {
  document.getElementById('recherche').addEventListener('input', (e) => {
    termeRecherche = e.target.value.trim().toLowerCase();
    appliquerFiltres();
  });
  document.getElementById('reset-filtres').addEventListener('click', reinitialiserFiltres);
  document.getElementById('fermer-modale').addEventListener('click', fermerModale);
  document.getElementById('overlay').addEventListener('click', (e) => {
    if (e.target.id === 'overlay') fermerModale();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') fermerModale();
  });
  document.getElementById('grille').addEventListener('click', (e) => {
    const carte = e.target.closest('.carte');
    if (carte) ouvrirRecette(carte.dataset.slug);
  });
}

init();
