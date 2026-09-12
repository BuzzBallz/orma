# public/assets

Every file here is committed to the repo and served from the same origin. Nothing is
hotlinked: the venue wifi is a risk and a remote asset that fails on stage is a visible
failure.

## grain.png

- 128x128 tileable grain, generated locally by a throwaway Node script — not downloaded.
  8-bit grayscale + alpha, so the noise lives in the alpha channel and tints nothing.
  Used as a 5% overlay on the page, `pointer-events: none`.
- No licence question: this repo made it.

## mark.svg

- The brand sigil in the topbar. Drawn for this project.
- **Deliberately not the XRPL logo.** Using the real trademark is not a call the
  frontend gets to make, and an imitation of it would be worse. This is two readings of
  one quantity — dashed and low, solid and true — which is the product in three strokes.

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

- Family: **IBM Plex** — drawn for technical and enterprise interfaces, with real tabular
  figures in the mono. Picked over Inter precisely because Inter is the default that makes
  every product look like every other product.
- Licence: **SIL Open Font License 1.1** — https://github.com/IBM/plex/blob/master/LICENSE.txt
  Redistribution inside a project is exactly what the OFL is for.
- Source of these binaries: the latin subsets Google Fonts serves for IBM Plex
  (fonts.gstatic.com), downloaded once and committed. 60 kB for all three.
- `font-display: swap` with the system stack as the fallback, so the screen paints on the
  first frame either way.
