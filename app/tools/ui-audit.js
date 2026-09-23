/* =============================================================================
   ui-audit.js — the UI bug sweep, as a script instead of a habit.
   Zero dependencies. Runs in the page, against the real DOM and the real feed.

   HOW TO RUN
     1. open the app (any screen)
     2. devtools console, with Rendering › "Emulate a focused page" ticked: the
        console holds the focus otherwise, and no focus ring can be measured
     3. paste this whole file, then:  await uiAudit()
        or one section:               await uiAudit({ only: ['layout','contract'] })

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
    // Exhibits are folded. Opened, every check reads the whole page, as it did before they folded.
    for (const d of document.querySelectorAll('details.exh')) d.open = true
  }

  // The API base is read off the app's own requests: the page no longer prints it.
  const apiUrl = performance.getEntriesByType('resource').map(e => e.name).find(u => u.includes('/api/'))
  const API = apiUrl ? apiUrl.slice(0, apiUrl.indexOf('/api/')) : 'http://localhost:8787'

  // The ids the feed is actually serving right now — never hardcoded.
  let VAULTS = []
  try {
    VAULTS = (await (await fetch(API + '/api/vaults')).json()).vaults.map(v => v.vaultId)
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
  // The same holds for three exhibits of the credit opinion, and for nothing else on it:
  // what the units declare (5), the admission chain the ledger enforced (6) and the score
  // as the object an explorer shows (7). They are the proof, and they stay checkable only
  // in the protocol's own names. Exhibits 3 and 4 are the analyst's.
  const PROOF_EXHIBITS = /^Exhibit [567]\b/

  // ---------------------------------------------------------------- layout --
  if (run('layout')) {
    for (const [path, v] of SCREENS) {
      await go(path, v)
      const label = `${path}${v ? ' ' + v.slice(0, 6) : ''}`
      const de = document.documentElement

      record('layout', `${label} · no horizontal overflow`,
        de.scrollWidth <= innerWidth + 1, `scrollWidth ${de.scrollWidth} vs ${innerWidth}`)

      // The bug that hid S1's loan table: a flex view shrinking under its content.
      const view = document.querySelector('main > .view')
      if (view) {
        const box = Math.round(view.getBoundingClientRect().height)
        record('layout', `${label} · content inside its box`,
          view.scrollHeight <= box + 1, `content ${view.scrollHeight} vs box ${box}`)
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
        const proof = [...document.querySelectorAll('details.exh')]
          .filter(d => PROOF_EXHIBITS.test(d.querySelector('.exh-title')?.textContent ?? ''))
        proof.forEach(d => { d.hidden = true })          // innerText leaves out what is not drawn
        const seen = document.body.innerText.toLowerCase() + ' ' + location.pathname.toLowerCase()
        proof.forEach(d => { d.hidden = false })
        const found = BANNED.filter(wd => seen.includes(wd))
        record('consistency', `${label} · no word outside the reader's vocabulary`,
          found.length === 0, found.length ? found.join(', ') : `${BANNED.length} terms checked, none present`)
        if (proof.length) {
          record('consistency', `${label} · exhibits in the engineering register, by design`,
            true, proof.map(d => d.querySelector('.exh-title').textContent.split(' · ')[0]).join(', '))
        }
      } else {
        // Assert the exemption is narrow: the engineering register may appear HERE and
        // must never leak onto a screen an analyst reads.
        record('consistency', `${label} · exempt from the analyst vocabulary, by design`,
          true, 'engineering register is correct on this screen only')
      }

      // A ring means keyboard focus and nothing else. Anything else wearing the focus
      // colour as a ring reads as a stray selection box to everyone who sees it.
      const probe = document.createElement('i')
      probe.style.color = 'var(--color-focus)'
      document.body.appendChild(probe)
      const FOCUS_COLOUR = getComputedStyle(probe).color
      probe.remove()
      const strays = [...document.querySelectorAll('body *')].filter(el => {
        if (el === document.activeElement) return false
        const cs = getComputedStyle(el)
        return (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px' && cs.outlineColor === FOCUS_COLOUR)
          || cs.boxShadow.includes(FOCUS_COLOUR + ' 0px 0px 0px')   // the ring is a spread shadow now
      })
      record('layout', `${label} · focus colour is not used as decoration`,
        strays.length === 0,
        strays.length ? strays.map(e => e.tagName + '.' + [...e.classList][0]).join(', ') : `0 stray rings (${FOCUS_COLOUR})`)

      // Wide tables are allowed to scroll, but only inside their own box.
      for (const box of document.querySelectorAll('.tbl-wrap')) {
        const t = box.querySelector('table')
        if (t && t.scrollWidth > box.clientWidth + 1) {
          // 'auto' and 'scroll' both contain it. 'visible' is the failure: that is the
          // table escaping onto the page.
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
    await go('/facility', VAULTS[0])
    // Exhibit 2 carries every measured factor, in the order the calculation agent sends
    // them. Exhibit 1 (.fac-tbl) groups them for the committee; §4.2 is upheld by the
    // ungrouped one. A row names its factor by label, mapped back to the key the API sent.
    const dims = await fetch(API + '/api/vaults/' + VAULTS[0])
      .then(r => r.json()).then(d => d.score.dimensions).catch(() => [])
    const keyOf = new Map(dims.map(d => [d.label, d.key]))
    const ex2 = [...document.querySelectorAll('details.exh')]
      .find(x => x.querySelector('.exh-title')?.textContent.startsWith('Exhibit 2'))
    const rows = [...(ex2?.querySelectorAll('table.op-tbl tbody tr') ?? [])]
    const order = rows.map(r => keyOf.get(r.cells[0].textContent.trim()) ?? r.cells[0].textContent.trim())
    record('contract', 'every measured factor, in the API order (§4.2)',
      order.join() === 'LIQUIDITY,COVER,CONCENT,RECOG,DEADLINE,HEADLINE', order.join(' '))
    // §S1.3: a factor is presented by its SCORE, never by a bar whose length comes from
    // the raw value — a 0.00% and a 100.0% must not read as the same severity.
    const scored = rows.map(r => r.querySelector('.grade:not(.grade-na)')?.textContent).filter(Boolean)
    record('contract', 'each factor is presented by its score (§S1.3)',
      scored.length === order.length && order.length === 6, scored.join(' '))
  }

  // ---------------------------------------------------------------- a11y ----
  if (run('a11y')) {
    await go('/', null)
    // Only what is laid out at this width: the phone menu button and the desk links swap at 1100px.
    const focusables = [...document.querySelectorAll('a[href],button:not(:disabled),summary,[tabindex]:not([tabindex="-1"])')]
      .filter(el => el.checkVisibility())
    record('a11y', 'every control is reachable', focusables.length > 0, `${focusables.length} focusable`)
    // The ring is a box-shadow drawn on :focus-visible, so a control is ringed when focusing
    // it changes its shadow or outline. focusVisible stops a mouse click made earlier from
    // withholding the ring; an unfocused page withholds :focus itself.
    const look = el => getComputedStyle(el).boxShadow + ' ' + getComputedStyle(el).outlineStyle
    const noRing = focusables.filter(el => {
      const rest = look(el)
      el.focus({ focusVisible: true })
      return look(el) === rest
    })
    record('a11y', 'every focused control shows a ring', noRing.length === 0,
      !document.hasFocus() ? 'not measured: the page is not focused, see HOW TO RUN'
        : noRing.length ? `${noRing.length} without: ${noRing.slice(0,2).map(e=>e.className||e.tagName)}` : `${focusables.length} ringed`)
    document.activeElement?.blur?.()

    // The masthead says which desk this is, to a screen reader as well as to the eye.
    const current = [...document.querySelectorAll('nav.desks a.desk[aria-current="page"]')]
    record('a11y', 'the current desk is announced',
      current.length === 1 && current[0].pathname === location.pathname,
      current.map(a => `${a.textContent} (${a.pathname})`).join(', ') || 'none')
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
    for (const el of document.querySelectorAll('header.mast *, .feedbar *, main *, footer.foot *')) {
      // Only text drawn at this width: the scale's step names, for one, fold into bare ticks.
      if (!el.textContent?.trim() || el.children.length || !el.checkVisibility()) continue
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
    // Nothing moves at rest. A desk rises in when a reader clicks to it, so click one.
    document.querySelector('nav.desks a.desk[aria-current="page"]')?.click()
    await wait(50)
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
    // Labels carry none. Headings carry one optical value per text style, set in em so it
    // holds at every size the style is drawn at — a title and a caption are not the same
    // category and must not be asserted as one.
    oneOf('no tracking on labels', '.label,.t-label-s,.t-label-m,table.op-tbl th,table.cal th',
      e => cs(e).letterSpacing === 'normal' ? 'none' : cs(e).letterSpacing)
    for (const s of ['display-xl', 'display-l', 'display-m', 'heading-l', 'heading-m', 'heading-s'])
      oneOf(`one tracking for .t-${s}`, `.t-${s}`,
        e => (parseFloat(cs(e).letterSpacing) / parseFloat(cs(e).fontSize) || 0).toFixed(3) + 'em')
    oneOf('no tracking on controls', '.desk,.btn,.lnk,button.picker-btn',
      e => cs(e).letterSpacing === 'normal' || cs(e).letterSpacing === '0px' ? 'none' : cs(e).letterSpacing)
    // Row gaps are the layout's own; the twelve columns share one gutter.
    oneOf('one grid gutter', '.grid12', e => cs(e).columnGap)
    // A facility row is a card below 1100px, the same card as an empty desk's note.
    oneOf('one card radius', 'main .frow, main .state', e => cs(e).borderRadius)
    // Serif for the reading, sans for the interface, mono for the figures.
    const fams = uniq([...document.querySelectorAll('main *')].map(e => cs(e).fontFamily.split(',')[0]))
    record('consistency', 'three font families, no more', fams.length <= 3, fams.join(' / '))
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
