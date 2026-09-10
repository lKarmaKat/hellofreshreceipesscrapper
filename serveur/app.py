"""
Serveur local de la collection de recettes.

Rôle :
  - découvre les dossiers  recettes/<slug>/recette.md
  - parse le frontmatter YAML avec python-frontmatter (PyYAML)
  - normalise (cuisine "a, b" -> ["a", "b"], champs absents -> valeurs sûres)
  - expose une API JSON, sert les images, sert le viewer (même origine -> pas de CORS)

Lancement :
    pip install -r requirements.txt
    python app.py                      # -> http://127.0.0.1:8000

Config (variables d'environnement, toutes optionnelles) :
    RECETTES_DIR   dossier des recettes   (défaut : <racine repo>/recettes)
    VIEWER_DIR     dossier du viewer      (défaut : <racine repo>/viewer)
    HOST           interface d'écoute     (défaut : 127.0.0.1)
    PORT           port TCP               (défaut : 8000)
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import frontmatter
from flask import Flask, abort, jsonify, send_from_directory
from werkzeug.exceptions import NotFound

# --------------------------------------------------------------------------- #
# Config                                                                       #
# --------------------------------------------------------------------------- #
RACINE = Path(__file__).resolve().parent.parent
RECETTES_DIR = Path(os.environ.get("RECETTES_DIR", RACINE / "recettes")).resolve()
VIEWER_DIR = Path(os.environ.get("VIEWER_DIR", RACINE / "viewer")).resolve()
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))

NOM_FICHIER_RECETTE = "recette.md"

app = Flask(__name__, static_folder=None)  # on gère nos routes statiques nous-mêmes
app.json.ensure_ascii = False   # accents lisibles dans les réponses JSON
app.json.sort_keys = False      # garde l'ordre des clés qu'on construit


# --------------------------------------------------------------------------- #
# Normalisation du frontmatter                                                 #
# --------------------------------------------------------------------------- #
def _humaniser_slug(slug: str) -> str:
    return slug.replace("-", " ").replace("_", " ").strip().capitalize()


def _liste_cuisines(valeur) -> list[str]:
    """`"mexican, italian"` -> `["mexican", "italian"]`. None / "" -> []."""
    if not valeur:
        return []
    elements = valeur if isinstance(valeur, list) else str(valeur).split(",")
    return [str(c).strip() for c in elements if str(c).strip()]


def _liste_objets(valeur) -> list[dict]:
    """tags / ingredients : ne garde que les entrées qui sont des mappings."""
    if not isinstance(valeur, list):
        return []
    return [dict(x) for x in valeur if isinstance(x, dict)]


def _liste_slugs(valeur) -> list[str]:
    """
    allergenes : force chaque item en str.
    Garde-fou YAML 1.1 (PyYAML) : `- no` / `- on` non quotés seraient parsés en bool.
    """
    if not isinstance(valeur, list):
        return []
    return [str(x).strip() for x in valeur if str(x).strip()]


def _resoudre_image(slug: str, chemin_relatif) -> str | None:
    """Chemin relatif du frontmatter -> URL absolue, ou None si le fichier manque."""
    if not chemin_relatif:
        return None
    rel = str(chemin_relatif).lstrip("/")
    if not (RECETTES_DIR / slug / rel).is_file():
        return None
    return f"/recettes/{slug}/{rel}"


def _liste_ingredients(valeur, slug: str) -> list[dict]:
    """
    Comme _liste_objets, mais la clé `image` de chaque ingrédient (chemin relatif
    `images/ingredient-*.png` écrit par le scraper) est résolue en URL absolue,
    ou None si le fichier n'est pas sur le disque (download best effort côté
    scraper). Clé laissée telle quelle si l'ingrédient n'a pas de visuel.
    """
    ingredients = _liste_objets(valeur)
    for ing in ingredients:
        if "image" in ing:
            ing["image"] = _resoudre_image(slug, ing.get("image"))
    return ingredients


_RE_IMG_CORPS = re.compile(r"!\[([^\]]*)\]\(\s*(?:\./)?images/")


def _absolutiser_images_corps(corps: str, slug: str) -> str:
    """`![x](images/step-1.jpg)` -> `![x](/recettes/<slug>/images/step-1.jpg)`."""
    return _RE_IMG_CORPS.sub(rf"![\1](/recettes/{slug}/images/", corps or "")


def normaliser(slug: str, post: "frontmatter.Post") -> tuple[dict, str | None]:
    """(frontmatter + contenu) -> dict prêt pour l'API. Retourne (recette, avertissement)."""
    meta = post.metadata if isinstance(post.metadata, dict) else {}
    avertissement = None

    titre = meta.get("titre")
    if not titre:
        titre = _humaniser_slug(slug)
        avertissement = "titre manquant dans le frontmatter"

    recette = {
        "slug": slug,
        "id": meta.get("id") or slug,
        "source": meta.get("source") or "manuel",
        "titre": titre,
        "sous_titre": meta.get("sous_titre"),
        "temps_total_min": meta.get("temps_total_min"),
        "temps_prepa_min": meta.get("temps_prepa_min"),
        "calories_kcal": meta.get("calories_kcal"),
        "proteines_g": meta.get("proteines_g"),
        "glucides_g": meta.get("glucides_g"),
        "lipides_g": meta.get("lipides_g"),
        "difficulte": meta.get("difficulte"),
        "portions": meta.get("portions"),
        "cuisine": _liste_cuisines(meta.get("cuisine")),
        "tags": _liste_objets(meta.get("tags")),
        "allergenes": _liste_slugs(meta.get("allergenes")),
        "ingredients": _liste_ingredients(meta.get("ingredients"), slug),
        "image_principale": _resoudre_image(slug, meta.get("image_principale")),
        "url": meta.get("url"),
    }
    return recette, avertissement


# --------------------------------------------------------------------------- #
# Découverte / lecture des fichiers                                            #
# --------------------------------------------------------------------------- #
def _lire_post(fichier: Path) -> "frontmatter.Post":
    """Lecture UTF-8 explicite (l'encodage locale par défaut est peu fiable sous Windows)."""
    return frontmatter.load(str(fichier), encoding="utf-8")


def _dossier_recette(slug: str) -> Path | None:
    """Dossier d'une recette si `slug` désigne bien un enfant direct de RECETTES_DIR."""
    dossier = (RECETTES_DIR / slug).resolve()
    if dossier.parent != RECETTES_DIR or not dossier.is_dir():
        return None
    return dossier


def charger_recettes() -> tuple[list[dict], list[dict]]:
    """Re-scanne RECETTES_DIR à chaque appel. Retourne (recettes, erreurs)."""
    recettes: list[dict] = []
    erreurs: list[dict] = []

    if not RECETTES_DIR.is_dir():
        return recettes, [{"slug": None, "message": f"dossier introuvable : {RECETTES_DIR}"}]

    for dossier in sorted(RECETTES_DIR.iterdir()):
        if not dossier.is_dir():
            continue
        fichier = dossier / NOM_FICHIER_RECETTE
        if not fichier.is_file():
            continue

        slug = dossier.name
        try:
            post = _lire_post(fichier)
        except Exception as e:  # un .md cassé ne doit pas casser toute la liste
            erreurs.append({"slug": slug, "message": str(e).strip()})
            continue

        recette, avertissement = normaliser(slug, post)
        recette["_corps"] = post.content
        recettes.append(recette)
        if avertissement:
            erreurs.append({"slug": slug, "message": avertissement})

    recettes.sort(key=lambda r: (r["titre"] or "").lower())
    return recettes, erreurs


def _sans_corps(recette: dict) -> dict:
    return {k: v for k, v in recette.items() if k != "_corps"}


# --------------------------------------------------------------------------- #
# Routes API                                                                   #
# --------------------------------------------------------------------------- #
@app.get("/api/recettes")
def api_liste():
    recettes, erreurs = charger_recettes()
    reponse = jsonify({"recettes": [_sans_corps(r) for r in recettes], "erreurs": erreurs})
    reponse.headers["Cache-Control"] = "no-store"
    return reponse


@app.get("/api/recettes/<slug>")
def api_detail(slug: str):
    dossier = _dossier_recette(slug)
    fichier = dossier / NOM_FICHIER_RECETTE if dossier else None
    if not fichier or not fichier.is_file():
        return jsonify({"erreur": "recette introuvable", "slug": slug}), 404

    try:
        post = _lire_post(fichier)
    except Exception as e:
        return jsonify({"erreur": "recette illisible", "slug": slug, "message": str(e).strip()}), 422

    recette, _ = normaliser(slug, post)
    recette["corps"] = _absolutiser_images_corps(post.content, slug)
    reponse = jsonify(recette)
    reponse.headers["Cache-Control"] = "no-store"
    return reponse


# --------------------------------------------------------------------------- #
# Routes statiques : images des recettes + viewer                              #
# --------------------------------------------------------------------------- #
@app.get("/recettes/<path:chemin>")
def media_recette(chemin: str):
    if not RECETTES_DIR.is_dir():
        abort(404)
    return send_from_directory(RECETTES_DIR, chemin)  # rejette les ".." lui-même


@app.get("/")
def viewer_index():
    return _servir_viewer("index.html")


@app.get("/<path:fichier>")
def viewer_statique(fichier: str):
    return _servir_viewer(fichier)


def _servir_viewer(fichier: str):
    try:
        return send_from_directory(VIEWER_DIR, fichier)
    except NotFound:
        if fichier == "index.html":
            return _page_viewer_absent(), 200, {"Content-Type": "text/html; charset=utf-8"}
        raise


def _page_viewer_absent() -> str:
    return (
        "<h1>Viewer pas encore en place</h1>"
        f"<p>Dépose <code>index.html</code>, <code>style.css</code> et <code>app.js</code> "
        f"dans <code>{VIEWER_DIR}</code>.</p>"
        "<p>L'API tourne déjà : <a href='/api/recettes'>/api/recettes</a></p>"
    )


# --------------------------------------------------------------------------- #
# Point d'entrée                                                               #
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    # debug/reloader seulement en local ; jamais quand on expose sur le réseau (Pi)
    debug = HOST in ("127.0.0.1", "localhost", "::1")
    # ASCII uniquement : la console Windows (cp1252) casse les accents dans stdout
    print(f"recettes : {RECETTES_DIR}")
    print(f"viewer   : {VIEWER_DIR}")
    print(f"url      : http://{HOST}:{PORT}  (debug={debug})")
    app.run(host=HOST, port=PORT, debug=debug)
