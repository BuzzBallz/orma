# DESIGN — audit + direction

Stack réelle : **Vite + React + TS + une feuille `src/app.css`**. Pas de Next, pas de shadcn,
pas de `next/font`, pas de RSC. Le langage visuel est imposé par `docs/20-SPEC-FRONTEND.md` §6
(blotter crédit, terminal de desk) et il gagne sur toute préférence.

## Audit — ce qui cloche

1. `src/app.css` — **zéro `:focus-visible` dans toute la feuille**, un seul `:hover` (les lignes de
   table). Nav, `<select>`, en-têtes triables, liens explorer : aucun anneau de focus. Au clavier,
   sur scène, on ne sait pas où on est.
2. `src/screens/VaultList.tsx:71` — les lignes sont des `<tr onClick>` : ni focusables, ni
   activables au clavier. La navigation principale de S2 est souris-only.
3. `src/screens/VaultList.tsx:42` — en-têtes triables en `cursor:pointer` sans retour au survol ni
   `aria-sort`. On ne voit pas qu'ils sont cliquables.
4. `src/App.tsx` — `S4 oracle view — droppable, not built yet.` affiché à l'écran : le tell
   « template » le plus visible de l'app.
5. `src/components/Sparkline.tsx` — `collecting samples…` posé en absolu au milieu d'une boîte vide,
   non aligné sur la grille.
6. `src/screens/VaultList.tsx:35` — « divergence is the proof, the grade is the ranking » : slogan,
   pas une étiquette d'instrument.
7. `src/components/HeaderBar.tsx` — les liens de nav sont des mots en minuscule sans hover, état
   actif = 1px de soulignement. Trop faible pour un projecteur.
8. Pas d'élément signature formalisé : le couple **naïf pointillé `--muted` / correct plein
   `--accent`** est l'identité, et il n'existe qu'à deux endroits, réécrit à la main chaque fois.

## Ce qui est déjà bon — on garde

Palette de 12 tokens nommés, un seul thème sombre. Aucun violet, aucun glass, aucune ombre, aucun
dégradé. Polices **système** mono + sans — pas d'Inter, Roboto, Open Sans ni Space Grotesk (§6.2
interdit les webfonts : une police absente sur scène est un échec visible). Pas de trois cards
clonées, pas de hero marketing. Les états vides existent, portent une vraie phrase et ne sont
jamais masqués. Budget d'animation tenu : exactement trois. Chiffres tabulaires partout.

## Direction — on durcit l'existant, on ne rethème pas

- **Couleurs** : les 12 tokens de §6.1, inchangés. Aucune teinte nouvelle — le focus réutilise
  `--accent`.
- **Type** : deux stacks système, `--mono` pour tout chiffre, `--sans` pour la prose. La hiérarchie
  vient de l'échelle (96 / 72 / 56 / 24 / 18 / 14 / 12 / 11), pas d'une police achetée.
- **Signature répétée** : *la paire*. Lecture naïve = `--muted`, filet **pointillé**. Lecture
  correcte = `--accent`, filet **plein**. Deux classes (`.pair-naive` / `.pair-correct`) appliquées
  partout où les deux lectures cohabitent : NAV split, sparkline, colonne nav de la liste.
- **Interaction** : anneau de focus `--accent` 2px sur tout ce qui est atteignable au clavier,
  transitions 120 ms sur couleur/fond/bordure uniquement — jamais de translation, jamais d'ombre.

## Écarts assumés avec le brief générique

Pas d'animation d'entrée (§6.5 : « no fade-ins »). Pas de skeleton (§6.5, et §5.1 r.3 veut un
panneau d'instruction, pas un spinner). **Pas de seed data** : cinq vaults réels sont servis sur
`:8787`, et écrire un chiffre qui ne sort pas d'une réponse HTTP est l'interdit n°1 du projet.
Pas de CTA sur les états vides : le produit est en lecture seule, il n'y a rien à cliquer.
