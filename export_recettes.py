"""
Archive le dossier `recettes/` dans un zip horodaté sous `dist/`.

Sert à sauvegarder la collection à part (le contenu de `recettes/` n'est pas
versionné, cf. .gitignore). Le zip contient un dossier `recettes/` à la racine
avec tous les sous-dossiers de recettes (recette.md + images).

Lancement :
    python export_recettes.py

Nom produit : dist/recette-hellofresh-HH-MM-DD-MM-YYYY.zip
              (heure-minute-jour-mois-annee, à l'instant de l'export)

Options :
    --recettes-dir  dossier source     (défaut : <racine>/recettes)
    --dist-dir      dossier de sortie  (défaut : <racine>/dist)
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from datetime import datetime
from pathlib import Path

RACINE = Path(__file__).resolve().parent


def exporter(recettes_dir: Path, dist_dir: Path) -> Path:
    if not recettes_dir.is_dir():
        sys.exit(f"Dossier introuvable : {recettes_dir}")

    dist_dir.mkdir(parents=True, exist_ok=True)
    nom = datetime.now().strftime("recette-hellofresh-%H-%M-%d-%m-%Y.zip")
    cible = dist_dir / nom

    fichiers = sorted(p for p in recettes_dir.rglob("*") if p.is_file())
    if not fichiers:
        sys.exit(f"Aucun fichier à archiver dans {recettes_dir}")

    with zipfile.ZipFile(cible, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in fichiers:
            zf.write(f, Path("recettes") / f.relative_to(recettes_dir))

    return cible


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--recettes-dir", type=Path, default=RACINE / "recettes")
    parser.add_argument("--dist-dir", type=Path, default=RACINE / "dist")
    args = parser.parse_args()

    cible = exporter(args.recettes_dir.resolve(), args.dist_dir.resolve())
    taille_mo = cible.stat().st_size / (1024 * 1024)
    print(f"Archive créée : {cible}  ({taille_mo:.1f} Mo)")


if __name__ == "__main__":
    main()
