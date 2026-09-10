// ==UserScript==
// @name         HelloFresh - Export recettes en Markdown
// @namespace    hf-export-recettes
// @version      1.0
// @description  Intercepte les recettes du menu, récupère le détail via l'API, exporte en zip (markdown + images)
// @match        https://www.hellofresh.fr/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      media.hellofresh.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// ==/UserScript==

(function () {
  'use strict';

  // JSZip 3.x planifie son travail asynchrone via setImmediate quand il existe.
  // Dans le bac à sable Tampermonkey, setImmediate est présent mais ne se déclenche
  // jamais => zip.generateAsync() ne résout jamais. On le remplace par un shim
  // setTimeout. (Doit rester : sans ça, la génération du zip se fige.)
  if (typeof setImmediate === 'function') {
    setImmediate = (callback, ...args) => setTimeout(callback, 0, ...args);
  }

  // ==================== CONFIG ====================
  // Colle ton token d'accès ici avant de lancer un export (valable ~30 min).
  // DevTools > Network > n'importe quelle requête vers hellofresh.fr > Headers
  // > "authorization" > copie tout ce qui suit "Bearer " (sans le mot "Bearer").
  const ACCESS_TOKEN = '';

  // Nombre de portions à utiliser pour les quantités d'ingrédients dans le markdown
  const PORTIONS_CIBLE = 2;

  // Pause entre deux appels réseau (recette / image), pour rester poli avec l'API
  const PAUSE_MS = 5;

  // Nombre d'images téléchargées en parallèle par recette (hero + étapes + vignettes
  // d'ingrédients confondus). C'est cette limite de concurrence qui joue le rôle de
  // garde-fou de politesse vis-à-vis du CDN, à la place d'une pause par image.
  const IMAGES_EN_PARALLELE = 5;

  // Largeur cible des images téléchargées (paramètre w_XXX du CDN media.hellofresh.com)
  const LARGEUR_IMAGE = 480;

  // Les images d'ingrédients sont de petites vignettes détourées (200x200 natif).
  const LARGEUR_IMAGE_INGREDIENT = 200;

  const CLE_STOCKAGE = 'hf_recettes_exportees'; // { [id]: 'hh:mm-dd/MM/yyyy' }

  // ==================== INTERCEPTION DES IDS DE RECETTES ====================
  // On détecte la réponse "menu" par sa forme (présence d'un champ meals[]),
  // peu importe l'URL exacte qui l'a renvoyée.
  unsafeWindow.recettesInterceptees = unsafeWindow.recettesInterceptees || new Map();

  const pageFetch = unsafeWindow.fetch.bind(unsafeWindow);

  unsafeWindow.fetch = async function (...args) {
    const response = await pageFetch(...args);

    response.clone().json().then((data) => {
                let i = 0;

      if (data && Array.isArray(data.meals)) {
        console.log("data.meals existent");
        for (const meal of data.meals) {
            //if (i > 3) break;
            i++;
          const r = meal.recipe;
          if (r?.id) {
            // On capture `cuisines` dès le menu : la réponse détail donne un `slug`
            // propre mais un `name` non localisé, le menu donne le libellé FR + souvent
            // le slug (`type`). construireCuisines() fusionne les deux.
            unsafeWindow.recettesInterceptees.set(r.id, {
              id: r.id,
              nom: r.name,
              week: data.week,
              cuisines: Array.isArray(r.cuisines) ? r.cuisines : []
            });
          }
        }
        majBoutonExport();
      }
    }).catch(() => {}); // réponses non-JSON (images, etc.) : on ignore

    return response;
  };

  // ==================== STOCKAGE DES EXPORTS DÉJÀ FAITS ====================
  function getRecettesExportees() {
    return GM_getValue(CLE_STOCKAGE, {});
  }

  function marquerCommeExportees(ids) {
    const exportees = getRecettesExportees();
    const dateStr = formatDate(new Date());
    for (const id of ids) exportees[id] = dateStr;
    GM_setValue(CLE_STOCKAGE, exportees);
  }

  function formatDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}-${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  // ==================== UI : BOUTONS FLOTTANTS ====================
  function creerBoutons() {
    if (document.getElementById('hf-conteneur-boutons')) return; // évite les doublons si le script se relance

    const conteneur = document.createElement('div');
    conteneur.id = 'hf-conteneur-boutons';
    conteneur.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
      display: flex; flex-direction: column; gap: 8px; font-family: sans-serif;
    `;

    const btnExport = document.createElement('button');
    btnExport.id = 'hf-btn-export';
    styliserBouton(btnExport, '#c1440e');
    btnExport.addEventListener('click', lancerExport);

    const btnListe = document.createElement('button');
    btnListe.id = 'hf-btn-liste';
    btnListe.textContent = 'Lister recettes exportées (console)';
    styliserBouton(btnListe, '#333333');
    btnListe.addEventListener('click', afficherListeExportees);

    conteneur.appendChild(btnExport);
    conteneur.appendChild(btnListe);
    document.body.appendChild(conteneur);

    majBoutonExport();
  }

  function styliserBouton(btn, couleur) {
    btn.style.cssText = `
      padding: 10px 16px; border: none; border-radius: 8px;
      background: ${couleur}; color: white; font-size: 13px; font-weight: 600;
      cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    `;
  }

  function majBoutonExport() {
    const btn = document.getElementById('hf-btn-export');
    if (!btn) return;
    const interceptees = unsafeWindow.recettesInterceptees || new Map();
    const exportees = getRecettesExportees();
    const nouvelles = [...interceptees.keys()].filter((id) => !exportees[id]);

    if (!btn.dataset.enCours) {
      btn.textContent = `Exporter (${nouvelles.length} nouvelles / ${interceptees.size} interceptées)`;
      btn.disabled = nouvelles.length === 0;
      btn.style.opacity = nouvelles.length === 0 ? '0.5' : '1';
    }
  }

  function afficherListeExportees() {
    const exportees = getRecettesExportees();
    const entrees = Object.entries(exportees);
    if (entrees.length === 0) {
      console.log('[Recettes] Aucune recette exportée pour le moment.');
      return;
    }
    console.log(`[Recettes] ${entrees.length} recette(s) exportée(s) :`);
    console.table(entrees.map(([id, date]) => ({ id, date })));
  }

  // ==================== APPEL API DÉTAIL RECETTE ====================
  async function fetchDetailRecette(id) {
    const res = await unsafeWindow.fetch(
      `https://www.hellofresh.fr/gw/recipes/recipes/${id}?country=FR&locale=fr-FR`,
      {
        headers: {
          accept: '*/*',
          authorization: `Bearer ${ACCESS_TOKEN}`,
          'x-requested-by': 'shopping-experience-web'
        },
        credentials: 'include'
      }
    );
    if (res.status === 401) {
      throw new Error('Token expiré ou invalide (401) — remets un token à jour dans ACCESS_TOKEN.');
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} pour la recette ${id}`);
    }
    return res.json();
  }

  // ==================== TÉLÉCHARGEMENT IMAGE (domaine CDN cross-origin) ====================
  // Reconstruit l'URL via media.hellofresh.com à partir du chemin relatif (imagePath / path)
  // renvoyé par l'API, plutôt que d'utiliser l'URL cloudfront directe (imageLink / link)
  // qui a renvoyé des 502 de façon répétée.
  // Le préfixe diffère selon le type d'image : "recipes" pour l'image principale
  // de recette, "hellofresh_s3" pour les images d'étapes et les vignettes
  // d'ingrédients (chemin `/ingredient/<id>-<hash>.png`).
  function construireUrlImage(prefixe, cheminRelatif, largeur = LARGEUR_IMAGE) {
    return `https://media.hellofresh.com/w_${largeur},q_auto,f_auto,c_limit,fl_lossy/${prefixe}${cheminRelatif}`;
  }

  async function telechargerImage(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        onload: async  (res) => {
          if (res.status >= 200 && res.status < 300) {
              //const arrayBuffer = await res.response.arrayBuffer();
              //resolve(arrayBuffer);
                        const buffer = await res.response.arrayBuffer();

                        const octets = new Uint8Array(buffer); // Uint8Array natif à NOTRE realm, indépendamment de l'origine du buffer
          resolve(octets);

          }
          else reject(new Error(`Image HTTP ${res.status} : ${url}`));
        },
        onerror: () => reject(new Error(`Échec réseau image : ${url}`))
      });
    });
  }

  // ==================== UTILITAIRES ====================
  function slugify(texte) {
    return texte
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // Nom de fichier stable pour la vignette d'un ingrédient : `ingredient-<slug>.png`.
  // On repasse le slug HelloFresh par slugify() pour garantir le jeu de caractères
  // (le .md le référence tel quel, et le nom de dossier suit les mêmes règles).
  function nomFichierIngredient(meta) {
    const base = slugify(meta.slug || meta.name || meta.id || 'ingredient');
    return `ingredient-${base || 'x'}.png`;
  }

  // Fusionne les cuisines de la reponse detail et de la reponse menu en une liste
  // de slugs anglais dedupliques, separes par ", " (ex. "mexican, italian").
  // Cas frequent : une seule cuisine, voire aucune ("" => pas de filtre cuisine).
  //
  // Aucune source n'est fiable telle quelle : le `type` du menu est tantot un vrai
  // slug ("mexican"), tantot une copie du nom anglais ("Moroccan"), tantot absent
  // ("American", "Middle Eastern"). On passe donc tout par slugify(), et le Set
  // deduplique menu + detail (ex. menu "Moroccan" + detail slug "moroccan").
  // Priorite de la valeur retenue : slug detail > type > name.
  function construireCuisines(detail, infosMenu) {
    const slugs = new Set();
    for (const c of infosMenu?.cuisines || []) {
      const s = slugify(c.type || c.name || '');
      if (s) slugs.add(s);
    }
    for (const c of detail?.cuisines || []) {
      const s = slugify(c.slug || c.type || c.name || '');
      if (s) slugs.add(s);
    }
    return [...slugs].join(', ');
  }

  function parseDureeISO(iso) {
    const m = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
    if (!m) return null;
    return parseInt(m[1] || 0, 10) * 60 + parseInt(m[2] || 0, 10);
  }

  function trouverYieldPourPortions(recette, portions) {
    return recette.yields.find((y) => y.yields === portions) || recette.yields[recette.yields.length - 1];
  }

  function echapperYAML(texte) {
    return String(texte ?? '').replace(/"/g, '\\"');
  }

  // ==================== CONSTRUCTION DU MARKDOWN ====================
  function construireFrontmatter(recette, yieldChoisi, infosMenu) {
    const calories = recette.nutrition.find((n) => n.unit === 'kcal')?.amount;
    const proteines = recette.nutrition.find((n) => n.name === 'Protéines')?.amount;
    const glucides = recette.nutrition.find((n) => n.name === 'Glucides')?.amount;
    const lipides = recette.nutrition.find((n) => n.name === 'Matières grasses')?.amount;

    const ingredientsParId = new Map(recette.ingredients.map((i) => [i.id, i]));

    const lignesIngredients = yieldChoisi.ingredients
      .map((ing) => {
        const meta = ingredientsParId.get(ing.id);
        const nom = meta?.name || ing.id;
        const quantite = `${ing.amount ?? ''} ${ing.unit || ''}`.trim();
        const champs = [
          `nom: "${echapperYAML(nom)}"`,
          `quantite: "${echapperYAML(quantite)}"`
        ];
        // `image` seulement si l'API fournit un visuel. Le fichier est téléchargé
        // plus bas dans lancerExport() en best effort (cf. hero) : la clé reste
        // écrite même si le download échoue, le serveur la résout alors en null.
        if (meta?.imagePath) champs.push(`image: images/${nomFichierIngredient(meta)}`);
        return `  - { ${champs.join(', ')} }`;
      });

    const lignesTags = recette.tags.map((t) => `  - { nom: "${echapperYAML(t.name)}", type: ${t.type} }`);
    const lignesAllergenes = recette.allergens.map((a) => `  - ${a.type}`);

    // Liste YAML : `cle:` + éléments quand non vide, sinon `cle: []` sur une seule
    // ligne. L'ancien sentinelle `  - []` se parsait comme "liste contenant une
    // liste vide" avec un vrai parser YAML (gray-matter / PyYAML).
    const blocListe = (cle, elements) => (elements.length ? [`${cle}:`, ...elements] : [`${cle}: []`]);

    const lignes = [
      '---',
      'source: hellofresh',
      `id: ${recette.id}`,
      `titre: "${echapperYAML(recette.name)}"`,
      `sous_titre: "${echapperYAML(recette.headline)}"`,
      `temps_total_min: ${parseDureeISO(recette.totalTime) ?? ''}`,
      `temps_prepa_min: ${parseDureeISO(recette.prepTime) ?? ''}`,
      `calories_kcal: ${calories ?? ''}`,
      `proteines_g: ${proteines ?? ''}`,
      `glucides_g: ${glucides ?? ''}`,
      `lipides_g: ${lipides ?? ''}`,
      `difficulte: ${recette.difficulty ?? ''}`,
      `portions: ${yieldChoisi.yields}`,
      `cuisine: ${construireCuisines(recette, infosMenu)}`,
      'image_principale: images/hero.jpg',
      `url: "${echapperYAML(recette.websiteUrl)}"`,
      ...blocListe('tags', lignesTags),
      ...blocListe('allergenes', lignesAllergenes),
      ...blocListe('ingredients', lignesIngredients),
      '---',
      ''
    ];

    return lignes.join('\n');
  }

  function construireCorps(recette) {
    let corps = '## Instructions\n\n';

    for (const step of recette.steps) {
      const legende = step.images?.[0]?.caption || `Étape ${step.index}`;
      corps += `### ${step.index}. ${legende}\n\n`;

      if (step.images?.[0]) {
        corps += `![${legende}](images/step-${step.index}.jpg)\n\n`;
      }

      const lignesInstructions = (step.instructions || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      for (const ligne of lignesInstructions) {
        corps += `- ${ligne}\n`;
      }
      corps += '\n';
    }

    return corps;
  }
let tailleTotale = 0; // déclarée avant la boucle sur idsAExporter

  // ==================== PIPELINE D'EXPORT ====================
  async function lancerExport() {
    const btn = document.getElementById('hf-btn-export');
    const interceptees = unsafeWindow.recettesInterceptees || new Map();
    const exportees = getRecettesExportees();
    const idsAExporter = [...interceptees.keys()].filter((id) => !exportees[id]);

    if (idsAExporter.length === 0) {
      alert('Aucune nouvelle recette à exporter.');
      return;
    }
    if (!ACCESS_TOKEN || ACCESS_TOKEN === 'COLLE_TON_TOKEN_ICI') {
      alert("Renseigne d'abord ACCESS_TOKEN en haut du script (constante ACCESS_TOKEN).");
      return;
    }

    btn.dataset.enCours = '1';
    btn.disabled = true;

    const zip = new JSZip();
    const idsReussis = [];
    const echecs = []; // { id, nom, erreur }

    for (let i = 0; i < idsAExporter.length; i++) {
      const id = idsAExporter[i];
      btn.textContent = `Export ${i + 1}/${idsAExporter.length}...`;
      const nomConnu = interceptees.get(id)?.nom;

      try {
        const recette = await fetchDetailRecette(id);
        // Préfixe l'id de recette au slug : HelloFresh publie plusieurs variantes
        // d'une même recette (un ingrédient qui change selon les préférences) sous
        // un nom identique -> même slugify() -> collision de dossier. L'id (hex de
        // 24 car., jeu de caractères compatible slug) garantit l'unicité.
        const slug = `${recette.id}-${slugify(recette.name)}`;
        const dossier = zip.folder(slug);
        const dossierImages = dossier.folder('images');

        const yieldChoisi = trouverYieldPourPortions(recette, PORTIONS_CIBLE);
        const markdown = construireFrontmatter(recette, yieldChoisi, interceptees.get(id)) + construireCorps(recette);
        dossier.file('recette.md', markdown);
        // Toutes les images de la recette (hero + étapes + vignettes d'ingrédients)
        // passent par un pool à concurrence limitée (IMAGES_EN_PARALLELE) au lieu
        // d'une file strictement séquentielle. `critique: true` => un échec fait
        // échouer la recette (hero, étapes) ; `critique: false` => best effort, on
        // loggue et on continue (vignettes d'ingrédients).
        const jobsImages = [];

        if (recette.imagePath) {
          jobsImages.push({
            nomFichier: 'hero.jpg',
            url: construireUrlImage('recipes', recette.imagePath),
            critique: true
          });
        }

        for (const step of recette.steps) {
          for (const img of step.images || []) {
            if (!img.path) continue;
            jobsImages.push({
              nomFichier: `step-${step.index}.jpg`,
              url: construireUrlImage('hellofresh_s3', img.path),
              critique: true
            });
          }
        }

        // Dédup par nom de fichier : deux ingrédients distincts peuvent se réduire
        // au même slug (le .md pointera alors vers la même vignette).
        const metaIngredients = new Map(recette.ingredients.map((i) => [i.id, i]));
        const ingredientsFaits = new Set();
        for (const ing of yieldChoisi.ingredients) {
          const meta = metaIngredients.get(ing.id);
          if (!meta?.imagePath) continue;
          const nomFichier = nomFichierIngredient(meta);
          if (ingredientsFaits.has(nomFichier)) continue;
          ingredientsFaits.add(nomFichier);
          jobsImages.push({
            nomFichier,
            url: construireUrlImage('hellofresh_s3', meta.imagePath, LARGEUR_IMAGE_INGREDIENT),
            critique: false,
            nomIngredient: meta.name
          });
        }

        const resultatsImages = await mapConcurrent(jobsImages, IMAGES_EN_PARALLELE, async (job) => {
          const octets = await telechargerImage(job.url);
          dossierImages.file(job.nomFichier, octets);
          tailleTotale += octets.length;
        });

        resultatsImages.forEach((res, idx) => {
          if (res.status !== 'rejected') return;
          const job = jobsImages[idx];
          if (job.critique) throw res.reason; // hero / étape manquante => échec recette
          console.warn(`[Recettes] Vignette ingrédient ignorée (${job.nomIngredient}) : ${res.reason.message}`);
        });

        idsReussis.push(id);
      } catch (e) {
        console.error(`[Recettes] Échec export ${id} (${nomConnu || 'nom inconnu'}) :`, e);
        echecs.push({ id, nom: nomConnu || '(nom inconnu)', erreur: e.message });
      }

      await pause(PAUSE_MS);
    }

    console.log(`[Recettes] Boucle terminée : ${idsReussis.length} réussie(s), ${echecs.length} échouée(s). Génération du zip...`);

    try {
      if (idsReussis.length > 0) {
          console.log(`[Recettes] Taille totale des images avant zip : ${(tailleTotale / 1024 / 1024).toFixed(1)} Mo`);
        btn.textContent = 'Génération du zip...';
console.log('[Recettes] Contenu du zip avant compression :');
const entrees = [];
zip.forEach((cheminRelatif, fichier) => {
  entrees.push({ chemin: cheminRelatif, dossier: fichier.dir });
});
console.table(entrees);
console.log(`[Recettes] ${entrees.length} entrée(s) au total.`);
          const heartbeat = setInterval(() => {
  console.log('[Recettes] Toujours en cours de génération du zip...');
}, 2000);
        const contenuZip = await zip.generateAsync(
          { type: 'blob', compression: 'STORE' }, // STORE : pas de compression, inutile sur du JPEG déjà compressé, beaucoup plus rapide
          (metadata) => {
            btn.textContent = `Génération du zip... ${Math.round(metadata.percent)}%`;
          }
        );
clearInterval(heartbeat);
        btn.textContent = 'Zip fini';
        console.log(`[Recettes] Zip généré (${(contenuZip.size / 1024 / 1024).toFixed(1)} Mo), déclenchement du téléchargement...`);

        const url = URL.createObjectURL(contenuZip);
        const a = document.createElement('a');
        a.href = url;
        a.download = `recettes-hellofresh-${formatDate(new Date()).replace(/[:/]/g, '-')}.zip`;
        document.body.appendChild(a); // certains navigateurs exigent que l'élément soit dans le DOM pour déclencher le download
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        marquerCommeExportees(idsReussis);
        console.log('[Recettes] Téléchargement déclenché. Si rien ne s\'est passé, vérifie si le navigateur a bloqué le téléchargement (icône dans la barre d\'adresse, ou chrome://downloads).');
      }
    } catch (e) {
      console.error('[Recettes] Échec lors de la génération ou du téléchargement du zip :', e);
      alert(`Erreur lors de la génération du zip : ${e.message}\nVoir la console pour le détail.`);
    }

    // ==================== RÉSUMÉ FINAL ====================
    console.log(`[Recettes] Export terminé : ${idsReussis.length} importée(s), ${echecs.length} non importée(s).`);

    if (idsReussis.length > 0) {
      console.log('[Recettes] Recettes importées :');
      console.table(idsReussis.map((id) => ({ id, nom: interceptees.get(id)?.nom || '' })));
    }

    if (echecs.length > 0) {
      console.log('[Recettes] Recettes NON importées :');
      console.table(echecs);
    }

    delete btn.dataset.enCours;
    btn.disabled = false;
    majBoutonExport();
  }

  function pause(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // allSettled à concurrence limitée : applique `fn` à chaque item, au plus `limite`
  // en vol simultanément. Ne rejette jamais. Renvoie un tableau aligné sur `items`,
  // chaque entrée valant { status: 'fulfilled', value } ou { status: 'rejected', reason }.
  async function mapConcurrent(items, limite, fn) {
    const resultats = new Array(items.length);
    const enCours = new Set();

    for (let i = 0; i < items.length; i++) {
      const idx = i;
      const tache = (async () => {
        try {
          resultats[idx] = { status: 'fulfilled', value: await fn(items[idx], idx) };
        } catch (reason) {
          resultats[idx] = { status: 'rejected', reason };
        }
      })();
      enCours.add(tache);
      tache.then(() => enCours.delete(tache));

      if (enCours.size >= limite) await Promise.race(enCours);
    }

    await Promise.all(enCours);
    return resultats;
  }

  // ==================== INIT ====================
  function init() {
    creerBoutons();
    setInterval(majBoutonExport, 3000); // rafraîchit le compteur au fil des recettes interceptées
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();