/**
 * The developer feedback deliverable: a three-page report, and the register that evidences it.
 *
 * TWO DOCUMENTS, ON PURPOSE. The report is three pages and has to stay three pages: it is
 * read end to end by someone who did not ask for it, and length is the thing that stops
 * that happening. The register is thirty-three pages of evidence, read by lookup. Binding
 * them together made a 36 page document that is neither. They are rendered separately and
 * the report cites the appendix by name.
 *
 * The renderer is deliberately small and knows only what the register actually uses:
 * headings, tables, fenced code, lists, block quotes, rules, and inline emphasis, code and
 * links. No images, no raw HTML; both were checked before this was written.
 *
 * Run: node feedback/build.mjs
 * Out: FEEDBACK.pdf at the repository root, three pages, and feedback/appendix.pdf.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Inline emphasis. Code first, so nothing inside a span of code is re-read as markup. */
function inline(s) {
  const code = []
  let t = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(`<code>${esc(c)}</code>`) - 1}\u0000`)
  t = esc(t)
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, href) => `<a href="${href}">${txt}</a>`)
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>')
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)])
}

const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

function render(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]

    if (l.startsWith('```')) {                                    // fenced code
      const body = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++])
      i++
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }

    const h = l.match(/^(#{1,6}) (.*)$/)
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue }

    if (/^-{3,}$/.test(l.trim())) { out.push('<hr>'); i++; continue }

    // A table: a header row, a delimiter row, then body rows.
    if (l.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      const head = cells(l)
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? ' class="rt"' : ''))
      i += 2
      const body = []
      while (i < lines.length && lines[i].startsWith('|')) body.push(cells(lines[i++]))
      out.push(
        '<table><thead><tr>' + head.map((c, n) => `<th${align[n] ?? ''}>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>' +
        body.map((r) => '<tr>' + r.map((c, n) => `<td${align[n] ?? ''}>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>',
      )
      continue
    }

    if (/^\s*([-*]|\d+\.) /.test(l)) {                            // a list, of either kind
      const ordered = /^\s*\d+\. /.test(l)
      const items = []
      while (i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.) /, ''))
        i++
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>` + items.map((t) => `<li>${inline(t)}</li>`).join('') + `</${tag}>`)
      continue
    }

    if (l.startsWith('>')) {
      const quoted = []
      while (i < lines.length && lines[i].startsWith('>')) quoted.push(lines[i++].replace(/^>\s?/, ''))
      out.push(`<blockquote>${quoted.map((q) => inline(q)).join('<br>')}</blockquote>`)
      continue
    }

    if (l.trim() === '') { i++; continue }

    const para = []                                               // a paragraph runs to a blank line
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6} |```|\||>|\s*([-*]|\d+\.) |-{3,}$)/.test(lines[i])) {
      para.push(lines[i++])
    }
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return out.join('\n')
}

const ROOT = resolve(import.meta.dirname, '..')
const report = readFileSync(resolve(ROOT, 'feedback/feedback.html'), 'utf8')
const register = readFileSync(resolve(ROOT, 'feedback/register.md'), 'utf8')

// The register is set smaller and unjustified: it is a reference table, read by lookup
// rather than end to end, and justification on 190 table rows only makes them harder to scan.
// It inherits the report's page setup, so the two documents print as one pair.
const head = report.slice(0, report.indexOf('</head>'))
const appendixHtml = `${head}
<style>
  body.appx { font-size: 8.6pt; text-align: left; hyphens: none; }
  .appx h1 { font-size: 14pt; margin: 0 0 2mm; }
  .appx h2 { font-size: 10.5pt; margin: 5mm 0 1.5mm; page-break-after: avoid; }
  .appx h3, .appx h4 { font-size: 9.2pt; margin: 3.5mm 0 1mm; page-break-after: avoid; }
  .appx table { width: 100%; border-collapse: collapse; margin: 2mm 0 3mm; font-size: 7.4pt;
                page-break-inside: avoid; }
  .appx th { text-align: left; border-bottom: .6pt solid #1d1b18; padding: .8mm 2mm .8mm 0;
             font-size: 6.6pt; letter-spacing: .05em; text-transform: uppercase; }
  .appx td { border-bottom: .3pt solid #ddd8d0; padding: .8mm 2mm .8mm 0; vertical-align: top;
             overflow-wrap: anywhere; }
  .appx td.rt, .appx th.rt { text-align: right; }
  .appx pre { background: #f6f4f0; padding: 2mm 2.5mm; font-size: 7.2pt; line-height: 1.35;
              overflow-wrap: anywhere; white-space: pre-wrap; page-break-inside: avoid; }
  .appx code { font: 7.6pt ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
  .appx blockquote { margin: 2mm 0 2mm 4mm; color: #4a443c; font-style: italic; }
  .appx hr { border: 0; border-top: .3pt solid #ddd8d0; margin: 4mm 0; }
  .appx a { color: inherit; }
</style>
</head><body class="appx">
${render(register)}
</body></html>`

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p))

/** Print one HTML file to one PDF, and say how many pages came out. */
function printPdf(htmlPath, pdfPath) {
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    `file:///${htmlPath.replaceAll(String.fromCharCode(92), '/')}`,
  ], { stdio: 'pipe' })
  const buf = readFileSync(pdfPath)
  const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
  return { pages, kb: Math.round(buf.length / 1024) }
}

const reportHtml = resolve(ROOT, 'feedback/print-report.html')
const appendixPath = resolve(ROOT, 'feedback/print-appendix.html')
writeFileSync(reportHtml, report)
writeFileSync(appendixPath, appendixHtml)

if (!CHROME) {
  console.log(`  wrote ${reportHtml}`)
  console.log(`  wrote ${appendixPath}`)
  console.log('  No Chrome found. Open each and print it by hand.')
  process.exit(0)
}

const a = printPdf(reportHtml, resolve(ROOT, 'FEEDBACK.pdf'))
const b = printPdf(appendixPath, resolve(ROOT, 'feedback/appendix.pdf'))
console.log('')
console.log(`  FEEDBACK.pdf           ${a.pages} pages, ${a.kb} KB   the report`)
console.log(`  feedback/appendix.pdf  ${b.pages} pages, ${b.kb} KB   the register`)
console.log('')
// The report earns attention by being short. If it stops being short, say so loudly.
if (a.pages > 3) console.error('  THE REPORT IS OVER THREE PAGES. It is meant to be read end to end; fix it before shipping.')
