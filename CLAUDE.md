# HelloFresh Recipe Scraper

## Objectif du projet

Scraper les recettes disponibles sur HelloFresh et les rendre consultables hors-ligne :

1. **`script.js`** — Userscript (Tampermonkey/Greasemonkey) qui s'exécute sur hellofresh.fr, intercepte les IDs de recettes via les réponses fetch du site, récupère le détail de chaque recette via l'API interne HelloFresh, puis exporte un zip contenant pour chaque recette un dossier avec un `recette.md` (frontmatter YAML + instructions) et les images (image principale + une image par étape).
2. **`index.js`** *(à venir)* — Page/app pour visualiser les recettes exportées (parcourir les dossiers, afficher le markdown et les images).
3. **Serveur Python** *(à venir)* — Petit serveur local pour servir/découvrir les fichiers de recettes extraits, consommé par `index.js`.

## Règle de fonctionnement avec Claude

**Claude ne modifie pas le code de son propre chef.** Par défaut, Claude explore, explique, diagnostique et propose des changements, mais n'édite aucun fichier sans y avoir été explicitement invité.

Pour autoriser une modification, dire à Claude d'**"appliquer"** ou d'**"edit"** (ou formulation équivalente explicite). En dehors de ça, une demande d'aide, d'analyse ou de revue de code ne doit pas déclencher d'édition automatique.

## Notes techniques

- `script.js` dépend de JSZip (chargé via `@require` CDN) et des API `GM_*` (Tampermonkey/Violentmonkey).
- L'appel à l'API détail recette (`/gw/recipes/recipes/{id}`) nécessite un token Bearer valide (~30 min de durée de vie), à renseigner dans `ACCESS_TOKEN` en haut du fichier (jetable, ne pas commiter de vrai token).
- Les images sont reconstruites via `media.hellofresh.com` (préfixe `recipes` pour l'image principale, `hellofresh_s3` pour les étapes) plutôt que via les URLs Cloudfront renvoyées par l'API, qui étaient peu fiables (502).

## Fichiers d'exemple (fixtures API HelloFresh)

Ces fichiers ne sont pas exécutés ; ce sont des captures servant de référence pour connaître la forme exacte des réponses de l'API HelloFresh et adapter le code de scraping/parsing en conséquence.

- **`menu.json`** — Exemple de réponse interceptée par `unsafeWindow.fetch` dans `script.js` (la requête "menu" identifiée par la présence d'un champ `meals[]`). Contient `id`, `week`, et `meals[]` où chaque meal a un `recipe` avec `id`, `name`, `headline`, `image`, `websiteURL`, `tags`, `nutrition`, `cuisines`, etc. C'est cette réponse qui alimente `recettesInterceptees` (id + nom + semaine) avant l'appel détail.
- **`receipe_request.js`** — Exemple de requête `fetch` construite manuellement (format DevTools "Copy as fetch") vers `/gw/recipes/recipes/{id}?country=FR&locale=fr-FR`, avec les headers nécessaires (notamment `authorization: Bearer ...` et `x-requested-by: shopping-experience-web`). Sert de référence pour `fetchDetailRecette()` dans `script.js`.
- **`receipe_response.json`** — Exemple de réponse détail recette renvoyée par l'endpoint ci-dessus. Contient la structure complète utilisée par `construireFrontmatter()` / `construireCorps()` dans `script.js` : `ingredients[]`, `yields[]` (quantités par nombre de portions), `steps[]` (instructions + `images[]` avec `path`/`caption`), `nutrition[]`, `tags[]`, `allergens[]`, `utensils[]`, `totalTime`/`prepTime` (format ISO 8601 `PTxxHxxM`), etc.
