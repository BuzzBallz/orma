import type { ReactNode } from 'react'

export function Panel({ title, right, className, style, children }:
  { title?: string; right?: ReactNode; className?: string; style?: React.CSSProperties; children: ReactNode }) {
  return (
    <section className={'panel' + (className ? ' ' + className : '')} style={style}>
      {(title || right) && (
        <div className="row" style={{ marginBottom: 8 }}>
          {title && <h2 className="panel-title" style={{ margin: 0 }}>{title}</h2>}
          <span className="spacer" />
          {right}
        </div>
      )}
      {children}
    </section>
  )
}
