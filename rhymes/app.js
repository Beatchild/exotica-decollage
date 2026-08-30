/* რითმეული — UI. Depends on engine.js (kaSearch & co) and ka-words.js (KA_PACKED). */

;(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const elQ = $('q')
  const elGo = $('go')
  const elGhost = $('ghost')
  const elStatus = $('status')
  const elResults = $('results')
  const elToast = $('toast')
  const elPad = $('pad-text')
  const elGutter = $('gutter')
  const elSuggest = $('suggest')
  const elSugWord = $('sug-word')
  const elSugCloud = $('sugcloud')

  const GROUP_INITIAL = 84
  const GROUP_MAX = 600
  const PAD_KEY = 'ritmeuli.pad'

  const state = { mode: 'rhyme', syl: 0, expanded: new Set() }
  let index = null
  let lastResult = null

  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

  /* ---------- boot ---------- */

  function boot() {
    index = kaIndex(kaUnpack(KA_PACKED))
    elStatus.textContent = fmt(index.words.length) + ' სიტყვაფორმა მზადაა.'
    readHash()
    renderEmpty()
    if (elQ.value.trim()) runSearch()
    restorePad()
  }

  /* ---------- search ---------- */

  function parseQuery() {
    const raw = elQ.value.trim()
    if (!raw) return null
    if (raw.startsWith('-')) {
      const q = kaLastWord(raw.slice(1))
      return q ? { q, mode: 'ending' } : null
    }
    const q = kaLastWord(raw)
    return q ? { q, mode: state.mode } : null
  }

  function runSearch() {
    const parsed = parseQuery()
    if (!parsed) {
      lastResult = null
      renderEmpty()
      return
    }
    const t0 = performance.now()
    lastResult = kaSearch(index, parsed.q, parsed.mode)
    lastResult.ms = Math.round(performance.now() - t0)
    lastResult.q = parsed.q
    lastResult.mode = parsed.mode
    state.expanded = new Set()
    elGhost.textContent = parsed.q[parsed.q.length - 1] || 'რ'
    writeHash(parsed.q)
    renderResults()
  }

  /* ---------- rendering ---------- */

  function renderEmpty() {
    elResults.innerHTML = ''
    const div = document.createElement('div')
    div.className = 'empty'
    const h = document.createElement('p')
    h.className = 'big'
    h.textContent = 'რითმა ბოლო მარცვლებიდან იწყება.'
    const p = document.createElement('p')
    p.textContent =
      'ჩაწერე სიტყვა და ნახე ზუსტი და მონათესავე რითმები, ხმოვნების ასონანსი და ალიტერაცია — ' +
      fmt(index ? index.words.length : 386201) +
      ' ქართული სიტყვაფორმიდან.'
    const ex = document.createElement('div')
    ex.className = 'examples'
    for (const w of ['გული', 'მთვარე', 'იმედი', 'ქალაქი', 'ტრეკი', '-ული']) {
      const b = document.createElement('button')
      b.className = 'ex'
      b.textContent = w
      b.addEventListener('click', () => {
        elQ.value = w
        runSearch()
      })
      ex.appendChild(b)
    }
    div.append(h, p, ex)
    elResults.appendChild(div)
    if (index) elStatus.textContent = fmt(index.words.length) + ' სიტყვაფორმა მზადაა.'
  }

  function modeHint(mode) {
    if (mode === 'assonance') return 'მხოლოდ ხმოვნების რიგი ემთხვევა — მრავალმარცვლიანი ფლოუსთვის'
    if (mode === 'alliteration') return 'საერთო თავსართით'
    if (mode === 'ending') return 'ზუსტი დაბოლოებით'
    return 'ჟღერადობით — ზუსტი და მონათესავე (ბ≈ფ≈პ, დ≈თ≈ტ, გ≈ქ≈კ, ძ≈ც≈წ, ჯ≈ჩ≈ჭ…)'
  }

  function highlight(btn, item, mode) {
    const w = item.w
    if (mode === 'alliteration') {
      const p = Math.min(item.depth, w.length)
      btn.append(el('b', w.slice(0, p)), document.createTextNode(w.slice(p)))
      return
    }
    if (mode === 'assonance') {
      // bold the last `depth` vowels
      let need = item.depth
      const marks = new Array(w.length).fill(false)
      for (let i = w.length - 1; i >= 0 && need > 0; i--) {
        if (kaIsVowel(w[i])) {
          marks[i] = true
          need--
        }
      }
      let run = ''
      let bold = false
      for (let i = 0; i <= w.length; i++) {
        const b = i < w.length ? marks[i] : null
        if (b !== bold || i === w.length) {
          if (run) btn.append(bold ? el('b', run) : document.createTextNode(run))
          run = ''
          bold = !!b
        }
        if (i < w.length) run += w[i]
      }
      return
    }
    // rhyme / ending: bold the shared ending
    const n = Math.min(item.n || item.depth || 0, w.length)
    const cut = w.length - n
    if (cut > 0) btn.append(document.createTextNode(w.slice(0, cut)))
    btn.append(el('b', w.slice(cut)))
  }

  function el(tag, text) {
    const e = document.createElement(tag)
    e.textContent = text
    return e
  }

  function wordButton(item, mode, small) {
    const btn = document.createElement('button')
    btn.className = 'word' + (mode === 'rhyme' && !item.exact ? ' near' : '')
    btn.title = small ? 'დაჭერა კოპირებს' : 'დაჭერა ეძებს · მარჯვენა ღილაკი კოპირებს'
    highlight(btn, item, mode)
    if (small) {
      btn.addEventListener('click', () => copyText(item.w))
    } else {
      btn.addEventListener('click', () => {
        elQ.value = item.w
        runSearch()
        window.scrollTo({ top: 0, behavior: 'smooth' })
      })
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        copyText(item.w)
      })
    }
    return btn
  }

  function groupLabel(key) {
    return (key >= 8 ? '8+' : key) + ' მარცვალი'
  }

  function visibleGroups() {
    if (!lastResult) return []
    const entries = [...lastResult.groups.entries()].sort((a, b) => a[0] - b[0])
    return entries.filter(([syl]) => {
      if (state.syl === 0) return true
      if (state.syl === 6) return syl >= 6
      return syl === state.syl
    })
  }

  function renderResults() {
    elResults.innerHTML = ''
    if (!lastResult) return renderEmpty()
    const groups = visibleGroups()
    const shownTotal = groups.reduce((s, [, g]) => s + g.length, 0)

    elStatus.innerHTML = ''
    const nEl = document.createElement('span')
    nEl.className = 'n'
    nEl.textContent = fmt(shownTotal)
    elStatus.append(nEl, document.createTextNode(' სიტყვა · ' + modeHint(lastResult.mode)))
    if (lastResult.mode === 'rhyme') {
      const lg = document.createElement('span')
      lg.className = 'legend'
      lg.append(document.createTextNode('მკრთალი '))
      const nearEx = document.createElement('span')
      nearEx.className = 'lg-near'
      nearEx.textContent = 'სიტყვა'
      lg.append(nearEx, document.createTextNode(' — მონათესავე რითმა'))
      elStatus.append(lg)
    }

    if (shownTotal === 0) {
      const d = document.createElement('div')
      d.className = 'empty'
      const b = document.createElement('p')
      b.className = 'big'
      b.textContent = 'ვერაფერი ვიპოვე.'
      const p = document.createElement('p')
      p.textContent =
        lastResult.mode === 'assonance' && kaVowelSeq(lastResult.q).length < 2
          ? 'ასონანსს სულ მცირე ორხმოვნიანი სიტყვა სჭირდება.'
          : 'სცადე სიტყვის სხვა ფორმა, სხვა რეჟიმი, ან მოკლე დაბოლოება დეფისით (-არე).'
      d.append(b, p)
      elResults.appendChild(d)
      return
    }

    const frag = document.createDocumentFragment()
    for (const [syl, items] of groups) {
      const sec = document.createElement('section')
      sec.className = 'group'
      const h = document.createElement('h3')
      h.append(
        document.createTextNode(groupLabel(syl)),
        Object.assign(document.createElement('span'), {
          className: 'count',
          textContent: fmt(items.length),
        }),
      )
      sec.appendChild(h)

      const cloud = document.createElement('div')
      cloud.className = 'cloud'
      const expanded = state.expanded.has(syl)
      const cap = expanded ? GROUP_MAX : GROUP_INITIAL
      for (const item of items.slice(0, cap)) {
        cloud.appendChild(wordButton(item, lastResult.mode, false))
      }
      if (items.length > cap) {
        const more = document.createElement('button')
        more.className = 'more'
        more.textContent = expanded
          ? 'ნაჩვენებია პირველი ' + fmt(GROUP_MAX)
          : 'კიდევ ' + fmt(Math.min(items.length, GROUP_MAX) - cap)
        if (!expanded) {
          more.addEventListener('click', () => {
            state.expanded.add(syl)
            renderResults()
          })
        } else {
          more.disabled = true
        }
        cloud.appendChild(more)
      }
      sec.appendChild(cloud)
      frag.appendChild(sec)
    }
    elResults.appendChild(frag)
  }

  /* ---------- notebook pad ---------- */

  function padLines() {
    return elPad.value.split('\n')
  }

  function renderGutter() {
    const lines = padLines()
    elGutter.textContent = ''
    const frag = document.createDocumentFragment()
    for (let i = 0; i < lines.length; i++) {
      const n = kaSyllables(kaNormalize(lines[i]))
      const div = document.createElement('div')
      div.textContent = n > 0 ? String(n) : '·'
      if (n > 0) div.className = 'beat'
      frag.appendChild(div)
    }
    elGutter.appendChild(frag)
  }

  function padSuggest() {
    const lines = padLines()
    let word = ''
    for (let i = lines.length - 1; i >= 0 && !word; i--) word = kaLastWord(lines[i])
    if (!word || !index) {
      elSuggest.hidden = true
      return
    }
    const res = kaSearch(index, word, 'rhyme')
    const flat = []
    for (const [, g] of res.groups) for (const it of g) flat.push(it)
    flat.sort((a, b) => {
      if (!!a.self !== !!b.self) return a.self ? 1 : -1
      if (a.exact !== b.exact) return a.exact ? -1 : 1
      if (a.depth !== b.depth) return b.depth - a.depth
      return (b.n || 0) - (a.n || 0)
    })
    const picks = flat.slice(0, 14)
    elSugWord.textContent = word
    elSugCloud.innerHTML = ''
    for (const item of picks) elSugCloud.appendChild(wordButton(item, 'rhyme', true))
    elSuggest.hidden = picks.length === 0
  }

  function restorePad() {
    try {
      const saved = localStorage.getItem(PAD_KEY)
      if (saved) elPad.value = saved
    } catch {
      /* private mode — pad just won't persist */
    }
    renderGutter()
    padSuggest()
  }

  function savePad() {
    try {
      localStorage.setItem(PAD_KEY, elPad.value)
    } catch {
      /* ignore */
    }
  }

  /* ---------- clipboard + toast ---------- */

  let toastTimer = 0

  function toast(msg) {
    elToast.textContent = msg
    elToast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => elToast.classList.remove('show'), 1400)
  }

  function copyText(text) {
    const done = () => toast('დაკოპირდა — ' + (text.length > 24 ? text.slice(0, 24) + '…' : text))
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done))
    } else {
      fallbackCopy(text, done)
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      done()
    } catch {
      toast('ვერ დავაკოპირე')
    }
    ta.remove()
  }

  /* ---------- URL hash ---------- */

  function writeHash(q) {
    const h = '#q=' + encodeURIComponent(q) + '&m=' + state.mode
    history.replaceState(null, '', h)
  }

  function readHash() {
    const m = location.hash.match(/q=([^&]+)/)
    const mm = location.hash.match(/m=(rhyme|assonance|alliteration)/)
    if (mm) setMode(mm[1], false)
    if (m) {
      try {
        elQ.value = decodeURIComponent(m[1])
      } catch {
        /* bad hash — ignore */
      }
    }
  }

  /* ---------- events ---------- */

  function setMode(mode, search) {
    state.mode = mode
    for (const t of document.querySelectorAll('.tab')) {
      t.setAttribute('aria-selected', String(t.dataset.mode === mode))
    }
    if (search !== false && elQ.value.trim()) runSearch()
  }

  let debounceTimer = 0
  elQ.addEventListener('input', () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(runSearch, 260)
  })
  elQ.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer)
      runSearch()
    }
  })
  elGo.addEventListener('click', runSearch)

  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => setMode(t.dataset.mode))
  }

  $('sylfilter').addEventListener('click', (e) => {
    const chip = e.target.closest('.sylchip')
    if (!chip) return
    state.syl = Number(chip.dataset.syl)
    for (const c of document.querySelectorAll('.sylchip')) {
      c.setAttribute('aria-pressed', String(c === chip))
    }
    if (lastResult) renderResults()
  })

  let padTimer = 0
  elPad.addEventListener('input', () => {
    renderGutter()
    savePad()
    clearTimeout(padTimer)
    padTimer = setTimeout(padSuggest, 420)
  })
  elPad.addEventListener('scroll', () => {
    elGutter.scrollTop = elPad.scrollTop
  })

  $('pad-copy').addEventListener('click', () => {
    if (elPad.value.trim()) copyText(elPad.value)
  })
  $('pad-clear').addEventListener('click', () => {
    if (!elPad.value || confirm('წავშალო რვეული?')) {
      elPad.value = ''
      savePad()
      renderGutter()
      padSuggest()
    }
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== elPad && document.activeElement !== elQ) {
      e.preventDefault()
      elQ.focus()
      elQ.select()
    }
  })

  // Data is already parsed (scripts are sequential); boot on next frame so the
  // first paint shows the shell before the 386k-word unpack runs.
  requestAnimationFrame(() => setTimeout(boot, 0))
})()
