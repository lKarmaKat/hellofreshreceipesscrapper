"""
Saisonnalite des recettes.

A partir de la liste d'ingredients d'une recette et de la table
`saison/legumes.json`, determine quels ingredients sont des legumes qui portent
la saisonnalite, et pour chacun ses mois de saison.

Le score "de saison" pour un mois donne est calcule cote viewer (il bouge avec
le curseur sans re-appel serveur) : ici on ne fait que fournir la matiere.

Matching : sur le slug anglais `type` de l'ingredient EN PRIORITE (cle stable
d'une recette a l'autre : "bell-pepper" couvre "Poivron", "Poivron rouge",
"Mini-poivrons"), avec repli sur le `nom` francais normalise pour les recettes
qui n'ont pas de `type` (celles scrapees avant l'ajout du champ, recettes
manuelles). Un ingredient inconnu de la table est simplement ignore ; le skill
/maj-legumes-saison sert a completer la table au fil des nouvelles recettes.
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

_FICHIER_TABLE = Path(__file__).resolve().parent / "saison" / "legumes.json"

# Cache : rechargé seulement si le mtime du fichier change (edition a chaud OK).
_cache: dict = {"mtime": None, "legumes": {}, "alias": {}}


def _charger_table() -> tuple[dict, dict]:
    try:
        mtime = _FICHIER_TABLE.stat().st_mtime
    except OSError:
        return {}, {}
    if _cache["mtime"] != mtime:
        try:
            data = json.loads(_FICHIER_TABLE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return _cache["legumes"], _cache["alias"]
        _cache["legumes"] = data.get("legumes", {}) if isinstance(data, dict) else {}
        _cache["alias"] = data.get("alias", {}) if isinstance(data, dict) else {}
        _cache["mtime"] = mtime
    return _cache["legumes"], _cache["alias"]


def _clef(valeur) -> str:
    """
    Nom FR -> clef de table. 'Poivron rouge (mini)' -> 'poivron rouge'
    minuscules, accents retires, parentheses retirees, ponctuation -> espace.
    """
    s = unicodedata.normalize("NFKD", str(valeur or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"\([^)]*\)", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.strip()


def _clef_type(valeur) -> str:
    """
    Slug `type` HelloFresh -> clef de table, tiret conserve ('bell-pepper').
    """
    s = unicodedata.normalize("NFKD", str(valeur or "").strip().lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9-]+", "-", s).strip("-")


def _resoudre(ing: dict, legumes: dict, alias: dict):
    """
    Retourne la valeur de table pour un ingredient, ou None si inconnu.
    `type` (slug anglais, cle stable) d'abord, `nom` (FR normalise) en repli.
    """
    for clef in (_clef_type(ing.get("type")), _clef(ing.get("nom"))):
        if not clef:
            continue
        clef = alias.get(clef, clef)
        if clef in legumes:
            return legumes[clef]
    return None


def analyser(ingredients) -> dict:
    """
    -> {
         "legumes_saisonniers": [ { "nom": "Courgette", "mois": [5,6,7,8,9,10] }, ... ],
         "legumes_toute_annee": [ "Carotte", ... ],
         "applicable": bool          # au moins un legume identifie
       }
    """
    legumes, alias = _charger_table()
    saisonniers: list[dict] = []
    toute_annee: list[str] = []
    vus: set[str] = set()

    for ing in ingredients or []:
        if not isinstance(ing, dict):
            continue
        nom = ing.get("nom")
        clef = _clef(nom)
        if clef in vus:
            continue
        valeur = _resoudre(ing, legumes, alias)
        if valeur is None or valeur == "ignore":
            continue
        vus.add(clef)
        if valeur == "toute-annee":
            toute_annee.append(nom)
        elif isinstance(valeur, list):
            mois = sorted({int(m) for m in valeur if isinstance(m, (int, float)) and 1 <= m <= 12})
            if mois:
                saisonniers.append({"nom": nom, "mois": mois})

    return {
        "legumes_saisonniers": saisonniers,
        "legumes_toute_annee": toute_annee,
        "applicable": bool(saisonniers or toute_annee),
    }


# Mots qui trahissent un ingrédient qui n'est PAS un légume/fruit portant la
# saison (épicerie, protéines, laitages, féculents...). Sert seulement à trier
# la sortie de l'audit : un mot ici => rangé dans "probablement hors-sujet".
_MOTS_HORS_SUJET = {
    "huile", "vinaigre", "sauce", "bouillon", "cube", "sucre", "cassonade", "miel",
    "farine", "chapelure", "panko", "moutarde", "mayonnaise", "aioli", "aioli",
    "creme", "lait", "beurre", "yaourt", "fromage", "cheddar", "mozzarella", "burrata",
    "parmesan", "parmigiano", "grana", "cantal", "feta", "ricotta", "chevre", "gouda",
    "epices", "epice", "paprika", "cumin", "curry", "curcuma", "ras", "hanani", "garam",
    "masala", "thym", "origan", "romarin", "laurier", "herbes", "gomasio", "sesame",
    "poivre", "sel", "piment", "citronnelle", "gingembre",
    "poulet", "boeuf", "b uf", "porc", "dinde", "canard", "veau", "agneau", "jambon",
    "lardons", "chorizo", "nduja", "boudin", "saucisse", "chipolata", "merguez",
    "viande", "farce", "kefta", "steak", "bavette", "paupiette", "coppa", "poitrine",
    "saumon", "lieu", "cabillaud", "haddock", "crevettes", "crevette", "poisson", "thon",
    "riz", "pates", "penne", "fusilli", "rigatoni", "spaghetti", "linguine", "tagliatelle",
    "conchiglie", "orzo", "nouilles", "udon", "boulgour", "semoule", "couscous", "freekeh",
    "quinoa", "lentilles", "pois", "chiches", "haricots blancs", "haricots rouges",
    "edamame", "gnocchi", "polenta", "naan", "tortilla", "tortillas", "pain", "bagel",
    "burger", "pate", "pesto", "tapenade", "houmous", "guacamole", "tzatziki", "labneh",
    "sarasson", "oeuf", "uf", "cacao", "chocolat", "cacahuetes", "cacahuete", "noix",
    "cajou", "amandes", "pignons", "pistaches", "graines", "raisins", "cranberries",
    "sultanines", "avoine",
}


def _probablement_produit(clef: str) -> bool:
    mots = set(clef.split())
    return not (mots & _MOTS_HORS_SUJET)


def _audit() -> int:
    """
    `python saison.py` : passe en revue tous les ingrédients de la collection et
    liste ceux qui ne sont PAS couverts par saison/legumes.json (ni table ni
    alias), en séparant les candidats "probablement un légume/fruit" du reste.
    Moteur du skill /maj-legumes-saison.
    """
    import collections

    import app  # RECETTES_DIR + lecture des .md ; import tardif (évite le cycle)

    legumes, alias = _charger_table()
    connus = collections.Counter()
    inconnus = collections.Counter()
    exemples: dict[str, str] = {}
    type_par_nom: dict[str, str] = {}

    recettes, _ = app.charger_recettes()
    for r in recettes:
        for ing in r.get("ingredients") or []:
            nom = (ing or {}).get("nom")
            if not nom:
                continue
            if (ing or {}).get("type"):
                type_par_nom.setdefault(nom, ing["type"])
            if _resoudre(ing, legumes, alias) is not None:
                connus[nom] += 1
            else:
                inconnus[nom] += 1
                exemples.setdefault(nom, r["titre"])

    candidats = [(n, c) for n, c in inconnus.most_common() if _probablement_produit(_clef(n))]
    reste = [(n, c) for n, c in inconnus.most_common() if not _probablement_produit(_clef(n))]

    print(f"{len(recettes)} recettes  |  table : {len(legumes)} entrées, {len(alias)} alias")
    print(f"ingrédients couverts : {len(connus)} distincts\n")

    def _slug(nom: str) -> str:
        t = type_par_nom.get(nom)
        return f" type={t!r}" if t else ""

    print(f"=== À TRANCHER : {len(candidats)} candidats légume/fruit non couverts ===")
    print("(keyer la table sur le slug `type` quand il est là : plus robuste que le nom)\n")
    for nom, n in candidats:
        print(f"  {n:3}x  clef={_clef(nom)!r:28}{_slug(nom):24} {nom!r:38} ex. « {exemples[nom]} »")

    print(f"\n=== Probablement hors-sujet ({len(reste)}) — vérifier puis ignorer ===\n")
    for nom, n in reste:
        print(f"  {n:3}x  clef={_clef(nom)!r:28}{_slug(nom):24} {nom!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_audit())
