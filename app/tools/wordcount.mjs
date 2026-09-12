import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
const BASE = 'http://localhost:8787'
const g = async (p) => { try { const r = await fetch(BASE + p); return r.ok ? await r.json() : null } catch { return null } }
const words = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').split(/\s+/).filter(w => /[a-zA-Z]/.test(w)).length
const list = await g('/api/vaults'); const id = list?.vaults?.[0]?.vaultId
const detail = await g('/api/vaults/' + id)
const history = await g('/api/vaults/' + id + '/broker-history')
const collateral = await g('/api/vaults/' + id + '/collateral')
const gate = await g('/api/vaults/' + id + '/gate')
const race = await g('/api/indexer-race')
const { Facility } = await import('../src/screens/Facility.tsx')
const { Evidence } = await import('../src/screens/Evidence.tsx')
const { Methodology } = await import('../src/screens/Methodology.tsx')
const f = renderToString(createElement(Facility, { d: detail, history, collateral, gate }))
const e = renderToString(createElement(Evidence, { d: race }))
const m = renderToString(createElement(Methodology, {}))
console.log('  Facility     ', words(f), 'mots')
console.log('  Evidence     ', words(e), 'mots')
console.log('  Methodology  ', words(m), 'mots')
