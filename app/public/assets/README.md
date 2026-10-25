# public/assets

Every file here is committed to the repo and served from the same origin. Nothing is
hotlinked: the venue wifi is a risk and a remote asset that fails on stage is a visible
failure.

## brand/

- The current identity: the Orma and Orma Desk lockups, in ink for light pages and in
  colour for dark ones. `src/components/Lockup.tsx` draws them as images, and draws the
  symbol alone (an eccentric ring, two circles read one inside the other) inline, so it
  takes the page's text colour in both themes.

## mark.svg

- The first sigil, an O over two currents, kept because the og card is composed from it.
  No page draws it any more.
- **Deliberately not the XRPL logo.** Using the real trademark is not a call the
  frontend gets to make, and an imitation of it would be worse. This is two readings of
  one quantity — dashed and low, solid and true — which is the product in three strokes.

## og-card.png

- 1200x630, 25 kB, the card a pasted link unfurls into. Before it existed the link showed
  a blank card in Slack, Discord and WhatsApp, which is the first thing most people see of
  the product.
- Composed locally from parts already in this folder: `mark.svg` rasterised by rsvg-convert
  for the sigil, and IBM Plex Mono SemiBold for the type. It predates the lockups in
  `brand/` and still carries the first sigil.
- The strip along the bottom is the twenty-step internal scale the credit opinion now
  draws, marked at the same notch. Same motif, same meaning, two places.
- Referenced from `index.html` by an **absolute** URL whose origin is stamped at build
  time (`__SITE_ORIGIN__`, replaced by the plugin in `vite.config.ts`): a scraper has no
  page to resolve a relative path against, and every preview deploy supplies its own host.

## fonts/

Self-hosted, committed, served from this origin. **No Google Fonts request at runtime**:
a missing font on stage is a visible failure, and that risk is about the *network*, not
about the file. A font that ships in the bundle cannot
fail on venue wifi.

| file | what | size |
|---|---|---|
| `plex-sans-var.woff2` | IBM Plex Sans, variable 400–600, latin subset | 40 kB |
| `plex-mono-400.woff2` | IBM Plex Mono 400, latin subset | 10 kB |
| `plex-mono-500.woff2` | IBM Plex Mono 500, latin subset | 10 kB |
| `plex-serif-400.woff2` | IBM Plex Serif 400, latin subset — titles, the held figure, the summary | 15 kB |
| `plex-serif-600.woff2` | IBM Plex Serif 600, latin subset — the wordmark, grades, facility names | 16 kB |
| `plex-serif-400-italic.woff2` | IBM Plex Serif 400 italic, latin subset — the one quoted line | 16 kB |

- Family: **IBM Plex** — drawn for technical and enterprise interfaces, with real tabular
  figures in the mono. Picked over Inter precisely because Inter is the default that makes
  every product look like every other product.
- Licence: **SIL Open Font License 1.1** — https://github.com/IBM/plex/blob/master/LICENSE.txt
  Redistribution inside a project is exactly what the OFL is for.
- Source of these binaries: the latin subsets Google Fonts serves for IBM Plex
  (fonts.gstatic.com), downloaded once and committed. About 107 kB for all six.
- Since the redesign the serif carries the reading: titles,
  facility names, grades and the held figure, with Plex Sans for the interface and Plex
  Mono for tabular figures. Three serif files, latin only — not the family. Georgia is the
  fallback. The two added faces come from the same place as the others (fonts.gstatic.com
  latin subsets), downloaded once and committed.
- `font-display: swap` with the system stack as the fallback, so the screen paints on the
  first frame either way.
