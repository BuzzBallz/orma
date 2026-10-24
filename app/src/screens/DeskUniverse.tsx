import type { Universe, UniverseVault } from '../lib/types'
import { Panel } from '../components/Ledger'
import { Dumbbell } from '../components/Charts'
import { errorSentence } from '../lib/api'
import type { SmokeCase } from './Desk'

/**
 * The Universe tab: every vault the service has on file and every vault it has seen live in the
 * transactions stream, each read at one validated ledger. The withdrawal value and the value read by all,
 * per share, are the decimal strings of orma.universe/1, printed verbatim (the written exception of
 * no-letters.md): no Figure, no recompute, and never a number for a vault whose snapshot is inconsistent.
 */

const LOADING = 'The ledger is being read at a validated ledger. The figures appear on their own.'
const EMPTY = 'No vault is on file or has been seen since the service started.'
const BANNER = 'not live on mainnet'

const isUniverse = (d: unknown): d is Universe => typeof d === 'object' && d !== null && (d as { schema?: unknown }).schema === 'orma.universe/1'

/** The scope of the document, said before any row: a known set plus a live window, never the whole ledger. */
function scopeSentence(liveSinceLedger: number | null): string {
  return liveSinceLedger === null
    ? 'Facilities on file, and vaults seen live since the service started. Not a full ledger scan.'
    : `Facilities on file, and vaults seen live since ledger ${liveSinceLedger}. Not a full ledger scan.`
}

function assetText(asset: UniverseVault['asset']): string {
  if ('mpt_issuance_id' in asset) return `MPT ${asset.mpt_issuance_id}`
  if (asset.currency === 'XRP') return 'XRP'
  return `${asset.currency} · issuer ${(asset as { issuer: string }).issuer}`
}

const notPriced = (v: UniverseVault) => (v.reason === 'inconsistent snapshot' ? 'not priced: inconsistent snapshot' : 'not priced')

const wrap = { wordBreak: 'break-all' } as const

function VaultRow({ v, name }: { v: UniverseVault; name: string }) {
  return (
    <tr>
      <td>
        <span className="block">{name}</span>
        <span className="t-fig-s dim block" title={v.vaultId} style={wrap}>{`${assetText(v.asset)} · ${v.brokers.length} ${v.brokers.length === 1 ? 'broker' : 'brokers'} · ${v.vaultId.slice(0, 8)}…`}</span>
        {v.brokers.length > 0 && (
          <details className="fig-ledger">
            <summary>Brokers</summary>
            <div className="pop-body">{v.brokers.map((b) => <code key={b} className="block" style={wrap}>{b}</code>)}</div>
          </details>
        )}
      </td>
      {v.priced
        ? <><td className="num">{v.perUnitHeld}</td><td className="num">{v.perUnitNaive}</td></>
        : <td colSpan={2}>{notPriced(v)}</td>}
      <td>{v.seen === 'live' ? 'Seen live' : 'On file'}</td>
    </tr>
  )
}

/** `data`: the answer of /api/universe through DeskScreen; `error`: the code of its last failed read. */
export function DeskUniverse({ data, error, names = {} }: { data: unknown; error: string | null; names?: Record<string, string> }) {
  // Inside DeskScreen a stale document arrives with its error, which the tab frame already shows above.
  if (!isUniverse(data)) {
    return error
      ? (
          <div role="alert">
            <p className="caption">{errorSentence(error)}</p>
            <details><summary>Error code</summary><code>{error}</code></details>
          </div>
        )
      : <p className="caption">{LOADING}</p>
  }
  const doc = data
  const nameOf = (id: string) => names[id.toUpperCase()] ?? `Vault ${id.slice(0, 6)}`
  const priced = doc.vaults.filter((v) => v.priced && v.perUnitHeld !== undefined && v.perUnitNaive !== undefined)
  return (
    <>
      <p className="t-body-l summary-line">
        <span className="prov" data-prov="REAL">REAL</span>{` ${doc.count} vaults read at ledger ${doc.ledgerIndex}. `}
        <span role="note" className="prov">{BANNER}</span>{` ${scopeSentence(doc.coverage.liveSinceLedger)}`}
      </p>
      {doc.vaults.length === 0
        ? <div className="state"><p className="t-body-s dim">{EMPTY}</p></div>
        : (
            <>
              {priced.length > 0 && (
                <Panel provenance="REAL" title="Two readings of one share, vault by vault" source="Orma">
                  <p className="t-body-s dim">Filled dot: withdrawal value. Open dot: value read by all. The longer the line, the more a lender who trusts the second would overpay.</p>
                  <Dumbbell rows={priced.map((v) => ({ label: nameOf(v.vaultId), held: v.perUnitHeld as string, naive: v.perUnitNaive as string }))} />
                </Panel>
              )}
              <div className="tbl-wrap">
                <table className="op-tbl">
                  <thead>
                    <tr>
                      <th scope="col">Vault</th>
                      <th scope="col" className="num">Withdrawal value per share</th><th scope="col" className="num">Value read by all per share</th><th scope="col">Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.vaults.map((v) => <VaultRow key={v.vaultId} v={v} name={nameOf(v.vaultId)} />)}
                  </tbody>
                </table>
              </div>
            </>
          )}
      <p className="t-body-s dim">{`${doc.coverage.known} on file · ${doc.coverage.live} seen live · ledger hash ${doc.ledgerHash}`}</p>
    </>
  )
}

// --- smoke cases -------------------------------------------------------------------------------------

const FIX_L = 6390000
const hex = (c: string) => c.repeat(64)
const BROKER = hex('B')
const FIX_UNIVERSE: Universe = {
  schema: 'orma.universe/1', ledgerIndex: FIX_L, ledgerHash: 'AB'.repeat(32), count: 6,
  vaults: [
    { vaultId: hex('1'), asset: { currency: 'XRP' }, brokers: [BROKER], priced: true, perUnitHeld: '0.803922', perUnitNaive: '1.000000', seen: 'known' },
    { vaultId: hex('2'), asset: { currency: 'XRP' }, brokers: [], priced: true, perUnitHeld: '0.000000', perUnitNaive: '0.000001', seen: 'live' },
    { vaultId: hex('3'), asset: { currency: 'XRP' }, brokers: [], priced: false, reason: 'not priced', seen: 'known' },
    { vaultId: hex('4'), asset: { currency: 'USD', issuer: 'rIssuerOfTheFixtureUSD' }, brokers: [], priced: false, reason: 'not priced', seen: 'live' },
    { vaultId: hex('5'), asset: { mpt_issuance_id: '55'.repeat(24) }, brokers: [], priced: false, reason: 'not priced', seen: 'known' },
    { vaultId: hex('6'), asset: { currency: 'XRP' }, brokers: [BROKER], priced: false, reason: 'inconsistent snapshot', seen: 'known' },
  ],
  coverage: { known: 4, live: 2, liveSinceLedger: FIX_L - 400 },
  banner: 'not live on mainnet',
}
const SINCE_LEDGER = scopeSentence(FIX_L - 400)
const SINCE_START = scopeSentence(null)
const COLUMNS = ['Withdrawal value per share', 'Value read by all per share']
const CELLS = ['<td class="num">0.803922</td>', '<td class="num">1.000000</td>', '<td class="num">0.000000</td>']

/**
 * One fixed document of six vaults, rendered twice: as served once the stream has delivered a ledger,
 * and the same six vaults while `liveSinceLedger` is still null. Each scope sentence is thus proven on
 * the document that carries it, and each case refuses the other sentence.
 */
export const SMOKE_CASES: SmokeCase[] = [
  {
    name: 'universe of six vaults, live since a ledger', element: <DeskUniverse data={FIX_UNIVERSE} error={null} />,
    mustContain: [
      '6 vaults read at ledger', `6 vaults read at ledger ${FIX_L}.`, BANNER, SINCE_LEDGER, ...COLUMNS, ...CELLS,
      'not priced: inconsistent snapshot', 'not priced</td>', 'REAL',
    ],
    before: ['6 vaults read at ledger', BANNER, SINCE_LEDGER, ...COLUMNS],
    mustNotContain: [SINCE_START, EMPTY, LOADING],
  },
  {
    name: 'universe of six vaults, before any live ledger', element: <DeskUniverse data={{ ...FIX_UNIVERSE, coverage: { ...FIX_UNIVERSE.coverage, liveSinceLedger: null } }} error={null} />,
    mustContain: ['6 vaults read at ledger', BANNER, SINCE_START, ...COLUMNS, ...CELLS],
    mustNotContain: [SINCE_LEDGER, EMPTY],
  },
  {
    name: 'universe with no vault', element: <DeskUniverse data={{ ...FIX_UNIVERSE, count: 0, vaults: [], coverage: { known: 0, live: 0, liveSinceLedger: null } }} error={null} />,
    mustContain: [EMPTY, `0 vaults read at ledger ${FIX_L}.`, BANNER, SINCE_START],
    mustNotContain: ['<table', LOADING],
  },
  {
    name: 'universe whose read fails', element: <DeskUniverse data={null} error="WARMING_UP" />,
    mustContain: [errorSentence('WARMING_UP'), '<details><summary>Error code</summary><code>WARMING_UP</code></details>', 'role="alert"'],
    mustNotContain: [LOADING, BANNER],
  },
  { name: 'universe loading', element: <DeskUniverse data={null} error={null} />, mustContain: [LOADING], mustNotContain: ['role="alert"'] },
]
