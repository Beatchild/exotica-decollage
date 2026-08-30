/*
 * რითმეული — Georgian rhyme engine.
 *
 * Rhyme model: two words rhyme when their endings, taken from the last vowel,
 * sound alike. "ზუსტი" (exact) means the letters match; "მონათესავე" (kindred)
 * lets consonants substitute within their Georgian articulation families —
 * the voiced/aspirated/ejective triads (ბ≈ფ≈პ, დ≈თ≈ტ, გ≈ქ≈კ, ძ≈ც≈წ, ჯ≈ჩ≈ჭ)
 * plus fricative pairs (ზ≈ს, ჟ≈შ, ღ≈ხ≈ყ), nasals (მ≈ნ) and liquids (რ≈ლ).
 * Vowels always have to match exactly. Depth = how many syllables the shared
 * ending covers, which is what multisyllabic rap rhyming cares about.
 */

const KA_VOWELS = 'აეიოუ'

const KA_CLASS = (() => {
  const groups = ['ბფპ', 'დთტ', 'გქკ', 'ძცწ', 'ჯჩჭ', 'ზს', 'ჟშ', 'ღხყ', 'მნ', 'რლ']
  const map = Object.create(null)
  for (const g of groups) for (const ch of g) map[ch] = g[0]
  return map
})()

function kaIsVowel(ch) {
  return KA_VOWELS.indexOf(ch) !== -1
}

function kaClassOf(ch) {
  return KA_CLASS[ch] || ch
}

/** Mtavruli (Ა U+1C90…) → Mkhedruli (ა U+10D0…); keep only Georgian letters. */
function kaNormalize(text) {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if (c >= 0x1c90 && c <= 0x1cbf) out += String.fromCodePoint(c - 0xbc0)
    else out += ch
  }
  return out
}

/** Last run of Georgian letters in the input — lets people paste a whole bar. */
function kaLastWord(text) {
  const m = kaNormalize(text).match(/[ა-ჰ]+(?=[^ა-ჰ]*$)/)
  return m ? m[0] : ''
}

function kaSyllables(word) {
  let n = 0
  for (let i = 0; i < word.length; i++) if (kaIsVowel(word[i])) n++
  return n
}

/** Vowel skeleton: "მიმიკა" → "იია". */
function kaVowelSeq(word) {
  let v = ''
  for (let i = 0; i < word.length; i++) if (kaIsVowel(word[i])) v += word[i]
  return v
}

/** Length of the ending from the last vowel (inclusive); 0 if no vowel. */
function kaTailLen(word) {
  for (let i = word.length - 1; i >= 0; i--) {
    if (kaIsVowel(word[i])) return word.length - i
  }
  return 0
}

/**
 * Minimal ending two words must share to count as a rhyme. For a
 * consonant-final word that's the last vowel plus the coda (ჟამს → "ამს");
 * for a vowel-final word the bare final vowel is not a rhyme, so the unit
 * reaches back to the previous vowel (იმედი → "ედი", გული → "ული").
 * 0 when the word has no vowel at all.
 */
function kaRhymeUnitLen(word) {
  let last = -1
  for (let i = word.length - 1; i >= 0; i--) {
    if (kaIsVowel(word[i])) { last = i; break }
  }
  if (last === -1) return 0
  if (last < word.length - 1) return word.length - last
  for (let j = last - 1; j >= 0; j--) {
    if (kaIsVowel(word[j])) return word.length - j
  }
  return word.length
}

/**
 * Compare endings of q and w walking back from the last letter.
 * Returns null when they don't rhyme, else:
 *   { depth, exact, n }  — n = matched letters, depth = vowels inside the
 *   shared ending, exact = true when the shared ending needs no consonant
 *   substitution over the rhyme-defining region (both words' rhyme units).
 */
function kaRhyme(q, w, qUnit) {
  let i = q.length - 1
  let j = w.length - 1
  let n = 0
  let exactRun = true
  let exactN = 0
  while (i >= 0 && j >= 0) {
    const a = q[i]
    const b = w[j]
    const av = kaIsVowel(a)
    if (av !== kaIsVowel(b)) break
    if (av) {
      if (a !== b) break
    } else if (kaClassOf(a) !== kaClassOf(b)) {
      break
    }
    n++
    if (exactRun && a === b) exactN = n
    else exactRun = false
    i--
    j--
  }
  const wUnit = kaRhymeUnitLen(w)
  if (!wUnit || n < qUnit || n < wUnit) return null
  let depth = 0
  for (let k = q.length - n; k < q.length; k++) if (kaIsVowel(q[k])) depth++
  const need = Math.max(qUnit, wUnit)
  return { depth, exact: exactN >= need, n }
}

/**
 * Decode the front-coded word pack: one token per line, first char encodes the
 * shared-prefix length as chr(33+len), except the three bytes that would break
 * a JS template literal, which are remapped: '$'→'~', '\\'→'|', '`'→'}'.
 */
function kaUnpack(packed) {
  const REMAP = { '~': 36, '|': 92, '}': 96 }
  const toks = packed.split('\n')
  const words = new Array(toks.length)
  let prev = ''
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    const p = (REMAP[t[0]] || t.charCodeAt(0)) - 33
    const w = prev.slice(0, p) + t.slice(1)
    words[i] = w
    prev = w
  }
  return words
}

/** One-time index over the word list. */
function kaIndex(words) {
  const syl = new Uint8Array(words.length)
  for (let i = 0; i < words.length; i++) syl[i] = Math.min(kaSyllables(words[i]), 255)
  return { words, syl }
}

/**
 * mode: 'rhyme' | 'assonance' | 'alliteration' | 'ending' (query began with -)
 * Returns { total, groups: Map<sylCount, [{w, exact, depth}]> } — each group
 * sorted best-first.
 */
function kaSearch(index, rawQuery, mode) {
  const { words, syl } = index
  const groups = new Map()
  let total = 0
  const add = (idx, item) => {
    const s = Math.min(syl[idx], 8)
    let g = groups.get(s)
    if (!g) groups.set(s, (g = []))
    g.push(item)
    total++
  }

  if (mode === 'ending') {
    const q = rawQuery
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      if (w.length > q.length && w.endsWith(q)) add(i, { w, exact: true, depth: kaSyllables(q) })
    }
  } else if (mode === 'rhyme') {
    const q = rawQuery
    const qUnit = kaRhymeUnitLen(q)
    if (!qUnit) return { total: 0, groups }
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      if (w === q) continue
      const r = kaRhyme(q, w, qUnit)
      if (!r) continue
      const self = w.endsWith(q) || q.endsWith(w)
      add(i, { w, exact: r.exact, depth: r.depth, n: r.n, self })
    }
  } else if (mode === 'assonance') {
    const target = kaVowelSeq(rawQuery).slice(-4)
    if (target.length < 2) return { total: 0, groups }
    const q = rawQuery
    const qUnit = kaRhymeUnitLen(q)
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      if (w === q) continue
      if (!kaVowelSeq(w).endsWith(target)) continue
      if (qUnit && kaRhyme(q, w, qUnit)) continue // already in the rhyme tab
      add(i, { w, exact: false, depth: target.length })
    }
  } else if (mode === 'alliteration') {
    const q = rawQuery
    const minPref = Math.min(Math.max(2, q.length - 1), 3)
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      if (w === q) continue
      let p = 0
      const m = Math.min(q.length, w.length)
      while (p < m && q[p] === w[p]) p++
      if (p >= minPref) add(i, { w, exact: p >= q.length, depth: p })
    }
  }

  for (const g of groups.values()) {
    g.sort((a, b) => {
      if (!!a.self !== !!b.self) return a.self ? 1 : -1
      if (a.exact !== b.exact) return a.exact ? -1 : 1
      if (a.depth !== b.depth) return b.depth - a.depth
      if ((a.n || 0) !== (b.n || 0)) return (b.n || 0) - (a.n || 0)
      return a.w < b.w ? -1 : a.w > b.w ? 1 : 0
    })
  }
  return { total, groups }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    kaNormalize, kaLastWord, kaSyllables, kaVowelSeq, kaTailLen,
    kaRhymeUnitLen, kaRhyme, kaUnpack, kaIndex, kaSearch, kaIsVowel, kaClassOf,
  }
}
