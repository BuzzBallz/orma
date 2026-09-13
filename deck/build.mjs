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
    const meta = body.match(/<!--\s*time:\s*([^|]+)\|\s*duration:\s*([^|>]+?)\s*(?:\|\s*layout:\s*([a-z]+)\s*)?(?:\|\s*artifact:\s*([a-z-]+)\s*)?-->/)

    const onScreenRaw = (body.match(/###[ \t]*on screen[ \t]*\n([\s\S]*?)(?=\n###|\n---|$)/i) || [])[1] || ''
    const notesRaw = (body.match(/###[ \t]*notes[ \t]*\n([\s\S]*?)(?=\n###|\n---|$)/i) || [])[1] || ''

    const lines = onScreenRaw.split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('<!--') && !l.startsWith('###'))
      .map((l) => l.replace(/^[-*]\s+/, ''))

    slides.push({
      id: id || `S${slides.length + 1}`,
      title,
      time: meta ? meta[1].trim() : '',
      duration: meta ? meta[2].trim() : '',
      layout: meta && meta[3] ? meta[3].trim() : '',
      artifact: meta && meta[4] ? meta[4].trim() : '',
      lines,
      notes: notesRaw.trim().split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean),
    })
  }
  return slides
}

// Normalise line endings once, here. The content file is edited on Windows and arrives
// CRLF; every regex below then only has to think about \n, which is one fewer thing to
// get wrong in a parser that is edited under time pressure.
const slides = parse(readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n'))
if (!slides.length) {
  console.error(`  ${SRC} produced no slides. Check the heading format: "## S1 — Title".`)
  process.exit(1)
}

/** The mark, inline, so the deck stays a single file that works from any directory. */
const MARK = `<svg class="mark" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path d="M32 6c10.5 0 18 8.9 18 21.5S42.5 49 32 49 14 40.1 14 27.5 21.5 6 32 6Zm0 4.6c-5.6 0-8.9 6.6-8.9 16.9s3.3 16.9 8.9 16.9 8.9-6.6 8.9-16.9S37.6 10.6 32 10.6Z" fill="#EAE0CE"/>
      <path d="M7 54.2c5.6-3.6 9.9-3.6 14.5-.9 5.2 3 8.4 3.1 12.9.4 5.5-3.3 9.7-3.4 14.8-.6 3.2 1.8 6 1.9 8.8.4" stroke="#EAE0CE" stroke-width="2.1" stroke-linecap="round"/>
      <path d="M11 59.6c5.3-2.6 9.4-2.6 13.7-.4 4.9 2.5 8 2.5 12.2.1 5.2-2.9 9.2-3 14-.6" stroke="#C9A45F" stroke-width="2.1" stroke-linecap="round"/>
    </svg>`

/**
 * One glyph per slide, drawn here rather than fetched.
 *
 * Deliberately line art in the brand's two colours, at low weight and set to the side: a
 * slide's job is to hold one idea, and an illustration that competes with the sentence has
 * taken the job away from it. Nothing is a third-party mark, so nothing has to be cleared.
 */
const A = (d) => `<svg class="artifact" viewBox="0 0 64 64" fill="none" aria-hidden="true">${d}</svg>`
const GLYPHS = {
  // a shackle closed over a body: the lock-up
  lock: A(`<rect x="16" y="29" width="32" height="24" rx="3" stroke="var(--fg)" stroke-width="2"/>
    <path d="M23 29v-7a9 9 0 0 1 18 0v7" stroke="var(--gold)" stroke-width="2" stroke-linecap="round"/>
    <circle cx="32" cy="40" r="3" fill="var(--gold)"/>`),
  // three bars, the three pillars
  layers: A(`<rect x="12" y="14" width="40" height="9" rx="2" stroke="var(--fg)" stroke-width="2"/>
    <rect x="12" y="27" width="40" height="9" rx="2" stroke="var(--fg)" stroke-width="2"/>
    <rect x="12" y="40" width="40" height="9" rx="2" stroke="var(--gold)" stroke-width="2"/>`),
  // two readings of one thing, one dashed and low, one solid: the contract's own convention
  split: A(`<path d="M10 32h16" stroke="var(--fg)" stroke-width="2"/>
    <path d="M26 32 44 18" stroke="var(--fg)" stroke-width="2" stroke-dasharray="4 4"/>
    <path d="M26 32 44 46" stroke="var(--gold)" stroke-width="2"/>
    <circle cx="46" cy="18" r="3" stroke="var(--fg)" stroke-width="2"/>
    <circle cx="46" cy="46" r="3" fill="var(--gold)"/>`),
  // a sequence, reordered: the ordering lever
  order: A(`<rect x="12" y="16" width="14" height="14" rx="2" stroke="var(--gold)" stroke-width="2"/>
    <rect x="12" y="36" width="9" height="9" rx="2" stroke="var(--fg)" stroke-width="2"/>
    <path d="M34 23h16M34 40h16" stroke="var(--fg)" stroke-width="2" stroke-linecap="round"/>
    <path d="M45 18l5 5-5 5" stroke="var(--gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
  // a token that carries a pointer outward
  token: A(`<circle cx="26" cy="32" r="14" stroke="var(--fg)" stroke-width="2"/>
    <path d="M40 32h14" stroke="var(--gold)" stroke-width="2" stroke-linecap="round"/>
    <path d="M49 27l5 5-5 5" stroke="var(--gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
  // one way through, one refused
  gate: A(`<path d="M18 12v40M46 12v40" stroke="var(--fg)" stroke-width="2" stroke-linecap="round"/>
    <path d="M10 26h12" stroke="var(--gold)" stroke-width="2" stroke-linecap="round"/>
    <path d="M28 26h8" stroke="var(--gold)" stroke-width="2" stroke-linecap="round"/>
    <path d="M50 40l8 0M54 36l-4 4 4 4" stroke="var(--fg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
  // a record with a mark against it: the findings
  report: A(`<rect x="16" y="10" width="32" height="44" rx="3" stroke="var(--fg)" stroke-width="2"/>
    <path d="M24 24h16M24 32h16M24 40h9" stroke="var(--fg)" stroke-width="2" stroke-linecap="round"/>
    <circle cx="44" cy="44" r="7" fill="var(--bg)" stroke="var(--gold)" stroke-width="2"/>
    <path d="M41 44l2 2 4-4" stroke="var(--gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
  // a clock, for the one immutable date
  clock: A(`<circle cx="32" cy="32" r="20" stroke="var(--fg)" stroke-width="2"/>
    <path d="M32 20v12l8 5" stroke="var(--gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
}


const slideHtml = slides.map((s, i) => `
  <section class="slide${s.layout ? ' ' + s.layout : ''}" data-i="${i}">
    <header class="shead">
      <span class="sid">${esc(s.id)}</span>
      <span class="stitle">${inline(s.title)}</span>
      <span class="stime">${esc(s.time)}${s.duration ? ` &middot; ${esc(s.duration)}` : ''}</span>
    </header>
    <div class="sbody">
      ${s.layout === 'cover' ? MARK + '<p class="wordmark">Orma</p>' : ''}
      ${s.lines.map((l) => `<p class="line">${inline(l)}</p>`).join('\n      ')}
    </div>
    ${s.artifact && GLYPHS[s.artifact] ? GLYPHS[s.artifact] : ''}
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
  /* An opening slide carries the mark and nothing else: no section label, no timing, no
     page number. The speaker carries the words. Any lines the slide does have are set
     below the mark, so the same layout works whether or not it has text. */
  .slide.cover{ align-items:center; justify-content:center; gap:4vh; }
  .slide.cover .shead, .slide.cover .sfoot{ display:none; }
  .slide.cover .sbody{ flex:0 0 auto; align-items:center; text-align:center; gap:2vh; }
  .slide.cover .mark{ width:22vh; height:22vh; }
  .slide.cover .wordmark{
    font:600 4.6vh/1 var(--mono); letter-spacing:.26em; text-transform:uppercase;
    color:var(--fg); margin:0;
  }
  .slide.cover .line{ font-size:2.2vw; color:var(--dim); max-width:52ch; font-weight:400; }
  .slide.on{display:flex}
  .shead{display:flex;align-items:baseline;gap:1.2rem;
    font:500 1.1vw/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--mute);
    border-bottom:1px solid var(--line);padding-bottom:1.6vh}
  .sid{color:var(--gold)}
  .stitle{color:var(--dim);text-transform:none;letter-spacing:.02em;font-size:1.25vw}
  /* Scheduled time and duration are rehearsal aids, not something a jury should read off
     the wall. Shown only with the speaker notes, so pressing S gives the presenter both
     and presenting gives the audience neither. */
  .stime{margin-left:auto;display:none}
  body.notes .stime{display:inline}
  .sbody{flex:1;display:flex;flex-direction:column;justify-content:center;gap:2.4vh}
  /* One idea per slide, so the type is large and there is deliberately little of it. */
  .line{margin:0;font-size:3.4vw;line-height:1.22;letter-spacing:-.015em;font-weight:500}
  .line code{font-family:var(--mono);font-size:.86em;color:var(--gold)}
  .line b{color:var(--gold);font-weight:600}
  /* Set to the side and held back: the sentence is the slide, this only anchors it. */
  .artifact{
    position:absolute; right:7vw; top:50%; transform:translateY(-50%);
    width:15vh; height:15vh; opacity:.5; pointer-events:none;
  }
  .slide.cover .artifact{ display:none }
  @media print{ .artifact{ width:150px; height:150px; right:90px } }

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
  /* A rehearsal tool, not part of the presentation. Hidden until T starts it, so it is
     never on screen in front of a jury unless the presenter asked for it. */
  #clock{position:fixed;top:1.2vh;right:1.2vw;z-index:10;display:none;
    font:600 1.1vw/1 var(--mono);letter-spacing:.06em;color:var(--mute)}
  #clock.run{display:block;color:var(--gold)}
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
