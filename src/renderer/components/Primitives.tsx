import type { ReactNode } from 'react'

export function Panel({ title, eyebrow, action, children, className = '' }: { title?: string; eyebrow?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {(eyebrow || title || action) && (
        <header className="panel__header">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            {title && <h2 className="panel__title">{title}</h2>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function StatusPill({ tone = 'neutral', children }: { tone?: 'positive' | 'warning' | 'danger' | 'neutral' | 'accent'; children: ReactNode }) {
  return <span className={`status-pill status-pill--${tone}`}><span className="status-pill__dot" aria-hidden="true" />{children}</span>
}

export function Metric({ label, value, detail, tone = 'neutral' }: { label: string; value: string; detail?: string; tone?: 'positive' | 'warning' | 'danger' | 'neutral' | 'accent' }) {
  return (
    <div className={`metric metric--${tone}`}>
      <p className="metric__label">{label}</p>
      <p className="metric__value">{value}</p>
      {detail && <p className="metric__detail">{detail}</p>}
    </div>
  )
}

export function ActionButton({ children, variant = 'secondary', disabled = false, loading = false, onClick, type = 'button' }: { children: ReactNode; variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; disabled?: boolean; loading?: boolean; onClick?: () => void; type?: 'button' | 'submit' }) {
  return <button className={`button button--${variant}`} disabled={disabled || loading} onClick={onClick} type={type} aria-busy={loading || undefined}>{loading && <span className="button__spinner" aria-hidden="true" />}{children}</button>
}

export function Unavailable({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="unavailable" role="status">
      <div className="unavailable__mark" aria-hidden="true"><span /></div>
      <div><strong>{title}</strong><p>{detail}</p></div>
    </div>
  )
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><span className="empty-state__line" aria-hidden="true" /><strong>{title}</strong><p>{detail}</p></div>
}
