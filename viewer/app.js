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
const selection = new Set();      // slugs cochés pour la liste de courses

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
  const selectionnee = selection.has(r.slug);
  return `
      <article class="carte${selectionnee ? ' carte--selectionnee' : ''}" data-slug="${echapperHtml(r.slug)}">
        <label class="carte-select" title="Sélectionner pour la liste de courses">
          <input type="checkbox" class="carte-select-cb" ${selectionnee ? 'checked' : ''}>
        </label>
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

// ==================== SÉLECTION / LISTE DE COURSES ====================
function majBarreSelection() {
  const barre = document.getElementById('barre-selection');
  const n = selection.size;
  barre.hidden = n === 0;
  document.getElementById('selection-compteur').textContent =
    `${n} recette${n > 1 ? 's' : ''} sélectionnée${n > 1 ? 's' : ''}`;
}

function viderSelection() {
  selection.clear();
  majBarreSelection();
  appliquerFiltres();  // re-render la grille pour retirer coches / surlignage
}

// `quantite` est une chaîne libre ("500 g", "1 pièce(s)", "selon le goût") :
// pas encore de qte/unite structurés côté scraper (voir CLAUDE.md, "Mise à
// l'échelle des quantités" — pas commencé). On la reparse ici au même schéma
// que celui prévu côté serveur, uniquement pour regrouper ce qui a la même
// unité ; le reste est listé tel quel plutôt que d'inventer un total.
function parserQuantite(quantite) {
  const m = String(quantite || '').trim().match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!m) return null;
  const nombre = parseFloat(m[1].replace(',', '.'));
  if (Number.isNaN(nombre)) return null;
  return { nombre, unite: m[2].trim() };
}

function normaliserNomIngredient(nom) {
  return String(nom || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')  // accents
    .replace(/\s*\([^)]*\)/g, '')                     // "(rouge)" etc.
    .trim();
}

function formaterNombre(n) {
  return String(Math.round(n * 100) / 100).replace('.', ',');
}

// Clé de regroupement : le slug `type` (anglais, stable) si l'API l'a fourni,
// sinon le nom normalisé. Un ingrédient avec `type` dans une recette et sans
// dans une autre ne sera donc pas fusionné avec lui-même : on préfère louper
// une fusion plutôt qu'en forcer une incertaine.
function construireListeCourses(slugs) {
  const parCle = new Map();  // clé -> { nom, contributions: [{ titre, quantite }] }

  for (const slug of slugs) {
    const r = recettes.find((x) => x.slug === slug);
    if (!r) continue;
    for (const ing of (r.ingredients || [])) {
      if (!ing.nom) continue;
      const cle = ing.type ? `type:${ing.type.toLowerCase()}` : `nom:${normaliserNomIngredient(ing.nom)}`;
      if (!parCle.has(cle)) parCle.set(cle, { nom: ing.nom, contributions: [] });
      parCle.get(cle).contributions.push({ titre: r.titre, quantite: ing.quantite || '' });
    }
  }

  const lignes = [];
  for (const { nom, contributions } of parCle.values()) {
    // Regroupe les contributions qui partagent la même unité (sommables) ;
    // le reste (unité différente, ou quantité non parsable) reste à part.
    const groupes = new Map();  // unité normalisée -> { unite, total, titres }
    const nonFusionnes = [];
    for (const c of contributions) {
      const parsed = parserQuantite(c.quantite);
      if (!parsed) { nonFusionnes.push({ texte: c.quantite || '?', titres: [c.titre] }); continue; }
      const uniteNorm = parsed.unite.toLowerCase();
      if (!groupes.has(uniteNorm)) groupes.set(uniteNorm, { unite: parsed.unite, total: 0, titres: [] });
      const g = groupes.get(uniteNorm);
      g.total += parsed.nombre;
      g.titres.push(c.titre);
    }

    const montants = [...groupes.values()].map((g) => ({
      texte: g.unite ? `${formaterNombre(g.total)} ${g.unite}` : formaterNombre(g.total),
      titres: [...new Set(g.titres)],
    })).concat(nonFusionnes);

    lignes.push({ nom, montants });
  }

  lignes.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  return lignes;
}

// Regroupement "par recette" : pas de fusion entre recettes (le but est
// justement de voir ce qui appartient à laquelle) — juste les ingrédients
// bruts de chacune, dans leur ordre d'origine.
function construireListeCoursesParRecette(slugs) {
  const groupes = [];
  for (const slug of slugs) {
    const r = recettes.find((x) => x.slug === slug);
    if (!r) continue;
    const lignes = (r.ingredients || [])
      .filter((i) => i.nom)
      .map((i) => ({ nom: i.nom, montant: i.quantite || '' }));
    groupes.push({ titre: r.titre, lignes });
  }
  return groupes;
}

// Une ligne par ingrédient, "Nom : quantité" — pensé pour un collage propre
// (notes, message), pas pour reproduire la mise en page de la modale.
function texteListeCourses(lignes) {
  return lignes.map((l) => {
    const montant = l.montants.map((m) => (
      l.montants.length > 1 ? `${m.texte} (${m.titres.join(', ')})` : m.texte
    )).join(' + ');
    return `${l.nom} : ${montant}`;
  }).join('\n');
}

function texteListeCoursesParRecette(groupes) {
  return groupes.map((g) => {
    const corps = g.lignes.length
      ? g.lignes.map((l) => `- ${l.nom}${l.montant ? ` : ${l.montant}` : ''}`).join('\n')
      : '(aucun ingrédient)';
    return `${g.titre}\n${corps}`;
  }).join('\n\n');
}

// navigator.clipboard exige un contexte sécurisé ; localhost en fait partie,
// mais on garde un repli textarea + execCommand au cas où.
function copierTexte(texte) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(texte);
  }
  return new Promise((resolve, reject) => {
    const zone = document.createElement('textarea');
    zone.value = texte;
    zone.style.position = 'fixed';
    zone.style.opacity = '0';
    document.body.appendChild(zone);
    zone.select();
    try {
      document.execCommand('copy');
      resolve();
    } catch (e) {
      reject(e);
    } finally {
      document.body.removeChild(zone);
    }
  });
}

async function copierListeCourses(texte) {
  const bouton = document.getElementById('copier-liste-courses');
  try {
    await copierTexte(texte);
    if (bouton) bouton.textContent = 'Copié ✓';
  } catch (e) {
    if (bouton) bouton.textContent = 'Échec de la copie';
    console.warn('[liste de courses] copie impossible :', e);
  }
  if (bouton) setTimeout(() => { bouton.textContent = '📋 Copier'; }, 1500);
}

function rendreListeCoursesParIngredient(lignes) {
  return '<ul class="liste-courses">' + lignes.map((l) => `
        <li>
          <span class="course-nom">${echapperHtml(l.nom)}</span>
          <span class="course-montants">${l.montants.map((m) => `
            <span class="course-montant">${echapperHtml(m.texte)}${
              l.montants.length > 1 ? ` <small>(${m.titres.map((t) => echapperHtml(t)).join(', ')})</small>` : ''
            }</span>`).join('')}
          </span>
        </li>`).join('') + '</ul>';
}

function rendreListeCoursesParRecette(groupes) {
  return groupes.map((g) => `<h2>${echapperHtml(g.titre)}</h2>` + (
    g.lignes.length
      ? '<ul class="liste-courses">' + g.lignes.map((l) => `
        <li>
          <span class="course-nom">${echapperHtml(l.nom)}</span>
          <span class="course-montants">${
            l.montant ? `<span class="course-montant">${echapperHtml(l.montant)}</span>` : ''
          }</span>
        </li>`).join('') + '</ul>'
      : '<p class="modale-chargement">Aucun ingrédient.</p>'
  )).join('');
}

function rendreListeCourses({ lignes, groupes, titres, mode }) {
  const vide = mode === 'recette' ? !groupes.some((g) => g.lignes.length) : !lignes.length;
  const corps = vide
    ? '<p class="modale-chargement">Aucun ingrédient.</p>'
    : (mode === 'recette' ? rendreListeCoursesParRecette(groupes) : rendreListeCoursesParIngredient(lignes));

  const tri = `<div class="liste-courses-tri" role="group" aria-label="Regrouper par">` +
    `<button type="button" class="tri-btn${mode === 'ingredient' ? ' actif' : ''}" data-mode="ingredient">Par ingrédient</button>` +
    `<button type="button" class="tri-btn${mode === 'recette' ? ' actif' : ''}" data-mode="recette">Par recette</button>` +
    `</div>`;

  return `<div class="modale-entete-liste-courses">` +
    `<h1>Liste de courses</h1>` +
    `<div class="liste-courses-controles">` +
    tri +
    (vide ? '' : `<button type="button" id="copier-liste-courses">📋 Copier</button>`) +
    `</div>` +
    `</div>` +
    `<p class="modale-sous-titre">${titres.map((t) => echapperHtml(t)).join(' · ')}</p>` +
    corps;
}

function ouvrirListeCourses() {
  if (!selection.size) return;
  const overlay = document.getElementById('overlay');
  const contenu = document.getElementById('modale-contenu');
  slugModaleCourante = null;  // pas une recette : évite tout conflit avec le garde-fou d'ouvrirRecette
  overlay.classList.add('actif');

  const slugs = [...selection];
  const titres = slugs.map((s) => recettes.find((r) => r.slug === s)?.titre).filter( Boolean);
  const lignes = construireListeCourses(slugs);
  const groupes = construireListeCoursesParRecette(slugs);

  let mode = 'ingredient';

  const rendre = () => {
    contenu.innerHTML = rendreListeCourses({ lignes, groupes, titres, mode });
    document.getElementById('modale').scrollTop = 0;

    const bouton = document.getElementById('copier-liste-courses');
    if (bouton) {
      bouton.addEventListener('click', () => copierListeCourses(
        mode === 'recette' ? texteListeCoursesParRecette(groupes) : texteListeCourses(lignes)
      ));
    }
    contenu.querySelectorAll('.tri-btn').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.mode === mode) return;
        mode = b.dataset.mode;
        rendre();
      });
    });
  };

  rendre();
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
    if (e.target.closest('.carte-select')) return;  // géré par l'event 'change' ci-dessous
    const carte = e.target.closest('.carte');
    if (carte) ouvrirRecette(carte.dataset.slug);
  });
  document.getElementById('grille').addEventListener('change', (e) => {
    const cb = e.target.closest('.carte-select-cb');
    if (!cb) return;
    const carte = cb.closest('.carte');
    if (cb.checked) selection.add(carte.dataset.slug);
    else selection.delete(carte.dataset.slug);
    carte.classList.toggle('carte--selectionnee', cb.checked);
    majBarreSelection();
  });
  document.getElementById('ouvrir-liste-courses').addEventListener('click', ouvrirListeCourses);
  document.getElementById('vider-selection').addEventListener('click', viderSelection);
}

init();
