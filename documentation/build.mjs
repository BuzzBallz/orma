/**
 * Render the Mintlify MDX pages into a static site for GitHub Pages.
 *
 * WHY BOTH. The pages are authored as Mintlify MDX because that is the deliverable and
 * because pushing them to Mintlify later should need no rewriting. But publishing to
 * Mintlify requires an account we do not have credentials for tonight, and a docs link
 * that does not resolve is worse than no docs link. GitHub Pages we can reach with the
 * CLI that is already authenticated, so the same source produces a live URL now.
 *
 * The renderer is deliberately small. It handles exactly the subset the pages were told
 * to use: frontmatter, headings, tables, fenced code, lists, blockquotes, inline
 * formatting, and the three callout components. Anything else is passed through as text
 * rather than silently mangled.
 *
 * Run: node documentation/build.mjs
 * Out: documentation/site/
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PAGES_DIR = 'documentation/pages'
const OUT_DIR = 'documentation/site'

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Inline: code first, so formatting inside a code span is left alone. */
function inline(s) {
  const spans = []
  // A control character as the placeholder, never a space: a space-delimited marker
  // collides with ordinary prose, and " 3 " in a sentence then restores as undefined.
  let t = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${spans.push(`<code>${c}</code>`) - 1}\u0000`)
  t = t
    // A cross-page link is authored as /slug or /slug#anchor. The fragment has to be
    // split off before .html is appended, or the anchor lands inside the filename.
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      let h = href
      if (h.startsWith('/')) {
        const k = h.indexOf('#')
        h = k === -1 ? `${h.slice(1)}.html` : `${h.slice(1, k)}.html${h.slice(k)}`
      }
      return `<a href="${h}">${label}</a>`
    })
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)])
}

function frontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { meta: {}, body: src }
  const meta = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: src.slice(m[0].length) }
}

function render(body) {
  const out = []
  const lines = body.split('\n')
  let i = 0
  const flushTable = (rows) => {
    // A markdown table needs at least a header and its separator to be a table at all.
    if (rows.length < 2) { rows.forEach((r) => out.push(`<p>${inline(r)}</p>`)); return }
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    const head = cells(rows[0])
    const body2 = rows.slice(2).map(cells)
    out.push('<div class="tw"><table><thead><tr>' +
      head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
      body2.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
      '</tbody></table></div>')
  }

  while (i < lines.length) {
    const l = lines[i]

    if (/^```/.test(l)) {
      const lang = l.slice(3).trim()
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++
      out.push(`<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(buf.join('\n'))}</code></pre>`)
      continue
    }

    // The three callouts the pages were restricted to. Anything else stays text.
    const callout = l.match(/^<(Note|Warning|Tip)>\s*(.*)$/)
    if (callout) {
      const kind = callout[1].toLowerCase()
      const buf = callout[2] ? [callout[2]] : []
      i++
      while (i < lines.length && !new RegExp(`</${callout[1]}>`).test(lines[i])) buf.push(lines[i++])
      const last = lines[i] ? lines[i].replace(new RegExp(`</${callout[1]}>`), '').trim() : ''
      if (last) buf.push(last)
      i++
      out.push(`<div class="callout ${kind}"><span class="ck">${callout[1]}</span><div>${
        buf.filter(Boolean).map((p) => `<p>${inline(p)}</p>`).join('')}</div></div>`)
      continue
    }

    const h = l.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const n = h[1].length
      const id = h[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      out.push(`<h${n} id="${id}">${inline(h[2])}</h${n}>`)
      i++
      continue
    }

    if (/^\s*\|/.test(l)) {
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++].trim())
      flushTable(rows)
      continue
    }

    if (/^\s*[-*]\s+/.test(l)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''))
      out.push('<ul>' + items.map((x) => `<li>${inline(x)}</li>`).join('') + '</ul>')
      continue
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''))
      out.push('<ol>' + items.map((x) => `<li>${inline(x)}</li>`).join('') + '</ol>')
      continue
    }

    if (/^>\s?/.test(l)) {
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''))
      out.push(`<blockquote>${buf.filter(Boolean).map((p) => `<p>${inline(p)}</p>`).join('')}</blockquote>`)
      continue
    }

    if (/^---+\s*$/.test(l)) { out.push('<hr>'); i++; continue }
    if (!l.trim()) { i++; continue }

    const buf = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*[-*]\s|\s*\d+\.\s|>|```|---+\s*$|<(Note|Warning|Tip)>)/.test(lines[i])) {
      buf.push(lines[i++])
    }
    if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`)
    else i++
  }
  return out.join('\n')
}

// --- read the navigation order from docs.json when the writer produced one -----------
let order = null
const cfgPath = 'documentation/docs.json'
if (existsSync(cfgPath)) {
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    const found = []
    const walk = (n) => {
      if (typeof n === 'string') found.push(n.replace(/^\/?(pages\/)?/, ''))
      else if (Array.isArray(n)) n.forEach(walk)
      else if (n && typeof n === 'object') Object.values(n).forEach(walk)
    }
    walk(cfg.navigation ?? cfg)
    if (found.length) order = found
  } catch { /* a malformed config must not stop the build */ }
}

const files = readdirSync(PAGES_DIR).filter((f) => f.endsWith('.mdx'))
const slug = (f) => f.replace(/\.mdx$/, '')
const sorted = order
  ? [...files].sort((a, b) => {
      const ia = order.indexOf(slug(a)); const ib = order.indexOf(slug(b))
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    })
  : files

const pages = sorted.map((f) => {
  // A Windows checkout with core.autocrlf hands every page over with CRLF endings. The
  // parser splits on \n and anchors on '---\n', so without this the frontmatter renders as
  // a paragraph and no heading is recognised. Normalise once, here, before anything parses.
  const src = readFileSync(join(PAGES_DIR, f), 'utf8').replace(/\r\n?/g, '\n')
  const { meta, body } = frontmatter(src)
  return { slug: slug(f), title: meta.title || slug(f), description: meta.description || '', html: render(body) }
})

const CSS = `
:root{--bg:#0A0B0E;--panel:#0E1015;--raised:#15171D;--fg:#EAE0CE;--dim:#B3AA99;--mute:#8C8578;
--gold:#C9A45F;--line:#1F222A;--line2:#2C313B;--ok:#35D64A;--bad:#FF4A4A;
--mono:"Plex Mono",ui-monospace,"SF Mono",Consolas,Menlo,monospace;
--sans:"Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);line-height:1.62;font-size:16px}
.wrap{display:grid;grid-template-columns:250px minmax(0,1fr);max-width:1180px;margin:0 auto;gap:48px;padding:0 24px}
nav{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;padding:32px 0;border-right:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:9px;font:600 15px/1 var(--mono);letter-spacing:.09em;
text-transform:uppercase;color:var(--fg);margin-bottom:28px;text-decoration:none}
.brand svg{width:22px;height:22px;flex:0 0 auto}
nav a{display:block;padding:7px 12px 7px 0;color:var(--dim);text-decoration:none;font-size:14.5px;border-left:2px solid transparent;padding-left:12px}
nav a:hover{color:var(--fg)}
nav a.on{color:var(--gold);border-left-color:var(--gold)}
main{padding:48px 0 120px;min-width:0}
h1{font-size:34px;line-height:1.18;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:23px;margin:44px 0 12px;padding-top:20px;border-top:1px solid var(--line);letter-spacing:-.01em}
h3{font-size:17.5px;margin:30px 0 8px;color:var(--fg)}
h4{font-size:15px;margin:22px 0 6px;color:var(--dim);font-family:var(--mono);letter-spacing:.03em}
.lede{color:var(--mute);font-size:17px;margin:0 0 32px}
p{margin:0 0 15px}
a{color:var(--gold)}
code{font-family:var(--mono);font-size:.88em;background:var(--raised);padding:1.5px 5px;border-radius:3px;color:var(--gold)}
pre.code{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:15px 17px;overflow-x:auto;margin:0 0 17px;position:relative}
pre.code code{background:none;padding:0;color:var(--fg);font-size:13.2px;line-height:1.62}
pre.code[data-lang]::after{content:attr(data-lang);position:absolute;top:7px;right:11px;
font:500 10px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--mute)}
.tw{overflow-x:auto;margin:0 0 18px}
table{border-collapse:collapse;width:100%;font-size:14.2px}
th{text-align:left;font:500 11px var(--mono);letter-spacing:.09em;text-transform:uppercase;
color:var(--mute);padding:8px 12px 8px 0;border-bottom:1px solid var(--line2)}
td{padding:9px 12px 9px 0;border-bottom:1px solid var(--line);vertical-align:top;color:var(--dim)}
td:first-child{color:var(--fg)}
ul,ol{margin:0 0 16px;padding-left:21px}li{margin:0 0 6px;color:var(--dim)}
blockquote{margin:0 0 18px;padding:2px 0 2px 17px;border-left:2px solid var(--gold);color:var(--dim)}
blockquote p:last-child{margin:0}
hr{border:0;border-top:1px solid var(--line);margin:34px 0}
.callout{display:flex;gap:13px;border:1px solid var(--line2);border-radius:6px;padding:13px 16px;margin:0 0 18px;background:var(--panel)}
.callout .ck{font:500 10px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--mute);flex:0 0 62px;padding-top:3px}
.callout p:last-child{margin:0}
.callout.warning{border-color:var(--bad)}.callout.warning .ck{color:var(--bad)}
.callout.tip{border-color:var(--ok)}.callout.tip .ck{color:var(--ok)}
.callout.note .ck{color:var(--gold)}
.foot{margin-top:64px;padding-top:22px;border-top:1px solid var(--line);color:var(--mute);font-size:13.5px}
@media(max-width:820px){.wrap{grid-template-columns:1fr;gap:0}
nav{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}main{padding:28px 0 80px}}
`

const MARK = `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M32 6c10.5 0 18 8.9 18 21.5S42.5 49 32 49 14 40.1 14 27.5 21.5 6 32 6Zm0 4.6c-5.6 0-8.9 6.6-8.9 16.9s3.3 16.9 8.9 16.9 8.9-6.6 8.9-16.9S37.6 10.6 32 10.6Z" fill="#EAE0CE"/><path d="M7 54.2c5.6-3.6 9.9-3.6 14.5-.9 5.2 3 8.4 3.1 12.9.4 5.5-3.3 9.7-3.4 14.8-.6 3.2 1.8 6 1.9 8.8.4" stroke="#EAE0CE" stroke-width="2.1" stroke-linecap="round"/><path d="M11 59.6c5.3-2.6 9.4-2.6 13.7-.4 4.9 2.5 8 2.5 12.2.1 5.2-2.9 9.2-3 14-.6" stroke="#C9A45F" stroke-width="2.1" stroke-linecap="round"/></svg>`

mkdirSync(OUT_DIR, { recursive: true })
// GitHub Pages runs Jekyll by default, which silently drops files and folders starting
// with an underscore. Nothing here does, but the marker costs one byte and removes a
// whole class of "the page is blank and nothing in the log says why".
writeFileSync(join(OUT_DIR, '.nojekyll'), '')

for (const p of pages) {
  const nav = pages.map((q) =>
    `<a href="${q.slug}.html"${q.slug === p.slug ? ' class="on"' : ''}>${esc(q.title)}</a>`).join('\n      ')
  writeFileSync(join(OUT_DIR, `${p.slug}.html`), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)} — Orma</title>
<meta name="description" content="${esc(p.description)}">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <nav>
    <a class="brand" href="${pages[0].slug}.html">${MARK} Orma</a>
      ${nav}
  </nav>
  <main>
    <h1>${esc(p.title)}</h1>
    ${p.description ? `<p class="lede">${esc(p.description)}</p>` : ''}
    ${p.html}
    <div class="foot">
      Orma — built at the XRPL Lending Protocol Hackathon, Paris, 12-13 September 2026,
      by Alexandre Lemiere and Andrea Gonzalez. Devnet only.
    </div>
  </main>
</div>
</body>
</html>
`)
}

writeFileSync(join(OUT_DIR, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Orma</title>` +
  `<meta http-equiv="refresh" content="0;url=${pages[0].slug}.html">` +
  `<link rel="canonical" href="${pages[0].slug}.html">` +
  `<p style="font-family:system-ui;background:#0A0B0E;color:#EAE0CE;padding:2rem">` +
  `<a style="color:#C9A45F" href="${pages[0].slug}.html">Orma documentation</a></p>`)

console.log(`  ${pages.length} pages -> ${OUT_DIR}/`)
for (const p of pages) console.log(`    ${p.slug.padEnd(16)} ${String(p.html.length).padStart(6)} bytes  ${p.title}`)
if (!order) console.log('  (no docs.json navigation found; pages are in directory order)')
