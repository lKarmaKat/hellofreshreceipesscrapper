# HelloFresh Recipe Scraper

## Objectif du projet

Scraper les recettes HelloFresh et les rendre consultables hors-ligne, dans une collection qui accepte aussi des recettes ajoutées à la main :

1. **`script.js`** — Userscript (Tampermonkey/Greasemonkey) qui s'exécute sur hellofresh.fr, intercepte les IDs de recettes via les réponses fetch du site, récupère le détail de chaque recette via l'API interne HelloFresh, puis exporte un zip contenant pour chaque recette un dossier avec un `recette.md` (frontmatter YAML + instructions) et les images (image principale + une image par étape). Format décrit dans **[Format des recettes : dossier `recettes/`](#format-des-recettes--dossier-recettes)** ci-dessous.
2. **`index.js`** *(à venir)* — Page/app pour visualiser les recettes (parcourir les dossiers, afficher le markdown et les images, filtrer par cuisine / tags / temps).
3. **Serveur Python** *(à venir)* — Petit serveur local qui découvre et sert les dossiers de recettes, consommé par `index.js`.
4. **Assistant vocal** *(objectif long terme)* — Raspberry Pi avec écran, enceinte et micro, faisant tourner un modèle qui lit une recette et guide l'utilisateur pas à pas à la voix (« étape suivante », « répète », « combien de sel ? », substitutions d'ingrédients). C'est la raison de garder les instructions en **Markdown lisible** plutôt qu'en structure rigide : c'est le format que le modèle consomme le mieux, et les titres d'étapes `###` servent de points d'arrêt naturels.

**Principe de conception** : la collection doit accepter des recettes qui ne viennent pas de HelloFresh (saisies à la main, souvent sans images, sans `cuisine`, sans `tags`, sans `allergenes`, sans valeurs nutritionnelles). Seul `titre` est réellement obligatoire ; tout champ absent = information inconnue, la recette reste valide et affichable.

## Règle de fonctionnement avec Claude

**Claude ne modifie pas le code de son propre chef.** Par défaut, Claude explore, explique, diagnostique et propose des changements, mais n'édite aucun fichier sans y avoir été explicitement invité.

Pour autoriser une modification, dire à Claude d'**"appliquer"** ou d'**"edit"** (ou formulation équivalente explicite). En dehors de ça, une demande d'aide, d'analyse ou de revue de code ne doit pas déclencher d'édition automatique.

## Notes techniques

- `script.js` dépend de JSZip (chargé via `@require` CDN) et des API `GM_*` (Tampermonkey/Violentmonkey).
- L'appel à l'API détail recette (`/gw/recipes/recipes/{id}`) nécessite un token Bearer valide (~30 min de durée de vie), à renseigner dans `ACCESS_TOKEN` en haut du fichier (jetable, ne pas commiter de vrai token).
- Les images sont reconstruites via `media.hellofresh.com` (préfixe `recipes` pour l'image principale, `hellofresh_s3` pour les étapes) plutôt que via les URLs Cloudfront renvoyées par l'API, qui étaient peu fiables (502).
- **Cuisines** : le champ `cuisine` du frontmatter contient un ou plusieurs slugs anglais séparés par `, ` (ex. `cuisine: mexican, italian`). `construireCuisines()` (dans `script.js`) fusionne deux sources et déduplique via un `Set` :
  - réponse *menu* (`recipe.cuisines[]`, capturée dans `recettesInterceptees` dès l'interception) — forme `{ name, type }`, `{ name }` ou parfois `{ name, type }` avec `type` = copie du nom anglais ;
  - réponse *détail* (`cuisines[]`) — forme `{ id, type, name, slug, iconLink }`.
  - **Aucune valeur n'est un slug fiable telle quelle** : le `type` du menu est tantôt un vrai slug (`mexican`), tantôt le nom anglais capitalisé (`Moroccan`), tantôt absent (`American`, `Middle Eastern`). Tout passe donc par `slugify()`. Valeur retenue par entrée : `slug` (détail) > `type` > `name`.
  - Les données HelloFresh ont leurs propres incohérences qui ressortent telles quelles : `fusion` **et** `fusion-cuisine` coexistent, `vietnamise` (sic). À normaliser côté visualiseur si besoin, pas dans le scraper.
  - Le libellé FR localisé (« Mexicaine », « Japonaise ») n'existe que dans la réponse *menu* — non stocké dans le `.md`, mais récupérable si le visualiseur en a besoin.

## Format des recettes : dossier `recettes/`

Le dossier `recettes/` contient **toutes** les recettes : celles exportées par `script.js` **et** des recettes ajoutées à la main. `index.js` et le serveur Python lisent ce format.

### Parser : une vraie lib, pas un parser maison

Le frontmatter est du **YAML standard**, à lire avec une lib éprouvée :

- JS (`index.js`) : `gray-matter` (sépare frontmatter / corps) ou `js-yaml`.
- Python (serveur) : `python-frontmatter` + `PyYAML`.

Ne pas écrire de parser « ligne par ligne » maison. Une recette tapée à la main utilisera du YAML parfaitement valide que le scraper ne produit pas (listes inline `[a, b]`, chaînes multi-lignes, guillemets optionnels, objets sur plusieurs lignes, ordre des clés libre) ; un parser naïf casserait dessus. Avec une vraie lib, le format produit par `script.js` reste valide **et** les recettes manuelles sont tolérées.

### Arborescence

Une recette = un dossier sous `recettes/`, nommé par un slug (minuscules, tirets, sans accents) :

```
recettes/
  <slug-de-la-recette>/
    recette.md
    images/              (optionnel — absent pour une recette manuelle sans photos)
      hero.jpg
      step-1.jpg
      step-2.jpg
      ...
```

Le nom du dossier sert d'`id` de repli si le frontmatter n'en fournit pas.

### Frontmatter — champs

Seul **`titre`** est obligatoire. Tout le reste est optionnel : champ absent = information inconnue, `index.js` / le serveur affichent une valeur de repli ou masquent la ligne. Ne jamais supposer qu'un champ est présent.

| Champ | Oblig. | Type | Notes |
|---|:---:|---|---|
| `titre` | ✅ | texte | |
| `source` | — | `hellofresh` \| `manuel` | défaut `manuel` ; `script.js` le met à `hellofresh` |
| `id` | — | texte | défaut = nom du dossier |
| `sous_titre` | — | texte | |
| `portions` | — | nombre | base pour la mise à l'échelle des quantités |
| `temps_total_min`, `temps_prepa_min` | — | entier (minutes) | |
| `calories_kcal`, `proteines_g`, `glucides_g`, `lipides_g` | — | nombre | par portion |
| `difficulte` | — | nombre | échelle HelloFresh 1–3 |
| `cuisine` | — | slug(s) anglais séparés par `, ` | ex. `mexican, italian` ; vide = pas de filtre cuisine. Voir note « Cuisines » plus haut |
| `image_principale` | — | chemin relatif | ex. `images/hero.jpg` ; absent = pas d'image principale |
| `url` | — | texte | source d'origine si applicable |
| `tags` | — | liste `{ nom, type }` | `type` = slug ; vide/absent = aucun tag |
| `allergenes` | — | liste de slugs | ex. `gluten`, `egg`, `milk` |
| `ingredients` | — | liste `{ nom, quantite }` | `quantite` = chaîne libre : « 500 g », « 1 sachet(s) », « selon le goût » |

### Mise en forme produite par `script.js` (recettes HelloFresh)

Le scraper émet une sortie régulière — mais le parser **ne doit pas en dépendre**, il lit du YAML :

- textes libres entre guillemets doubles, `"` interne échappé `\"` ; nombres sans guillemets ;
- `cuisine` : slugs anglais séparés par `, ` (jamais une liste YAML) ;
- `tags` / `ingredients` : objets inline sur une ligne `- { nom: "…", type: … }` ;
- `allergenes` : un slug par ligne ;
- listes vides : `script.js` écrit `tags: []` sur une seule ligne (helper `blocListe`). L'ancien sentinelle `  - []` se parsait comme « liste contenant une liste vide » avec un vrai parser YAML — ne pas le réintroduire.

### Recette manuelle — minimum viable

```yaml
---
titre: "Soupe de courge rôtie"
portions: 4
ingredients:
  - { nom: "Courge butternut", quantite: "1 (~1 kg)" }
  - { nom: "Bouillon de légumes", quantite: "75 cl" }
---

## Instructions

### 1. Préparation
- Préchauffez le four à 200 °C.
- Épluchez et coupez la courge en cubes.

### 2. Cuisson
- Enfournez 30 min, puis mixez avec le bouillon chaud.
```

Suffisant pour l'affichage et pour le guidage vocal. Le reste (`cuisine`, `tags`, macros, images) s'ajoute quand l'info est disponible.

### Corps (après le second `---`)

```markdown
## Instructions

### <numéro>. <légende de l'étape>

![<légende>](images/step-<numéro>.jpg)

- <instruction 1>
- <instruction 2>
```

- Une section `###` par étape, numérotée dans l'ordre — ces titres sont les points d'arrêt de la navigation vocale (« étape suivante », « reviens à l'étape 2 »).
- Ligne `![...]` **uniquement** si l'étape a une image associée.
- Instructions : puces Markdown simples (`- `), une action par ligne (préférable). Une recette manuelle peut utiliser des paragraphes — le rendu et le modèle vocal s'en accommodent.

### Quantités structurées (plus tard, si besoin)

Si la mise à l'échelle automatique par portions devient nécessaire, ajouter des champs numériques optionnels aux ingrédients sans casser l'existant :
`- { nom: "Farine", quantite: "250 g", qte: 250, unite: "g" }`. Tant que ce n'est pas fait, le modèle vocal convertit lui-même à partir de `quantite` + `portions`.

## Fichiers d'exemple (fixtures API HelloFresh)

Ces fichiers ne sont pas exécutés ; ce sont des captures servant de référence pour connaître la forme exacte des réponses de l'API HelloFresh et adapter le code de scraping/parsing en conséquence.

- **`menu.json`** — Exemple de réponse interceptée par `unsafeWindow.fetch` dans `script.js` (la requête "menu" identifiée par la présence d'un champ `meals[]`). Contient `id`, `week`, et `meals[]` où chaque meal a un `recipe` avec `id`, `name`, `headline`, `image`, `websiteURL`, `tags`, `nutrition`, `cuisines`, etc. C'est cette réponse qui alimente `recettesInterceptees` (id + nom + semaine + `cuisines`) avant l'appel détail. `recipe.cuisines[]` : au plus une entrée par recette dans l'échantillon, forme `{ name: "Mexicaine", type: "mexican" }` (nom FR localisé + slug) ou parfois `{ name: "American" }` seul (nom anglais, sans `type`).
- **`receipe_request.js`** — Exemple de requête `fetch` construite manuellement (format DevTools "Copy as fetch") vers `/gw/recipes/recipes/{id}?country=FR&locale=fr-FR`, avec les headers nécessaires (notamment `authorization: Bearer ...` et `x-requested-by: shopping-experience-web`). Sert de référence pour `fetchDetailRecette()` dans `script.js`.
- **`receipe_response.json`** — Exemple de réponse détail recette renvoyée par l'endpoint ci-dessus. Contient la structure complète utilisée par `construireFrontmatter()` / `construireCorps()` dans `script.js` : `ingredients[]`, `yields[]` (quantités par nombre de portions), `steps[]` (instructions + `images[]` avec `path`/`caption`), `nutrition[]`, `tags[]`, `allergens[]`, `utensils[]`, `totalTime`/`prepTime` (format ISO 8601 `PTxxHxxM`), `cuisines[]` (forme `{ id, type, name, slug, iconLink }` — `slug` propre mais `name` souvent non localisé, ex. « Moroccan »), etc.
