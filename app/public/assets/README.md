# public/assets

Every file here is committed to the repo and served from the same origin. Nothing is
hotlinked: the venue wifi is a risk and a remote asset that fails on stage is a visible
failure.

## mark.svg

- The brand sigil. Drawn for this project. The masthead and the footer draw the same
  paths inline (`src/components/Lockup.tsx`), so the O and the upper current take the
  page's text colour in both themes; this file stays the reference and the source of the
  og card.
- **Deliberately not the XRPL logo.** Using the real trademark is not a call the
  frontend gets to make, and an imitation of it would be worse. This is two readings of
  one quantity — dashed and low, solid and true — which is the product in three strokes.

## og-card.png

- 1200x630, 25 kB, the card a pasted link unfurls into. Before it existed the link showed
  a blank card in Slack, Discord and WhatsApp, which is the first thing most people see of
  the product.
- Composed locally from parts already in this folder: `mark.svg` rasterised by rsvg-convert
  for the sigil, and IBM Plex Mono SemiBold for the type, so it carries the same mark and
  the same letterforms as the topbar rather than an approximation of them.
- The strip along the bottom is the twenty-step internal scale the credit opinion now
  draws, marked at the same notch. Same motif, same meaning, two places.
- Referenced from `index.html` by a **relative** path. Every preview deploy has its own
  hostname, so an absolute og:image would be right on exactly one of them.

## fonts/

Self-hosted, committed, served from this origin. **No Google Fonts request at runtime** —
spec §6.2 bans webfonts because "a missing font on stage is a visible failure", and that
risk is about the *network*, not about the file. A font that ships in the bundle cannot
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
- Since the redesign (direction D2, "Registre") the serif carries the reading: titles,
  facility names, grades and the held figure, with Plex Sans for the interface and Plex
  Mono for tabular figures. Three serif files, latin only — not the family. Georgia is the
  fallback. The two added faces come from the same place as the others (fonts.gstatic.com
  latin subsets), downloaded once and committed.
- `font-display: swap` with the system stack as the fallback, so the screen paints on the
  first frame either way.
