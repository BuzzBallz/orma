# public/assets

Every file here is committed to the repo and served from the same origin. Nothing is
hotlinked: the venue wifi is a risk and a remote asset that fails on stage is a visible
failure.

## noise.png  *(retired)*

- No longer referenced. `paper.png` replaced it as the single surface texture; kept in the
  tree only so a git history that mentions it still resolves.

- 128x128 tileable greyscale noise, generated locally by a throwaway Python script
  (zlib + struct, no dependencies, `random.seed(66)` so the file is reproducible).
  Not downloaded, not traced, no licence to carry. 16 KB.
- Used at 5% opacity as a fixed overlay over the whole desk (`body::after`), together
  with the 4% scanline veil. Both are `pointer-events: none`.

## paper.png

- 280x210 tileable paper fibre, 28 kB, the full-surface overlay at 5.5% opacity
  (`.veil-grain`), `pointer-events: none`. It replaced the generated noise tile: one
  texture on the surface, not two grains stacked.
- Source: the `exclusive-paper` pattern from transparenttextures.com, free for commercial
  use, downloaded once and committed. Nothing is hotlinked.
- **Recoloured deliberately.** The pattern ships black-on-transparent, drawn for light
  backgrounds — over a #0E1015 panel at 5% it is invisible, which was measured before
  choosing. Only the alpha channel carries the fibre, so the RGB is set to the brand cream
  and the alpha kept. Same pattern, legible on a dark ground.
- Halved to 280x210 and the alpha quantised to 32 levels: 145 kB as downloaded, 28 kB as
  committed, with no visible loss in a texture used at 5%.

## mark.svg

- The brand sigil in the topbar. Drawn for this project.
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
| `plex-mono-600.woff2` | IBM Plex Mono 600, latin subset — the wordmark only | 10 kB |
| `plex-serif-400.woff2` | IBM Plex Serif 400, latin subset — the summary only | 15 kB |

- Family: **IBM Plex** — drawn for technical and enterprise interfaces, with real tabular
  figures in the mono. Picked over Inter precisely because Inter is the default that makes
  every product look like every other product.
- Licence: **SIL Open Font License 1.1** — https://github.com/IBM/plex/blob/master/LICENSE.txt
  Redistribution inside a project is exactly what the OFL is for.
- Source of these binaries: the latin subsets Google Fonts serves for IBM Plex
  (fonts.gstatic.com), downloaded once and committed. 70 kB for all four.
- `plex-mono-600.woff2` exists for one word. `.brand` sets the wordmark in Plex Mono 600
  and no other rule asks for that weight; without the face the browser synthesised it,
  and a synthesised bold is drawn differently by each engine. The brand name is the one
  thing that must not change shape between the presenter's machine and a juror's.
- `plex-serif-400.woff2` is used by exactly one rule: the summary paragraphs of a credit
  opinion. A rating note is read as prose for a minute at a time while the rest of this
  surface is a terminal, and a serif is what separates reading from scanning. Georgia is
  the fallback. One weight, latin only — not the family.
- `font-display: swap` with the system stack as the fallback, so the screen paints on the
  first frame either way.
