import type { ReactNode } from 'react'
import type { DesktopStatus } from '../global'
import { StatusPill } from './Primitives'

export type RouteName = 'loading' | 'overview' | 'mode' | 'update' | 'recovery' | 'diagnostics' | 'error'

type IconName = 'overview' | 'mode' | 'update' | 'recovery' | 'diagnostics' | 'error'

const navItems: Array<{ route: RouteName; label: string; icon: IconName }> = [
  { route: 'overview', label: '概览', icon: 'overview' },
  { route: 'update', label: '更新', icon: 'update' },
  { route: 'recovery', label: '恢复', icon: 'recovery' },
  { route: 'diagnostics', label: '日志与诊断', icon: 'diagnostics' },
  { route: 'mode', label: '稳定 / 开发', icon: 'mode' },
]

const routeLabels: Record<RouteName, string> = {
  loading: '启动状态',
  overview: '概览',
  mode: '运行模式',
  update: '版本更新',
  recovery: '恢复中心',
  diagnostics: '日志与诊断',
  error: '启动错误',
}

function navigate(route: RouteName) {
  window.location.hash = `#/${route}`
}

function modeLabel(mode: DesktopStatus['mode']) {
  if (mode.active === 'legacy') return '兼容模式'
  return mode.active === 'stable' ? '稳定模式' : '开发模式'
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    overview: <><path d="M4 12 12 5l8 7" /><path d="M6.5 10.5V20h11v-9.5M9.5 20v-5h5v5" /></>,
    mode: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></>,
    update: <><path d="M20 11a8 8 0 1 0 1 4" /><path d="m20 4 1 7-7-1" /></>,
    recovery: <><path d="M4 12a8 8 0 1 0 3-6" /><path d="M4 4v6h6" /></>,
    diagnostics: <><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
    error: <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></>,
  }
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

export type AppFeedback = { message: string; tone: 'info' | 'error' }

export default function AppShell({ route, status, feedback, children }: { route: RouteName; status: DesktopStatus; feedback?: AppFeedback | null; children: ReactNode }) {
  const ready = status.workspace.ready
  const failed = status.startup.phase === 'error' || Boolean(status.startup.error)
  const stateTone = failed ? 'danger' : ready ? 'positive' : 'accent'
  const stateLabel = failed ? '需要处理' : ready ? '工作区已就绪' : '正在连接'
  return (
    <div className="app-frame native-shell">
      <header className="topbar native-sidebar">
        <div className="topbar__brand-row">
          <div className="topbar__brand">
            <button className="wordmark" onClick={() => navigate('overview')} type="button" aria-label="打开概览">
              <picture className="native-wordmark">
                <source media="(prefers-color-scheme: light)" srcSet={new URL('../../../assets/dsh-wordmark-dark.svg', import.meta.url).href} />
                <img src={new URL('../../../assets/dsh-wordmark.svg', import.meta.url).href} alt="DeepSeek Harness" width="182" height="24" />
              </picture>
            </button>
          </div>
        </div>
        <nav className="topnav" aria-label="管理导航">
          <div className="topnav__inner">
            {navItems.map(item => (
              <button
                className={`nav-item ${route === item.route ? 'nav-item--active' : ''}`}
                key={item.route}
                onClick={() => navigate(item.route)}
                type="button"
                aria-current={route === item.route ? 'page' : undefined}
              >
                <span className="nav-item__icon"><Icon name={item.icon} /></span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="native-sidebar__footer">
          <StatusPill tone={stateTone}>{stateLabel}</StatusPill>
          <p>桌面端 {status.app.version || '版本未上报'}</p>
        </div>
      </header>
      <main className="main-content">
        <div className="route-content">
          <p className="sr-only" aria-live="polite">当前视图：{routeLabels[route]} · {modeLabel(status.mode)}</p>
          {feedback && <div className={`feedback feedback--global feedback--${feedback.tone}`} role={feedback.tone === 'error' ? 'alert' : 'status'} aria-live="polite" aria-atomic="true">{feedback.message}</div>}
          {children}
        </div>
      </main>
    </div>
  )
}
