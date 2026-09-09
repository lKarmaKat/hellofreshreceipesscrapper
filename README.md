# HelloFresh Recipe Scraper

Scraper les recettes HelloFresh et les rendre consultables hors-ligne, dans une
collection qui accepte aussi des recettes ajoutées à la main.

## Composants

| | Rôle |
|---|---|
| `script.js` | Userscript (Tampermonkey) : intercepte les recettes sur hellofresh.fr, appelle l'API interne, exporte un zip `recette.md` + images par recette. |
| `serveur/` | Serveur Flask local : lit `recettes/`, normalise, expose une API JSON + les images + le viewer. |
| `viewer/` | Page web (servie par le serveur sur `/`) : grille, recherche, filtres tags / cuisine, modale par recette. Vanilla JS + `marked`. |

Le format des `recette.md` et les détails d'architecture sont dans [CLAUDE.md](CLAUDE.md).

## Lancer le serveur

### Prérequis

Python 3.10+ (`python --version`).

### Installation (une seule fois)

**Windows (PowerShell)** — depuis la racine du projet :

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r serveur\requirements.txt
```

**macOS / Linux / Raspberry Pi :**

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r serveur/requirements.txt
```

> On appelle le Python du venv directement (`.venv\Scripts\python`), pas besoin
> d'« activer » le venv ni de toucher à l'execution policy PowerShell.

### Démarrer

**Windows :**

```powershell
.venv\Scripts\python serveur\app.py
```

**macOS / Linux :**

```bash
.venv/bin/python serveur/app.py
```

Puis ouvrir <http://127.0.0.1:8000> dans un navigateur — c'est le viewer.

`Ctrl+C` pour arrêter. En local, le serveur redémarre tout seul quand on modifie `app.py`.

### Configuration (variables d'environnement, toutes optionnelles)

| Variable | Défaut | Rôle |
|---|---|---|
| `RECETTES_DIR` | `./recettes` | dossier des recettes |
| `VIEWER_DIR` | `./viewer` | dossier du viewer |
| `HOST` | `127.0.0.1` | interface d'écoute |
| `PORT` | `8000` | port TCP |

Exemple pour exposer sur le réseau local (Raspberry Pi) :

```bash
HOST=0.0.0.0 PORT=8000 .venv/bin/python serveur/app.py
```

Le serveur Flask intégré suffit pour un usage perso local. Pour une machine
allumée en permanence (Raspberry Pi), passer plus tard par `waitress` ou
`gunicorn`.

## Ajouter des recettes

- **Depuis le scraper** : dézipper le contenu d'un export dans `recettes/`, de façon à obtenir `recettes/<slug>/recette.md` (+ `recettes/<slug>/images/`).
- **À la main** : créer `recettes/<mon-slug>/recette.md`. Seul le champ `titre` est obligatoire — voir le format dans [CLAUDE.md](CLAUDE.md).

Le serveur re-scanne `recettes/` à chaque requête : il suffit de rafraîchir la page, pas besoin de le redémarrer.

Le contenu de `recettes/` n'est **pas** versionné (voir `.gitignore`).

## API

| Route | Réponse |
|---|---|
| `GET /api/recettes` | liste (tous les champs sauf le corps) + erreurs de lecture |
| `GET /api/recettes/<slug>` | une recette complète, corps markdown inclus |
| `GET /recettes/<slug>/images/<fichier>` | image d'une recette |
| `GET /` | le viewer (page de repli tant que `viewer/` est vide) |
