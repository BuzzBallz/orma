import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

/**
 * One exhibit of a credit opinion, folded. The title and a one-line reading stay in view;
 * the tables are one tap away. A native <details>, so it opens from the keyboard, prints,
 * and is found by the browser's own search without any script.
 */
export function Exhibit({ title, meta, open, children }: {
  title: string; meta?: ReactNode; open?: boolean; children: ReactNode
}) {
  return (
    <details className="exh" open={open}>
      <summary>
        <span className="exh-title">{title}</span>
        <span className="exh-meta">
          {meta && <span className="exh-meta-text">{meta}</span>}
          <ChevronDown className="exh-chev" size={18} strokeWidth={1.75} aria-hidden />
        </span>
      </summary>
      <div className="exh-body">{children}</div>
    </details>
  )
}
