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

## Override §6.5 — motion de démo (décidé par Dev B, 12/09)

Le spec §6.5 n'autorise que trois animations. **Pour la démo, cette règle est levée**, sur
décision explicite. La motion ajoutée reste bornée et documentée :

| motion | durée | déclencheur |
|---|---|---|
| indicateur de desk qui glisse | 180 ms ease | changement de route |
| bascule de vue (opacity + 4px) | 160 ms ease | changement de route, **jamais au premier paint** |
| hover/focus des contrôles (couleur, fond, bordure, opacité, transform) | 160 ms ease | pointeur / clavier |
| contenu de ligne qui se décale de 2px | 160 ms ease | hover de ligne |
| chevron du picker | 160 ms ease | ouverture |
| liste du picker | 160 ms ease | ouverture |
| point de la pill qui respire | 1.6 s infinite | **uniquement feed DOWN** |
| jauge de poll 2px qui se recharge | = intervalle réel (3000 ms) | chaque payload reçu ; figée si aucun |
| flash d'une cellule | 120 ms | **changement réel d'une valeur HTTP**, jamais un timer |
| barre NAV (spec) | 600 ms | changement de largeur |
| pulse `defaultable` (spec) | 2 s infinite | statut du prêt |
| opacité des bandes S3 (spec §S3) | 200 ms | beat |

### Second passage motion — 12/09 ~14:00, sur demande explicite de Dev B

« Rends le tout moins sobre. » Ajouté, toujours en CSS pur, sans lib, sans chiffre inventé :

| motion | durée | déclencheur |
|---|---|---|
| les lignes du book se distribuent en cascade | 320 ms, décalage 45 ms | arrivée du premier payload (montage, pas à chaque poll) |
| les panneaux s'assemblent en séquence | 300 ms, décalage 0→210 ms | changement de route |
| la sparkline se trace de gauche à droite | 900 ms | montage — **par un `clip-path`, jamais par `stroke-dasharray`** |
| le chiffre se soulève quand il change | 260 ms + flash 420 ms | changement réel d'une valeur HTTP |
| panneau qui répond au pointeur (bordure + fond) | 200 ms | survol |
| la photo se désature et zoome légèrement | 420 / 900 ms | survol |
| les chips se soulèvent d'1px | 160 ms | survol de ligne |
| anneau qui pulse autour du point de santé | 1.6 s infinite | **feed DOWN uniquement** |
| le verdict arrive en resserrant son tracking | 420 ms | montage |
| la bande S3 active avance de 2px | 220 ms | beat |

**Un piège rencontré et corrigé :** la première version traçait la sparkline avec
`stroke-dasharray`, ce qui **supprimait les pointillés de la lecture naïve**. Le contrat §6
fixe cette paire — naïf pointillé, correct plein — et interdit de l'inverser. Le tracé passe
maintenant par un `clip-path` sur un `<g>`, qui ne touche pas aux traits.

Toujours interdit et absent : bounce, spring, fade-in de page au mount, skeleton shimmer,
spinner, webfont non self-hostée, nouvelle lib. Tout tombe sous `prefers-reduced-motion: reduce`.

Le blotter fantôme (5 slots `Vault 1…5`) est **structurel** : chaque figure est un tiret cadratin.
Aucun id, aucun montant, aucun countdown n'y est inventé — un backend live peut servir d'autres
instruments que les cinq fixtures.

## Matière — assets committés (12/09)

Aucun hotlink : le wifi de salle est un risque et un asset distant qui tombe sur scène est
un échec visible. Tout est dans `app/public/assets/`, sources et licences dans son README.

| fichier | quoi | provenance |
|---|---|---|
| `operator-desk.jpg` | salle de contrôle BESSY II, 900×675, 145 Ko | Wikimedia Commons, **CC0**, auteur Nylki. Redimensionné et recompressé en local. |
| `grain.png` | grain 128×128 tuilable, overlay 5 %, inerte | **généré en local** par un script jetable, pas téléchargé |
| `mark.svg` | le sigle de la topbar | **dessiné pour ce projet**, délibérément pas la marque XRPL |
| `fonts/plex-*.woff2` | IBM Plex Sans variable + Plex Mono 400/500, subset latin, 60 Ko | **OFL 1.1**, self-hostées. Aucune requête réseau à l'exécution. |

### Webfonts : §6.2 relu, pas contourné

Le spec interdit les webfonts parce qu'« une police manquante sur scène est un échec
visible » — le risque décrit est le **réseau**, pas le fichier. Une fonte livrée dans le
bundle et servie depuis la même origine ne peut pas échouer sur le wifi de la salle. Les
stacks système restent en fallback avec `font-display: swap`, donc l'écran peint à la
première frame dans tous les cas. Décision prise par Dev B le 12/09.

**Pas de portraits.** Il n'existe aucun endroit humain dans cette app en lecture seule, et
coller cinq visages d'inconnus comme s'ils étaient l'équipe serait fabriquer des gens.

## Écarts assumés avec le brief générique

Pas d'animation d'entrée (§6.5 : « no fade-ins »). Pas de skeleton (§6.5, et §5.1 r.3 veut un
panneau d'instruction, pas un spinner). **Pas de seed data** : cinq vaults réels sont servis sur
`:8787`, et écrire un chiffre qui ne sort pas d'une réponse HTTP est l'interdit n°1 du projet.
Pas de CTA sur les états vides : le produit est en lecture seule, il n'y a rien à cliquer.

## Comment vérifier les types — piège

`pnpm --dir app exec tsc --noEmit` **ne vérifie rien**. Le `app/tsconfig.json` a `"files": []`
et délègue à des références de projet, donc sans `-b` TypeScript ne contrôle aucun fichier et
sort en succès. Un bug de typage est passé en production à cause de ça.

La vraie commande est celle du build :

```
pnpm --dir app build      # tsc -b && vite build
```

Toujours lancer ça avant de committer, jamais `tsc --noEmit` seul.
