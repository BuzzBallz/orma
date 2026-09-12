/**
 * Turn deck/content.md into a presentable, printable deck.
 *
 * WHY THIS AND NOT A SLIDE TOOL. Neither marp nor pandoc is installed on the presenting
 * machine, and installing a toolchain on the morning of a pitch is how a pitch goes wrong.
 * This has no dependencies, opens in the browser already on the laptop, and prints to PDF
 * through the browser's own dialog.
 *
 * The content file is the single source of truth and it mirrors docs/45-RUNSHEET.md, so
 * the deck and the script the presenter rehearsed against cannot drift apart.
 *
 * Controls:  arrows / space / click   next and previous
 *            S                        speaker notes
 *            T                        start and stop the timer
 *            P                        print layout, then the browser's print dialog
 *            number keys              jump to a slide
 *
 * Run: node deck/build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'deck/content.md'
const OUT = 'deck/index.html'

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Inline markdown, deliberately minimal: bold, code, and nothing else. */
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')

/**
 * Parse the content file into slides.
 *
 * Tolerant on purpose. The file is written by hand under time pressure, so a missing
 * timing comment or an absent notes block must degrade to a usable slide rather than
 * throw on the morning of the pitch.
 */
function parse(md) {
  const slides = []
  for (const block of md.split(/^## /m).slice(1)) {
    const nl = block.indexOf('\n')
    const heading = block.slice(0, nl === -1 ? undefined : nl).trim()
    const body = nl === -1 ? '' : block.slice(nl + 1)

    const [, id, title] = heading.match(/^(S\d+)\s*[—:-]\s*(.+)$/) || [null, '', heading]
    const meta = body.match(/<!--\s*time:\s*([^|]+)\|\s*duration:\s*([^>]+?)\s*-->/)

    const onScreenRaw = (body.match(/###\s*on screen\s*\n([\s\S]*?)(?=\n###|\n---|$)/i) || [])[1] || ''
    const notesRaw = (body.match(/###\s*notes\s*\n([\s\S]*?)(?=\n###|\n---|$)/i) || [])[1] || ''

    const lines = onScreenRaw.split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('<!--'))
      .map((l) => l.replace(/^[-*]\s+/, ''))

    slides.push({
      id: id || `S${slides.length + 1}`,
      title,
      time: meta ? meta[1].trim() : '',
      duration: meta ? meta[2].trim() : '',
      lines,
      notes: notesRaw.trim().split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean),
    })
  }
  return slides
}

const slides = parse(readFileSync(SRC, 'utf8'))
if (!slides.length) {
  console.error(`  ${SRC} produced no slides. Check the heading format: "## S1 — Title".`)
  process.exit(1)
}

const slideHtml = slides.map((s, i) => `
  <section class="slide" data-i="${i}">
    <header class="shead">
      <span class="sid">${esc(s.id)}</span>
      <span class="stitle">${inline(s.title)}</span>
      <span class="stime">${esc(s.time)}${s.duration ? ` &middot; ${esc(s.duration)}` : ''}</span>
    </header>
    <div class="sbody">
      ${s.lines.map((l) => `<p class="line">${inline(l)}</p>`).join('\n      ')}
    </div>
    <footer class="sfoot"><span>Orma</span><span>${i + 1} / ${slides.length}</span></footer>
    <aside class="notes">${s.notes.map((n) => `<p>${inline(n)}</p>`).join('')}</aside>
  </section>`).join('\n')

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Orma</title>
<style>
  :root{
    --bg:#0A0B0E; --panel:#0E1015; --fg:#EAE0CE; --gold:#C9A45F;
    --dim:#B3AA99; --mute:#8C8578; --line:#1F222A;
    --mono:"Plex Mono",ui-monospace,"SF Mono",Consolas,Menlo,monospace;
    --sans:"Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:var(--sans);overflow:hidden}
  .slide{
    position:fixed;inset:0;display:none;flex-direction:column;
    padding:5vh 7vw;background:var(--bg);
  }
  .slide.on{display:flex}
  .shead{display:flex;align-items:baseline;gap:1.2rem;
    font:500 1.1vw/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--mute);
    border-bottom:1px solid var(--line);padding-bottom:1.6vh}
  .sid{color:var(--gold)}
  .stitle{color:var(--dim);text-transform:none;letter-spacing:.02em;font-size:1.25vw}
  .stime{margin-left:auto}
  .sbody{flex:1;display:flex;flex-direction:column;justify-content:center;gap:2.4vh}
  /* One idea per slide, so the type is large and there is deliberately little of it. */
  .line{margin:0;font-size:3.4vw;line-height:1.22;letter-spacing:-.015em;font-weight:500}
  .line code{font-family:var(--mono);font-size:.86em;color:var(--gold)}
  .line b{color:var(--gold);font-weight:600}
  .sfoot{display:flex;justify-content:space-between;
    font:500 1vw/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--mute);
    border-top:1px solid var(--line);padding-top:1.6vh}
  .notes{display:none}
  body.notes .notes{
    display:block;position:fixed;left:0;right:0;bottom:0;max-height:38vh;overflow:auto;
    background:var(--panel);border-top:1px solid var(--gold);
    padding:2vh 7vw;font-size:1.15vw;line-height:1.6;color:var(--dim)}
  body.notes .slide.on .notes{display:block}
  .notes p{margin:0 0 .8em}
  #clock{position:fixed;top:1.2vh;right:1.2vw;z-index:10;
    font:600 1.1vw/1 var(--mono);letter-spacing:.06em;color:var(--mute)}
  #clock.run{color:var(--gold)}
  #clock.over{color:#FF4A4A}
  /* Printing is how this becomes a PDF, so every slide must exist on its own page. */
  @media print{
    @page{size:1600px 900px;margin:0}
    html,body{overflow:visible;height:auto}
    .slide{position:relative;display:flex !important;height:900px;page-break-after:always;padding:60px 90px}
    .shead{font-size:15px}.stitle{font-size:17px}.line{font-size:46px}.sfoot{font-size:13px}
    #clock,.notes{display:none !important}
  }
</style>
</head>
<body>
<div id="clock">0:00</div>
${slideHtml}
<script>
  const slides = [...document.querySelectorAll('.slide')]
  let i = 0
  const show = (n) => {
    i = Math.max(0, Math.min(slides.length - 1, n))
    slides.forEach((s, k) => s.classList.toggle('on', k === i))
    location.hash = 's' + (i + 1)
  }
  // The timer is the whole reason a presenter looks at the top right corner. It turns
  // red past four minutes, which is the format limit, not a suggestion.
  let t0 = null, running = false
  const clock = document.getElementById('clock')
  setInterval(() => {
    if (!running) return
    const s = Math.floor((performance.now() - t0) / 1000)
    clock.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
    clock.classList.toggle('over', s > 240)
  }, 250)
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); show(i + 1) }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(i - 1) }
    else if (e.key === 'Home') show(0)
    else if (e.key === 'End') show(slides.length - 1)
    else if (e.key.toLowerCase() === 's') document.body.classList.toggle('notes')
    else if (e.key.toLowerCase() === 't') {
      running = !running
      if (running && t0 === null) t0 = performance.now()
      else if (!running) { t0 = null; clock.textContent = '0:00'; clock.classList.remove('over') }
      clock.classList.toggle('run', running)
    }
    else if (e.key.toLowerCase() === 'p') print()
    else if (/^[1-9]$/.test(e.key)) show(Number(e.key) - 1)
    else if (e.key === '0') show(9)
  })
  addEventListener('click', (e) => { if (!e.target.closest('.notes')) show(i + 1) })
  show(Number((location.hash.match(/^#s(\\d+)$/) || [])[1] || 1) - 1)
</script>
</body>
</html>
`

writeFileSync(OUT, html)
const total = slides.reduce((n, s) => n + (Number((s.duration || '').replace(/\D/g, '')) || 0), 0)
console.log(`  ${slides.length} slides -> ${OUT}`)
console.log(`  budgeted ${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`)
for (const s of slides) {
  console.log(`    ${s.id.padEnd(4)} ${String(s.time).padStart(5)} ${String(s.duration).padStart(4)}  ${s.lines.length} line(s), ${s.notes.length} note para  ${s.title.slice(0, 42)}`)
}
if (slides.length !== 10) console.log(`\n  NOTE: ${slides.length} slides, the rulebook caps the deck at 10.`)
