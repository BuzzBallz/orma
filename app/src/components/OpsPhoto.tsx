/**
 * The room this screen stands in for. One committed photograph — see
 * public/assets/README.md for source and licence — darkened into the palette so it
 * reads as ground, not decoration. Never hotlinked: venue wifi is a risk.
 */
export function OpsPhoto({ caption }: { caption: string }) {
  return (
    <figure className="ops" style={{ margin: 0 }}>
      <img
        src="/assets/operator-desk.jpg"
        alt="A control room: a wall of monitors above a row of operator consoles."
        width={900}
        height={675}
        loading="lazy"
        decoding="async"
      />
      <figcaption>
        <b>Operator view</b> — {caption}
      </figcaption>
    </figure>
  )
}
