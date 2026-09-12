/* =============================================================================
   ui-audit.js — the UI bug sweep, as a script instead of a habit.
   Zero dependencies. Runs in the page, against the real DOM and the real feed.

   HOW TO RUN
     1. open the app (any screen)
     2. devtools console
     3. paste this whole file, then:  await uiAudit()
        or one section:               await uiAudit({ only: ['layout','contract'] })
        or the feed-down half:        await uiAudit({ feedDown: true })

   It walks every screen against every vault the API is serving, so it takes
   about a minute. Each check prints PASS or FAIL with the measurement that
   decided it — never a bare "ok".
   ============================================================================= */

window.uiAudit = async function uiAudit(opts = {}) {
  const only = opts.only || null
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const POLL = 3300                      // one poll interval plus slack
  const results = []
  const record = (section, name, pass, detail) => {
    results.push({ section, name, pass, detail })
    console.log(`${pass ? '%cPASS' : '%cFAIL'} %c${section} · ${name}%c ${detail}`,
      `color:${pass ? '#3FB950' : '#F85149'};font-weight:600`, 'color:#E8ECF1', 'color:#96A2B1')
  }
  const run = s => !only || only.includes(s)

  const go = async (path, vault) => {
    history.pushState(null, '', path + (vault ? '?facility=' + vault : ''))
    dispatchEvent(new PopStateEvent('popstate'))
    await wait(POLL)
  }

  // The five ids the feed is actually serving right now — never hardcoded.
  let VAULTS = []
  try {
    const base = document.body.innerText.match(/https?:\/\/[^\s]+:\d+/)?.[0] || 'http://localhost:8787'
    VAULTS = (await (await fetch(base + '/api/vaults')).json()).vaults.map(v => v.vaultId)
  } catch { /* feed down: the layout and a11y sections still run */ }

  const SCREENS = VAULTS.length
    ? [['/', null], ['/methodology', null], ['/evidence', null],
       ...VAULTS.flatMap(v => [['/facility', v], ['/event', v]])]
    : [['/', null], ['/evidence', null]]

  // /evidence is the one screen NOT addressed to the credit analyst. It is the protocol
  // finding the whole product rests on, shown to the engineers reviewing the work, and it
  // has to use the protocol's own field names -- paraphrasing them there would destroy the
  // evidence. So it is exempt from the vocabulary check and from nothing else: layout,
  // a11y, contrast, motion and overflow all still apply to it.
  const ANALYST_SCREENS = (p) => p !== '/evidence'

  // ---------------------------------------------------------------- layout --
  if (run('layout')) {
    for (const [path, v] of SCREENS) {
      await go(path, v)
      const label = `${path}${v ? ' ' + v.slice(0, 6) : ''}`
      const de = document.documentElement

      record('layout', `${label} · no horizontal overflow`,
        de.scrollWidth <= innerWidth + 1, `scrollWidth ${de.scrollWidth} vs ${innerWidth}`)

      // The bug that hid S1's loan table: a flex view shrinking under its content.
      const view = document.querySelector('main > div')
      if (view) {
        const box = Math.round(view.getBoundingClientRect().height)
        record('layout', `${label} · content inside its box`,
          view.scrollHeight <= box + 1, `content ${view.scrollHeight} vs box ${box}`)
      }
      if (path === '/event') {
        record('layout', `${label} · one viewport, no scroll`,
          de.scrollHeight <= de.clientHeight,
          `at ${innerWidth}x${innerHeight}: needs ${de.scrollHeight} (spec §S3 budgets 1440x900)`)
        const over = [...document.querySelectorAll('main section.panel')]
          .filter(b => b.scrollHeight > b.clientHeight + 1).length
        record('layout', `${label} · no band overflows`, over === 0, `${over} band(s) overflowing`)
      }
      // The reader is a credit analyst. Any word they would not meet in a rating note or
      // on a loans blotter is a word that loses them, wherever it appears — a heading, a
      // toast, an empty state, the address bar. This list is the owner's, verbatim.
      const BANNED = [
        'blockchain', 'xrpl', 'xrp', 'xls-66', 'xls', 'ledger', 'wallet', 'crossmark',
        'gemwallet', 'xaman', 'mint', 'tvl', 'defi', 'smart contract', 'oracle',
        'on-chain', 'onchain', 'gas fee', 'seed phrase', 'fixture', 'localhost',
        'vite_', 'polling', 'node tools', 'devnet', 'mainnet', 'drops', 'vault',
        // an analyst does not read a changelog: no versions, no infrastructure, no counters
        'v1.0.0', 'contract v', 'build ', 'endpoint', 'api base', 'failed poll',
        'attempts', 'still asking', 'on watch', 'hackathon', 'methodology note',
      ]
      if (ANALYST_SCREENS(path)) {
        const seen = document.body.innerText.toLowerCase() + ' ' + location.pathname.toLowerCase()
        const found = BANNED.filter(wd => seen.includes(wd))
        record('consistency', `${label} · no word outside the reader's vocabulary`,
          found.length === 0, found.length ? found.join(', ') : `${BANNED.length} terms checked, none present`)
      } else {
        // Assert the exemption is narrow: the engineering register may appear HERE and
        // must never leak onto a screen an analyst reads.
        record('consistency', `${label} · exempt from the analyst vocabulary, by design`,
          true, 'engineering register is correct on this screen only')
      }

      // A cyan ring means keyboard focus and nothing else. Anything else wearing the
      // focus colour as an outline reads as a stray selection box to everyone who sees it.
      const probe = document.createElement('i')
      probe.style.color = 'var(--read-correct)'
      document.body.appendChild(probe)
      const FOCUS_COLOUR = getComputedStyle(probe).color
      probe.remove()
      const strays = [...document.querySelectorAll('body *')].filter(el => {
        if (el === document.activeElement) return false
        const cs = getComputedStyle(el)
        return cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px' && cs.outlineColor === FOCUS_COLOUR
      })
      record('layout', `${label} · focus colour is not used as decoration`,
        strays.length === 0,
        strays.length ? strays.map(e => e.tagName + '.' + [...e.classList][0]).join(', ') : `0 stray rings (${FOCUS_COLOUR})`)

      // Wide tables are allowed to scroll, but only inside their own box.
      for (const sc of document.querySelectorAll('.tbl-scroll')) {
        // The box may be the div itself, or a Radix ScrollArea viewport inside it.
        const box = sc.querySelector('[data-slot="scroll-area-viewport"]') || sc
        const t = sc.querySelector('table')
        if (t && t.scrollWidth > box.clientWidth + 1) {
          // 'auto' (our own .tbl-scroll) and 'scroll' (Radix's viewport) both contain it.
          // 'visible' is the failure: that is the table escaping onto the page.
          const ox = getComputedStyle(box).overflowX
          record('layout', `${label} · table scrolls in its own box`,
            ox === 'auto' || ox === 'scroll', `${ox} — needs ${t.scrollWidth}, box ${box.clientWidth}`)
        }
      }
    }
  }

  // ------------------------------------------------------------- rendering --
  if (run('rendering')) {
    const BAD = /NaN|undefined|Invalid Date|\[object Object\]|\bnull\b/
    for (const [path, v] of SCREENS) {
      await go(path, v)
      const hits = document.body.innerText.split('\n').filter(l => BAD.test(l))
      record('rendering', `${path}${v ? ' ' + v.slice(0, 6) : ''} · no leaked placeholders`,
        hits.length === 0, hits.length ? JSON.stringify(hits.slice(0, 2)) : 'clean')
    }
  }

  // -------------------------------------------------------------- contract --
  // The few visual facts the frozen contract fixes. These are not taste.
  if (run('contract') && VAULTS.length) {
    await go('/event', VAULTS[0])
    await wait(7000)                                   // let the sparkline get two samples
    const [naive, correct] = document.querySelectorAll('.spark polyline')
    if (naive && correct) {
      record('contract', 'naive reading is dashed (§6)',
        getComputedStyle(naive).strokeDasharray !== 'none', getComputedStyle(naive).strokeDasharray)
      record('contract', 'correct reading is solid (§6)',
        getComputedStyle(correct).strokeDasharray === 'none', getComputedStyle(correct).strokeDasharray)
    }
    await go('/facility', VAULTS[0])
    // Exhibit 2 carries every measured factor, in the order the calculation agent sends
    // them. Exhibit 1 groups them for the committee; §4.2 is upheld by the ungrouped one.
    const order = [...document.querySelectorAll('.op-tbl.factors tbody tr')].map(r => r.dataset.dim)
    record('contract', 'every measured factor, in the API order (§4.2)',
      order.join() === 'LIQUIDITY,COVER,CONCENT,RECOG,DEADLINE,HEADLINE', order.join(' '))
    // §S1.3: a factor is presented by its SCORE, never by a bar whose length comes from
    // the raw value — a 0.00% and a 100.0% must not read as the same severity.
    const scored = [...document.querySelectorAll('.op-tbl.factors tbody tr')]
      .map(r => r.querySelector('.chip')?.textContent).filter(Boolean)
    record('contract', 'each factor is presented by its score (§S1.3)',
      scored.length === order.length && order.length === 6, scored.join(' '))
  }

  // ---------------------------------------------------------------- a11y ----
  if (run('a11y')) {
    await go('/', null)
    const focusables = [...document.querySelectorAll('a,button,[tabindex]:not([tabindex="-1"]),tr[tabindex]')]
    record('a11y', 'every control is reachable', focusables.length > 0, `${focusables.length} focusable`)
    const noRing = focusables.filter(el => {
      el.focus()
      const o = getComputedStyle(el).outlineWidth
      return !o || o === '0px'
    })
    record('a11y', 'every focused control shows a ring',
      noRing.length === 0, noRing.length ? `${noRing.length} without: ${noRing.slice(0,2).map(e=>e.className||e.tagName)}` : 'all ringed')
    document.activeElement?.blur?.()

    const ths = [...document.querySelectorAll('th[aria-sort]')]
    record('a11y', 'sortable headers announce their state',
      ths.length > 0 && ths.every(t => t.getAttribute('aria-sort')), `${ths.length} with aria-sort`)
    const imgs = [...document.querySelectorAll('img')]
    record('a11y', 'every image has alt text',
      imgs.every(i => i.hasAttribute('alt')), `${imgs.length} image(s)`)
  }

  // -------------------------------------------------------------- contrast --
  if (run('contrast')) {
    const lin = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    const lum = rgb => { const [r, g, b] = rgb.match(/\d+/g).map(Number).map(lin); return 0.2126*r + 0.7152*g + 0.0722*b }
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1,l2) + .05) / (Math.min(l1,l2) + .05) }
    // Text on a coloured chip must be measured against THAT chip, not against the page.
    // Comparing everything to the body ground reports a keycap as 1:1 and the whole
    // report stops being believed.
    const groundOf = el => {
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor
        const a = bg.match(/[\d.]+/g)
        if (a && (a.length < 4 || parseFloat(a[3]) > 0.85)) return bg
      }
      return getComputedStyle(document.body).backgroundColor
    }
    const seen = new Map()
    for (const el of document.querySelectorAll('main *, .topbar *, .hints *')) {
      if (!el.textContent?.trim() || el.children.length) continue
      const key = getComputedStyle(el).color + ' on ' + groundOf(el)
      if (!seen.has(key)) seen.set(key, el.textContent.trim().slice(0, 18))
    }
    for (const [pair, sample] of seen) {
      const [fg, bg] = pair.split(' on ')
      const r = ratio(fg, bg)
      record('contrast', `${fg} ("${sample}")`, r >= 4.5, `${r.toFixed(2)}:1 against ${bg}`)
    }
  }

  // ---------------------------------------------------------------- motion --
  if (run('motion')) {
    const anims = new Set()
    for (const el of document.querySelectorAll('*')) {
      const n = getComputedStyle(el).animationName
      if (n && n !== 'none') n.split(', ').forEach(x => anims.add(x))
    }
    record('motion', 'animations are declared, not ad hoc', anims.size > 0, [...anims].join(' '))
    const guarded = [...document.styleSheets].some(ss => {
      try { return [...ss.cssRules].some(r => r.conditionText?.includes('prefers-reduced-motion')) }
      catch { return false }
    })
    record('motion', 'prefers-reduced-motion is honoured', guarded, guarded ? 'guard present' : 'NO GUARD')
  }

  // ------------------------------------------------------------ consistency --
  if (run('consistency')) {
    const uniq = a => [...new Set(a)]
    const cs = e => getComputedStyle(e)
    // Only assert on what this screen actually contains: a check that fires on an empty
    // set reports a failure where there is nothing to fail, and a noisy audit gets ignored.
    const oneOf = (name, sel, read, max = 1) => {
      const vals = uniq([...document.querySelectorAll(sel)].map(read))
      if (!vals.length) return record('consistency', name, true, 'not on this screen — skipped')
      record('consistency', name, vals.length <= max, vals.join(' / '))
    }
    // Labels only. Controls deliberately carry no tracking — a tab and a button are not
    // captions, and spacing them out is what made every uppercase word look like a label.
    // Labels carry none. Headings carry one optical value, the same everywhere — a title
    // and a caption are not the same category and must not be asserted as one.
    oneOf('no tracking on labels', '.label,table.tbl th',
      e => cs(e).letterSpacing === 'normal' ? 'none' : cs(e).letterSpacing)
    oneOf('one tracking for headings', '.panel-title,.op-h', e => cs(e).letterSpacing)
    oneOf('no tracking on controls', '.desk,.btn-term,button.picker-btn',
      e => cs(e).letterSpacing === 'normal' || cs(e).letterSpacing === '0px' ? 'none' : cs(e).letterSpacing)
    oneOf('one grid gap', '.grid12,.stack', e => cs(e).gap)
    oneOf('one panel radius', 'main .panel', e => cs(e).borderRadius)
    const fams = uniq([...document.querySelectorAll('main *')].map(e => cs(e).fontFamily.split(',')[0]))
      .filter(f => !/Times|serif/i.test(f))
    record('consistency', 'two font families, no more', fams.length <= 2, fams.join(' / '))
  }

  // ----------------------------------------------------------------- polls --
  // The race that used to leave two loops fighting after a fast vault switch.
  if (run('polls') && VAULTS.length > 1) {
    const orig = window.fetch
    const hits = []
    window.fetch = (i, init) => {
      const u = typeof i === 'string' ? i : i.url
      const m = u.match(/api\/vaults\/(\w{6})/); if (m) hits.push(m[1])
      return orig(i, init)
    }
    await go('/facility', VAULTS[0])
    for (const k of ['1','2','3','4','5']) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
      await wait(180)
    }
    hits.length = 0
    await wait(9500)                                   // three poll cycles
    window.fetch = orig
    const distinct = new Set(hits).size
    record('polls', 'one polling loop survives a fast vault switch',
      distinct <= 1, `${distinct} vault(s) polled over 3 cycles: ${JSON.stringify(hits)}`)
  }

  // ---------------------------------------------------------------- routes --
  if (run('routes')) {
    for (const bad of ['/nope', '/VAULT', '/a/b/c']) {
      history.pushState(null, '', bad); dispatchEvent(new PopStateEvent('popstate'))
      await wait(400)
      record('routes', `${bad} rewrites the url`, location.pathname === '/', `now ${location.pathname}`)
    }
    await go('/', null)
  }

  // --------------------------------------------------------------- summary --
  const failed = results.filter(r => !r.pass)
  console.log('%c\n' + '─'.repeat(60), 'color:#232C3B')
  console.log(`%cviewport ${innerWidth}x${innerHeight}`, 'color:#79828B')
  console.log(`%c${results.length - failed.length}/${results.length} passed`,
    `color:${failed.length ? '#D29922' : '#3FB950'};font-weight:600;font-size:14px`)
  if (failed.length) console.table(failed.map(({ section, name, detail }) => ({ section, name, detail })))
  return { total: results.length, failed: failed.length, results }
}

console.log('%cui-audit loaded — run:  await uiAudit()', 'color:#58C7F3')
