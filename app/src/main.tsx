import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

/**
 * A render that throws (a malformed figure handed to decimal.js, say) would otherwise unmount the whole
 * root and leave a white page. This says so in a sentence and offers the way back; back or forward,
 * which change the screen, try again.
 */
class RenderFailure extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error('render failed', error, info.componentStack) }
  componentDidMount() { addEventListener('popstate', this.retry) }
  componentWillUnmount() { removeEventListener('popstate', this.retry) }
  retry = () => { if (this.state.failed) this.setState({ failed: false }) }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main id="main" className="page">
        <div className="state" role="alert">
          <h2 className="t-heading-s">This screen could not be drawn</h2>
          <p className="t-body-s dim">A figure it received could not be read. Nothing was sent.</p>
          <a className="lnk" href={location.pathname + location.search}>Reload</a>
        </div>
      </main>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RenderFailure>
      <App />
    </RenderFailure>
  </StrictMode>,
)
