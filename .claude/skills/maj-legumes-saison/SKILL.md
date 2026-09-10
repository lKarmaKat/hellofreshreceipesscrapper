---
name: maj-legumes-saison
description: >-
  Met à jour serveur/saison/legumes.json (calendrier de saisonnalité) en repérant
  les ingrédients des recettes qui n'y sont pas encore classés. À lancer après
  avoir ajouté des recettes. N'invente jamais une saison en silence : propose,
  puis attend validation avant d'écrire.
---

# Mettre à jour la table de saisonnalité des légumes

`serveur/saison/legumes.json` associe chaque légume/fruit à ses mois de saison
(France, pleine terre). Le serveur s'en sert pour le filtre « Légumes de saison »
du viewer. Quand de nouvelles recettes arrivent, elles peuvent contenir des
ingrédients (ou des variantes de nom) que la table ne connaît pas encore : ce
skill les repère et les fait classer.

## Rôle de Claude ici

Ce skill **autorise l'édition de `serveur/saison/legumes.json`** (et de lui seul).
Il n'édite aucun autre fichier. Il ne classe jamais un ingrédient sans validation
explicite de l'utilisateur — surtout pas les mois de saison, qui sont un choix.

## Procédure

### 1. Lancer l'audit

```
cd serveur && ../.venv/Scripts/python.exe saison.py      # Windows
cd serveur && ../.venv/bin/python saison.py              # Linux / RPi
```

(le venv est celui de `serveur/requirements.txt` ; si `python saison.py` marche
directement, c'est bon aussi.)

L'audit lit toutes les recettes via `app.charger_recettes()`, normalise chaque
nom d'ingrédient avec `saison._clef()` (minuscules, sans accents, parenthèses
retirées), et affiche deux listes des ingrédients **non couverts** (ni dans
`legumes`, ni via `alias`) :

- **« À TRANCHER »** — candidats légume/fruit (le nom ne contient aucun mot
  d'épicerie / protéine / laitage connu). C'est la liste à traiter.
- **« Probablement hors-sujet »** — le reste (huile, sauce, poulet, riz…).
  À parcourir en diagonale : si un vrai légume s'y cache (raté par l'heuristique),
  le traiter aussi ; sinon l'ignorer.

Si « À TRANCHER » est vide et que rien ne traîne dans l'autre liste : **stop**,
la table est à jour, le dire et ne rien éditer.

### 2. Proposer une classification

Pour chaque ingrédient à traiter, présenter à l'utilisateur une proposition
parmi :

| Classe | Valeur dans `legumes.json` | Quand |
|---|---|---|
| légume saisonnier | `[mois...]` (ex. `[6,7,8,9,10]`) | légume/fruit dont la dispo locale varie fortement dans l'année |
| toute l'année | `"toute-annee"` | cultivé / stocké toute l'année en France (carotte, champignon de couche, pomme de terre, chou…) — compte dans le score, toujours « de saison » |
| hors-sujet | `"ignore"` | aromate en petite quantité, herbe, légumineuse sèche, fruit d'import, produit transformé — ne compte pas |
| variante | entrée dans `alias` : `"clef normalisée": "clef cible"` | autre **nom** d'un légume déjà présent, quand aucun `type` n'est dispo (« Tomates cerises » → `tomate`). Si un `type` existe, keyer la cible dessus rend l'alias inutile. |

La clef d'une entrée peut être un nom FR normalisé **ou** un slug `type` (`bell-pepper`) — `_resoudre()` teste les deux. Choisir le `type` quand l'audit en montre un.

Pour les mois : proposer une fenêtre issue du calendrier **France métropolitaine,
culture pleine terre**, en disant clairement que c'est indicatif et à ajuster.
Ne pas écrire de mois sans accord.

Présenter tout le lot d'un coup (tableau), pas ingrédient par ingrédient.

### 3. Écrire après validation

Une fois les choix confirmés, éditer `serveur/saison/legumes.json` :

- ajouter les entrées dans `legumes` (garder le fichier lisible : légumes
  saisonniers par ordre alpha, puis fruits, puis le bloc `"ignore"` ; les alias
  dans `alias`) ;
- les **clefs** sont déjà normalisées : minuscules, sans accents, sans
  ponctuation, espaces simples. Vérifier avec `saison._clef("Nom brut")` en cas
  de doute (ex. `"Gousse d'ail"` → `"gousse d ail"`).
- laisser `"_a_reviser": true` et le bloc `_doc` en place.

### 4. Revérifier

Relancer l'audit : « À TRANCHER » doit être vide. Signaler à l'utilisateur ce qui
a été ajouté et les recettes qui basculent « Hors catégorie » ↔ classées, s'il y
en a.

## Notes

- **Keyer sur le slug `type` dès qu'il est là.** Le scraper (`script.js`) écrit
  un `type:` (slug anglais HelloFresh) sur chaque ingrédient. `saison._resoudre()`
  matche sur `type` en priorité, puis sur `nom`. L'audit affiche le `type` quand
  il le connaît : une entrée keyée `"bell-pepper"` couvre « Poivron »,
  « Poivron rouge », « Mini-poivrons » d'un coup — préférer ça à trois entrées de
  noms ou à des alias. Garder une entrée `nom` seulement pour les ingrédients
  sans `type` (recettes scrapées avant l'ajout du champ, recettes manuelles).
- État actuel : toute la collection est ré-exportée, la table est keyée sur les
  slugs `type` ; les entrées de noms FR ne servent plus que de repli pour de
  futures recettes manuelles, et `alias` est vide.
- La table est volontairement petite : n'y mettre que ce qui apparaît vraiment
  dans la collection. Pas de pré-remplissage « au cas où ».
