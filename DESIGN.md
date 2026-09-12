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

## Chrome terminal — 12/09 ~15:00

Objectif : un terminal, pas un dashboard. Chrome volé à trois références clonées et lues
(`zakirkun/blossom-terminal`, `vaughanf1/BB-Terminal`, `feremabraz/bloomberg-terminal`) —
leur palette, pas leur code, et rien de leur métier.

Les trois convergent : ambre `#ff8c00`–`#ff9900` pour le chrome, rouge `#ff3b3b` pour le
risque, vert `#22ee22` pour le sain, fonds `#121212`–`#2a2a2a`.

### Tokens ajoutés

| token | valeur | rôle |
|---|---|---|
| `--amber` | `#FF9E2C` | **le mobilier** : labels, en-têtes, onglets, marque. 9.7:1 sur le fond. |
| `--amber-dim` | `#B4701C` | chrome secondaire, filets, touches. 5.0:1. |

L'ambre n'est **pas un signal**. Rouge = risque, vert = sain, cyan `--accent` = la lecture
correcte, et ce dernier n'est jamais recyclé en chrome — le contrat §6 fixe cette paire.
Écart assumé avec le « no other colours » du §6.1.

Recalibrés vers les références : `--ok` `#35D64A`, `--bad` `#FF4A4A`, fonds en noir neutre
plutôt que bleu-noir.

### Densité

Rang de table **52px → 26px**. Topbar 56 → 44. L'identité d'un instrument tient sur une
ligne (nom et id côte à côte) au lieu de deux. Les labels passent en `--mono` : un terminal
est monospace de bout en bout, et le tracking tombe de 0.12em à 0.08em parce que le mono
est déjà large.

### Librairie ajoutée

`lucide-react` — et rien d'autre. Utilisée tout de suite : le glyphe d'état du feed
(`Radio` en devnet, `Activity` en fixtures, `CircleAlert` en coupure) et le chevron du
picker.

**Tailwind et shadcn écartés, volontairement.** Ils auraient remplacé des composants déjà
écrits, testés et accessibles — le picker est un listbox clavier complet, la table a
`aria-sort` et des lignes activables, les onglets ont leur indicateur mesuré. Les échanger
contre du code neuf à ré-auditer quelques heures avant un gate est le mauvais pari, et le
look terminal vient de la densité et des tokens, pas d'un kit.

## Chasse aux bugs UI — `app/tools/ui-audit.js`

Le balayage que je faisais à la main est devenu un script. Zéro dépendance, il tourne
dans la page contre le vrai DOM et le vrai feed.

```
# l'app doit tourner, le feed aussi
await import('/tools/ui-audit.js')
await uiAudit()                              # tout, ~1 min
await uiAudit({ only: ['layout','contract'] })
```

Environ **70 vérifications**, en sept sections. Chacune imprime PASS/FAIL **avec la mesure
qui a tranché** — jamais un « ok » nu.

| section | ce qu'elle attrape |
|---|---|
| `layout` | débordement horizontal, contenu qui rend **hors de sa boîte** (le bug qui cachait la table de prêts de S1), `/moment` qui ne tient plus en un viewport, bande qui déborde, table qui scrolle ailleurs que dans son propre conteneur |
| `rendering` | `NaN`, `undefined`, `Invalid Date`, `[object Object]`, `null` visibles à l'écran, sur chaque vault × chaque écran |
| `contract` | les faits visuels que le contrat gèle : lecture naïve **pointillée**, correcte **pleine** (§6), barres de dimensions pilotées par la **note** et non la valeur (§S1.3), six dimensions dans l'ordre de l'API (§4.2) |
| `a11y` | tout contrôle atteignable, **anneau de focus sur chacun**, `aria-sort` sur les en-têtes triables, `alt` sur chaque image |
| `contrast` | ratio WCAG de **chaque couleur de texte réellement rendue** contre le fond |
| `motion` | animations déclarées, garde `prefers-reduced-motion` présente |
| `consistency` | un seul tracking de label, un seul gap, un seul radius, deux familles de police max — en sautant proprement ce que l'écran ne contient pas |
| `polls` | **la course** : après avoir martelé 1–5, une seule boucle de poll survit |
| `routes` | un chemin inconnu réécrit l'URL au lieu de mentir |

À lancer avant chaque commit qui touche au CSS ou au layout, et avant le gel.

## Passage sur shadcn/ui — 12/09, décision owner

> « Décision owner : on passe l'UI sur shadcn, même si ça veut dire recoder des composants
> déjà là. Qualité > garder l'ancien JSX. »

Vite reste Vite, les routes restent les routes, le contrat HTTP ne bouge pas. Ce qui change,
c'est **qui possède le comportement** des contrôles : Radix, plus mon JSX.

### Installé

| lib | version | pourquoi |
|---|---|---|
| `tailwindcss` + `@tailwindcss/vite` | 4.3.x | requis par shadcn ; plugin Vite, pas de PostCSS |
| `shadcn` (init `-b radix -p nova`) | CLI | style `radix-nova`, `cssVariables: true`, icônes lucide |
| `radix-ui`, `class-variance-authority`, `tailwind-merge`, `clsx` | — | tirés par les primitives |

Huit primitives copiées dans `app/src/components/ui/` : `table`, `tabs`, `button`, `badge`,
`dropdown-menu`, `separator`, `tooltip`, `scroll-area`. Ce sont **nos fichiers**, pas un
node_module : on les a rethemés en place.

`@fontsource-variable/geist` est arrivé avec l'init — **désinstallé le jour même**. §6.2
interdit la webfont, le wifi de la salle ne la servira pas, et Plex est déjà auto-hébergé.

### Recodé avec

| avant | après | ce qu'on gagne |
|---|---|---|
| `<nav>` + `<button class=desk>` | `Tabs` / `TabsList variant="line"` / `TabsTrigger`, racine dans `App.tsx`, panneau = la vue routée | rôles `tablist`/`tab`/`tabpanel` réels, focus glissant, **flèches gauche/droite entre desks** |
| listbox maison (~90 lignes) | `DropdownMenu` | piège de focus, fermeture Échap/clic-dehors, typeahead — plus à maintenir |
| `<table class=tbl>` à la main | `Table`/`TableHeader`/`TableRow`/`TableHead`/`TableCell` | conteneur de scroll horizontal fourni, sémantique `data-slot` stable pour l'audit |
| `<span class=chip>` | `Badge variant="outline"` sous `.chip` | anneau de focus et dimensionnement d'icône gratuits ; la teinte reste une custom property |
| `<span class=sep>` | `Separator orientation="vertical"` | `role="separator"` au lieu d'un div décoratif muet |

Le `VaultPicker` custom a été jeté, comme autorisé. Il marchait, mais il réimplémentait
mal ce que Radix fait bien.

### Collisions de tokens — le piège

`shadcn init` **écrase** les customs qui portent ses noms. `--accent` et `--muted` étaient
à moi (lecture correcte / lecture naïve, figées par contrat §6) ; l'init les a remplacées
par des `oklch()` gris. Renommées partout en **`--read-correct` / `--read-naive`**, qui ne
peuvent plus entrer en collision avec quoi que ce soit.

Dans l'autre sens, les 59 tokens de shadcn pointent maintenant sur la palette terminal :
`--background: var(--bg)`, `--primary: var(--amber)`, `--radius: 2px`, les cinq `--chart-*`
sur ambre / cyan / vert / jaune / rouge. **`--accent` et `--muted` côté shadcn sont des
surfaces** (`--bg-3`, `--bg-2`), jamais les couleurs de lecture : sinon le survol d'un item
de menu se peint en cyan de NAV.

Le bloc `.dark` généré est **supprimé**. On ne livre qu'un thème, et sa version redéfinissait
`--read-naive`/`--read-correct` en gris — une mine sous le contrat §6 en attendant que
quelque chose pose `class="dark"` sur `<html>`.

### Ce que les utilitaires Tailwind ne peuvent pas casser

Les utilitaires v4 vivent dans une `@layer`. Les règles de `app.css` sont **hors layer**,
donc elles gagnent toujours, à spécificité égale ou moindre. C'est ce qui permet à
`.chip`, `.pill`, `.desks`, `table.tbl` de garder la peau terminal par-dessus les classes
des primitives sans un seul `!important`. Les trois endroits où il a fallu neutraliser
explicitement une utilitaire, parce que `app.css` ne déclarait pas la propriété :
`Badge`→`h-5` (chip : `height:auto`), `TableHead`→`h-10` (`height:auto`),
`TabsTrigger`→`flex-1` (`flex:0 0 auto`).

La racine `Tabs` et son `TabsContent` sont en `display: contents` : ils portent le contexte
Radix et **aucune boîte**, donc le grid de la page et la barre d'état collée en bas ne
bougent pas d'un pixel.

## Anti-slop — 12/09, deuxième passe shadcn

Brief owner : priorité 1 « que ça ne fasse PLUS AI slop », priorité 2 « vivant + smooth ».

### Les cinq tells tués

1. **Le mot de 40px qui flotte.** `FEED LOST` / `NOT ON THE BOOK` s'affichaient en
   `--t-verdict: 40px` au milieu d'un panneau vide. Un desk ne te crie pas un titre : il
   imprime un code d'état de 11px sur un filet, avec un carré de 6px à la teinte, et il
   passe à la suite. `.rail-head` / `.rail-code` / `.rail-dot`.
2. **Le vide sous le contenu.** Le blotter s'arrêtait à 320px sur un écran de 900 et la
   barre d'état flottait au milieu du noir. Un écran de terminal est **plein** : le desk
   prend le mou (`main.page{flex:1}`), le blotter et la grille de rails descendent jusqu'à
   la barre, et le tampon de lecture se colle au filet du bas.
3. **Les aplats sans matière.** Fond mort = rendu, pas machine. Ajouté, CSS pur et inerte :
   grille 24px masquée + vignette **derrière** le desk, scanlines 4% + grain 5% **devant**.
   Le balayage ambre de 1px a pour période `POLL_MS` — ce n'est pas une boucle décorative,
   ce sont les trois secondes qui passent.
4. **Les affordances par défaut.** `title=""` natif, `<a>` en guise de bouton, listbox
   maison. Remplacés par `Tooltip` (ce que veut dire une note, d'où sort le point oracle),
   `Button` (copier la commande, revenir au book, remettre l'ordre du contrat) et
   `DropdownMenu`, tous rethemés en clé de terminal : carré, mono, filet ambre.
5. **Le motion « designer ».** Verdict 420ms, tracé 900ms, distribution 320ms, lifts 260ms
   — joli, et parfaitement faux pour un desk. Tout est ramené dans la bande **140–180ms**,
   le flash d'une cellule qui a vraiment changé en HTTP est à **120ms**, et rien ne voyage
   avec lui : un seul accent animé à la fois.

Bonus : le topbar était calé à gauche, sa queue flottait 120px avant le bord droit.

### Fond vivant — ce qu'il coûte

| couche | où | quoi |
|---|---|---|
| `.ground::before` | z-0, derrière | grille 24px, masque radial qui l'efface au centre |
| `.g-vignette` | z-0, derrière | radial 42% aux bords, il cadre sans assombrir |
| `.g-sweep` | z-0, derrière | ligne ambre 1px, `animation-duration: var(--poll)` |
| `.veil` | z-100, devant | scanlines 4%, période 3px |
| `body::after` | z-100, devant | grain `noise.png` 5% |

Tout est `position: fixed` + `pointer-events: none`. Pas de canvas, pas de particules, pas
d'orbe, pas de glow pleine page, pas de librairie. Les panneaux sont à 92% d'opacité pour
que la grille respire dessous — 92% reste au-dessus du seuil de 85% que le contrôle de
contraste de l'audit utilise pour reconnaître un fond.

### shadcn réellement monté

`Table` (blotter + prêts) · `Tabs` (les quatre desks, la vue routée est le panneau) ·
`DropdownMenu` (sélecteur) · `Badge` (sous `.chip` et sous `.pill`) · `Separator` (topbar,
footer) · `Button` (copier la commande, retour au book, ouvrir le moment, remettre
« worst first ») · `Tooltip` (note sur l'échelle, point oracle) · `ScrollArea` (la table
de prêts, deux axes, capée à 44vh) · `Card` **uniquement en rail technique** — jamais un
hero trois colonnes.

`prefers-reduced-motion` : tout coupé **sauf le hover**, qui reste en couleur seule —
c'est lui qui dit qu'une ligne est cliquable.

### La barre d'état repassait par-dessus les rangées — 12/09

`html, body, #root { height: 100% }` bornait le bloc conteneur du `position: sticky` de la
barre à **900px**. Sur un desk plus haut que l'écran (S1 avec ses prêts, 1802px), la barre
se figeait à y=900 du document et peignait par-dessus le NOTCH TRACE et les ALERTS au lieu
de suivre le défilement.

Elle n'est plus collée : elle vit à la fin du document et descend avec la page.

- `#root { min-height: 100dvh }` — `min-height: 100%` se résout contre un parent en hauteur
  auto, c'est-à-dire contre rien, et le desk s'arrêtait 44px avant le bord.
- `main.page { flex: 1 }` + `.view > .blotter`, `.view > .deskgrid { flex: 1 0 auto }` —
  le desk prend le mou, donc sur un écran qui contient tout la barre tombe **pile** sur le
  bord bas et a l'air collée. `1 0 auto`, jamais `1 1 auto` : c'est le rétrécissement qui
  avait un jour poussé la table de prêts hors de sa boîte.
- `.page` ne réserve plus les 31px de la barre : plus rien ne vit dessous.

Mesuré sur les six desks, en haut ET en bas du défilement : **0 élément croisé par la
barre**, et elle atterrit sur le bord bas dans les deux cas.

## Étape 1 — chrome anti-slop et arrêt du poll storm (12/09)

### C1 — le verdict

Le poster est mort depuis le commit précédent ; il revient **dimensionné**, à 28px, le bas
de la fourchette 28–36 demandée. Il tient sa propre ligne sous `● ON WATCH`, donc « FEED
LOST » passe sur un seul rang dans un rail de 264px. Lisible d'un bout à l'autre de la
salle, et toujours un code d'état sur un filet, pas un titre dans le vide.

### C16 — le preview ne matraque plus un laptop

Deux mécanismes, parce que le problème est double.

**Le cas structurel.** `VITE_API_BASE` non défini retombe sur `http://localhost:8787`.
Depuis une page https, ce n'est même pas une requête qui échoue : le navigateur la bloque
en contenu mixte avant qu'elle ne sorte de l'onglet. `API_UNREACHABLE` détecte exactement
ça — page en https, base en http — et l'app **ne poste alors aucune requête**. Elle dessine
le desk, garde ses cinq slots en tirets cadratins, et affiche le rail `NO API` avec la
raison, la base lue, et `requests made: none`.

**Le cas transitoire.** Le serveur est là mais ne répond pas. Le poll ralentit au lieu de
matraquer : `min(interval × 2^échecs, max(interval, 5s))`. Le `max` compte — un poll déjà
plus lent que le plafond (les vaults à 15s hors LIST) garde sa cadence, un backoff ne doit
jamais accélérer un poll. Mesuré, API coupée : les deux polls se posent à **5003ms**
d'intervalle au lieu de 3000. Premier succès, `fails` retombe à 0, et le poll revient à
**3002ms** dès la beat suivante.

### C17 — le shell avant le premier fetch

Mesuré à 120ms après navigation, API coupée : topbar présent, 4 onglets, **5 lignes
fantômes**, 34 tirets cadratins, **zéro chiffre** dans le tableau. Le premier `fetch` part
d'un `useEffect`, donc après la première peinture, par construction.

`app/.env.example` documente la seule variable que le front lit — et pourquoi elle ne peut
contenir aucun secret.

## Étape 2 — la couche wallet, montée sur shadcn (12/09)

Trois composants ajoutés : `dialog`, `sonner`, `alert`. `button`, `dropdown-menu`, `badge`,
`tooltip`, `separator`, `table`, `tabs` étaient déjà là.

`sonner` de shadcn arrive câblé sur **`next-themes`**. On est sur Vite et on ne livre qu'un
thème : la dépendance est désinstallée et le thème est écrit en clair dans le composant.
Même traitement que `@fontsource-variable/geist` au premier passage.

### Le joint

`lib/wallet.tsx` expose un `useWallet()` avec `state / detected / missing / connect /
connectReadOnly / disconnect`. L'étape 3 remplace le corps de `connect(kind)` par les vrais
adapters `xrpl-connect` ; **rien d'autre ne bouge**. Tant que l'adapter n'est pas branché,
`connect()` le dit — il n'invente pas une adresse pour faire joli.

### Le chemin lecture seule est réel dès maintenant

C'est le fallback A4 du brief, et il ne demande aucune librairie. Une adresse est la seule
chose sur cet écran qu'un humain tape, donc elle est vérifiée **comme le ledger la
vérifie** : base58 sur l'alphabet XRPL, 25 octets, version `0x00`, et le vrai checksum
double-SHA-256 (`lib/xrpl-address.ts`, ~40 lignes, zéro dépendance).

Testé : quatre adresses réelles acceptées (`rHb9CJ…`, `rN7n7o…`, `rsuUjf…`, `rDsbeo…`),
une faute d'un caractère refusée sur le **checksum**, une adresse EVM refusée sur le
préfixe. Une faute de frappe n'est jamais affichée comme un compte.

### B1 → B8, mesurés

| | quoi | preuve |
|---|---|---|
| B1 | `Button` connect / disconnect, `.btn-press` = `scale(0.98)` en 150ms, sur **Connect uniquement** | clic réel → dialog |
| B2 | `Dialog` « choose a wallet », **3 rows**, chacune dit si l'extension est là | `not installed / not installed / no api key` |
| B3 | 5 toasts `sonner` | `Connected read-only \| rHb9CJ…tyTh` · `Crossmark not detected` · `GemWallet not detected` · `Feed back \| reading again from …` · `Disconnected` |
| B4 | **un seul bandeau** | feed coupé + extension manquante → `bannersOnScreen: 1`, c'est le feed. Feed sain → le bandeau extension, seul |
| B5 | `DropdownMenu` connecté | `copy address` · `disconnect` (le copy échoue ici en « document is not focused » : l'automatisation n'a pas le focus, la permission est `granted`) |
| B6 | `Badge` | `READ-ONLY` · `testnet` |
| B7 | `Tooltip` | l'adresse entière : `rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh` |
| B8 | `Separator` dans le dialog | présent |

Restauration de session vérifiée : rechargement → `READ-ONLY \| testnet \| rN7n7o…fzRH`.
Déconnexion → toast, `localStorage` vidé, bouton Connect de retour.

Aucun « connect to unlock » nulle part : rien sur ce desk n'est derrière un wallet, et le
dialog le dit — *« The desk reads the ledger with or without you. »*

## Étape 3 — les vrais adapters XRPL (12/09)

`xrpl-connect@0.8.2` (MIT, XRPL Commons) + `xrpl@5.2.0`.

### Deux choses que le paquet ne dit pas

1. **Il importe `xrpl` sans le déclarer.** Ni `dependencies` ni `peerDependencies` : un
   `npm install xrpl-connect` seul échoue au résolveur. `xrpl` est donc une dépendance
   directe ici, comme le README le fait sans l'expliquer.
2. **Il ne livre aucun `.d.ts`**, malgré le badge « Type Safe ». `src/types/xrpl-connect.d.ts`
   déclare exactement la surface utilisée, **vérifiée contre le vrai module dans le
   navigateur**, pas devinée dans la doc : `WalletManager(connect/disconnect/autoConnect/
   getAvailableWallets/on/off)`, les trois adapters, `WalletErrorCode`.

### L'API réelle, relevée et pas supposée

- `WalletManager extends EventEmitter` → `on` / `off` vivent sur le prototype parent,
  pas sur le sien.
- `connect(walletId, options?)` où `walletId` est l'`id` de l'adapter :
  `crossmark` / `gemwallet` / `xaman`.
- `XamanAdapter.connect({ apiKey, onQRCode, onDeepLink })` — **le QR arrive par
  `onQRCode`**. C'est celui que Xaman a frappé pour cette session ; on n'en compose aucun.
- `WalletErrorCode` : `WALLET_NOT_AVAILABLE` → « not detected », `CONNECTION_REJECTED` /
  `SIGN_REJECTED` → « request rejected ».
- `autoConnect` est appelé **à la main, après** avoir attaché les listeners. Laissé au
  constructeur il peut émettre `connect` avant que quoi que ce soit n'écoute — le README
  le dit lui-même, et une session restaurée que personne n'entend est un wallet qui
  n'apparaît pas.

### Le poids, et où il ne tombe pas

Le toolkit pèse **1 468 kB** (407 kB gzip). Il est en `import()` dynamique :

| | chunk principal | chunk toolkit |
|---|---|---|
| premier paint | **472 kB** | **0 requête** |
| ouverture du dialog | 472 kB | chargé (préchargé au survol du bouton) |
| restauration lecture seule | 472 kB | **0 requête** |
| restauration session toolkit | 472 kB | chargé à t+132ms, **après** les 5 rangées |

Personne n'attend un bundle de wallet pour lire le book. Mesuré dans les quatre cas.

### Vérifié

- Crossmark → chemin librairie réel → `WALLET_NOT_AVAILABLE` → toast + **le** bandeau.
- GemWallet → idem, via l'`isInstalled()` asynchrone de `@gemwallet/api`.
- Xaman sans clé → *« Set VITE_XAMAN_API_KEY … Crossmark and GemWallet are unaffected »*.
  Les deux autres rangées continuent de marcher, comme demandé.
- Lecture seule → `Following read-only | rsuUjf…NK5Z · testnet`, restaurée au rechargement.
- Déconnexion → `manager.disconnect()` pour une session toolkit, storage vidé pour une
  session lecture seule, toast dans les deux cas.

**Non vérifiable ici** : le succès d'une connexion d'extension et le rejet utilisateur.
Aucune extension n'est installée dans ce navigateur. Le câblage est fait contre les codes
d'erreur réels de la librairie et `WALLET_NOT_AVAILABLE` est prouvé de bout en bout ; les
deux autres branches demandent une extension sur la machine de l'owner.

## Étape 4 — vivant + smooth, et rien avant la première peinture (12/09)

L'essentiel du fond vivant était déjà là depuis `2359e45`. Cette étape est le delta.

### Ce qui a changé

| | avant | après |
|---|---|---|
| C5 | grain en `body::after`, présent dès le premier octet de CSS | `.veil-grain`, **monté sur `requestIdleCallback`** avec le reste de l'habillage |
| C7 | flash cyan (`--read-correct`) | **flash vert** (`--ok`) 24%, 120ms |
| C9 | glissement de l'onglet 180ms | **160ms**, la même beat que tout le reste |

### C5 — « overlays après rAF/idle », mesuré

`fetchpriority="low"` ne s'écrit pas sur une tuile CSS : l'attribut vit sur un `<img>` ou un
`<link>`, pas sur un `background-image`. Plutôt que de le simuler, on obtient **ce que
l'attribut demandait**, et c'est mesurable — le `.ground` et le `.veil` ne sont pas rendus
tant que le navigateur n'a pas une frame libre.

```
first-paint                 68 ms
first-contentful-paint     112 ms
noise.png                  145 ms   ← après la peinture, 16,2 Ko, "non-blocking"
```

16,2 Ko contre les 80 autorisés, générée localement, jamais téléchargée.

### C7 — le flash est vert, et il ne ment pas sur le chiffre

`@keyframes flash` peint **le fond de la cellule**, jamais la couleur du chiffre. Une valeur
rouge reste rouge pendant que sa case clignote vert : le marqueur d'événement (« ça vient
d'arriver ») ne peut pas écraser une tonalité de contrat §6 (« ça va mal »).

Capturé en vol sur un vrai changement de ledger :
`flash 0.12s bg=oklab(0.767947 -0.182103 0.12894 / 0.24)` — le `a` négatif, c'est le vert.

### C8 — rien

Le brief autorise « une photo desk sombre **ou RIEN** ». C'est rien. Une photo veut dire une
licence à tracer et un fichier à servir, pour un état qui n'apparaît que si le backend
meurt. La grille 24px se voit déjà dans le vide du rail DOWN et fait le travail.

### Reduced motion

`.ground`, `.veil`, `.veil-grain` sont coupés avec le reste. Le grain et les scanlines sont
statiques, donc discutables ici — mais la sensibilité au bruit visuel voyage souvent avec la
sensibilité au mouvement, et le brief dit « tout off sauf hover ». On coupe. Le hover reste,
en couleur seule : c'est lui qui dit qu'une ligne est cliquable.

### Le carré bleu autour des chips — 12/09

Signalé par l'owner : un cadre cyan de 2px autour de la note finale du notch trace, lu comme
une boîte de sélection parasite. Il était délibéré — il marquait « voilà où la note a
atterri » — mais il portait **exactement** la couleur et l'épaisseur du `:focus-visible`.

Règle posée, et vérifiée par l'audit : **un anneau cyan veut dire « cet élément a le focus
clavier », et rien d'autre.**

- Notch trace : la dernière étape est marquée par le **poids**, pas par un anneau — sa chip
  passe à 22% de remplissage contre 10%, bordure pleine contre 45%, graisse 600 contre 500,
  et sa rangée prend un lavis ambre à 6%. L'ambre est du mobilier : il pointe, il ne signale
  pas. La teinte de la chip reste **sa** teinte de note (contrat §6).
- Bandes de `/moment` : l'anneau de la bande allumée passe de `--read-correct` à
  `--amber-dim`, pour la même raison.

Balayé sur les 12 combinaisons desk × vault : **0 anneau cyan décoratif**. Nouveau contrôle
dans la section `layout` de l'audit — *« focus colour is not used as decoration »* — pour
qu'il ne puisse pas revenir.

## Audit visuel du preview — les 8 patchs (12/09)

### 5 d'abord : la nav était cassée sans feed

Spec §3 renvoyait un `/vault` ou `/moment` sans `?vault=` vers le book. Sans feed il n'y a
pas de rangées, donc pas d'id à choisir, donc **les deux desks étaient inatteignables** :
l'onglet rebondissait et l'app avait l'air morte. Le redirect est supprimé — les desks
tiennent debout tout seuls et disent ce qu'ils attendent.

| onglet | sans API |
|---|---|
| LIST | `the book` · rail `FEED LOST` |
| VAULT | `instrument` · un slot en gros, `—` + « awaiting feed », les six champs en tirets |
| MOMENT | `the moment` · `—` + « no beat until feed », les quatre beats listés |
| ORACLE | `oracle — the three rules` : divergence · declared loss · zero is not safety |

Aucun écran blanc, aucun chiffre inventé. L'URL continue de dire la vérité.

### 1 — le puits noir

La statusline ferme toujours le panneau : `last poll` / `cause` / `contract`, en tirets tant
qu'on n'a rien. Le rail et le book partagent la même hauteur **et le même filet du bas** —
mesuré : `railBottom 807`, `bookBottom 807`.

### 2 — fatigue d'ambre

Nouveau token `--fg-idle: #8A93A0`. Sont passés en gris : onglets inactifs, labels de
colonnes, footer, touches, sous-titre de marque, bordure du topbar, boutons.

**L'ambre ne reste que sur trois choses** : l'onglet actif, les alertes, et le wordmark.
**Le rouge ne reste que sur** : NO FEED et le risque.

### 3 — chrome droit

`border-radius: 0` sur panneaux, chips, boutons, picker, dialog, menus, champs. Une seule
hauteur de contrôle, `--control: 30px` — mesuré : `.desk 30`, `.picker 30`, `connect 30`.
L'onglet actif n'a plus de fond : un filet ambre de 2px, rien d'autre.

### 4 — blotter DOWN

Quatre colonnes au lieu de neuf : `instrument · phase · divergence · oracle`. La case grade
pointillée et le rond vide sont supprimés — ils ressemblaient à des boutons ; ce sont des
tirets cadratins, dans la même mono qu'un vrai chiffre. Une rangée fantôme est cliquable et
mène à `/vault`.

### 6 / 7 / 8

Connect à 30px comme les onglets, dialog shadcn inchangé. Le `runline` n'existe plus : la
commande et le bouton copy vivent dans **la** barre du bas, avec les touches ; sous 800px on
garde `1–5` et on jette le reste. `Roboto` sort de la pile sans-serif (Plex est auto-hébergé
en woff2, la retombée est `system-ui`). Le tracking ne reste que sur les labels — mesuré :
**0 bouton** avec un `letter-spacing`.

## Revue du bundle de prod, API branchée — 12/09

Le preview déployé ne peut pas lire le fixture server d'un laptop (`ERR_BLOCKED_BY_CLIENT`).
Pour regarder **le même artefact** avec des données, le `dist/` est servi en local
(`vite preview`, port 4173) contre l'API réelle — bundle identique à celui de Vercel, seule
l'origine change.

Trois choses clochaient encore. Toutes les trois venaient du patch 1.

### Le vide était déplacé, pas tué

La statusline collée au bas du panneau laissait **516px** de noir entre la dernière rangée
et elle. Le trou était juste passé à l'intérieur du cadre.

Un blotter garde son **réglage** sous les rangées : `.tbl-fill` prolonge la trame à 27px
(26px de cellule + son filet), avec un masque qui l'estompe vers le bas. Aucune rangée
inventée, rien à lire, rien à cliquer — c'est la place qu'il reste au book, pas un trou.

### La statusline répétait le rail

Rail : `READING FROM http://localhost:8787` / `IT SAID Failed to fetch` / `CONTRACT v1.0.0`.
Statusline, 30 cm plus loin : `CAUSE Failed to fetch` / `CONTRACT v1.0.0`. Les mêmes faits
deux fois sur un écran.

La statusline porte maintenant **la cadence** (`last poll`, `failed`) et ne reprend la cause
et le contrat que **s'il n'y a pas de rail** — `railOnScreen` le lui dit.

### La phrase du book était coincée dans l'en-tête

« Sorted worst first. Divergence is the gap… » vivait sur la ligne de titre, à droite, en
deux lignes serrées. Un en-tête est une ligne : la phrase est passée dessous, sur son propre
filet, en pleine largeur.

### Ce qui ne cloche pas, vérifié

Zéro débordement, zéro texte tronqué, zéro `NaN`/`undefined`, et **zéro ambre égaré** hors
des trois usages autorisés sur les quatre desks. Les plus gros caractères de l'app sont
`8571` (96px sur `/moment`, 72px sur `/vault`) et les deux lectures de NAV à 56px — **tous
des chiffres HTTP**, pas un poster.

`uiAudit` **92/92** sur le bundle de production, API branchée.
