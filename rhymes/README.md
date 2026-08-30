# რითმეული (Ritmeuli)

Georgian rhyme dictionary for lyricists, rappers and poets — a static,
fully client-side web app. 386,201 Georgian word forms searched live in the
browser (~50ms per query), no backend.

**Open `index.html` in a browser** (or serve the folder with any static file
server). Everything — dictionary included — ships as plain JS.

## Features

- **რითმები** — rhymes from the last-vowel rhyme unit (`იმედი` → `ედი`),
  in two grades: exact (ზუსტი), and kindred (მონათესავე) where consonants may
  substitute within Georgian articulation families — the voiced/aspirated/
  ejective triads ბ≈ფ≈პ, დ≈თ≈ტ, გ≈ქ≈კ, ძ≈ც≈წ, ჯ≈ჩ≈ჭ plus ზ≈ს, ჟ≈შ, ღ≈ხ≈ყ,
  მ≈ნ, რ≈ლ. Kindred rhymes render dimmed with a dotted match underline; the
  shared ending is highlighted in amber.
- **ასონანსი** — vowel-skeleton matching (`მიმიკა` → any word ending in the
  vowel sequence ი-ი-ა), for multisyllabic rap schemes.
- **ალიტერაცია** — shared word-initial letters.
- **`-` ending search** — `-ული` lists every word with that exact ending.
- Results grouped by syllable count (vowel count), with per-group expansion
  and a syllable filter; clicking a word searches it, right-click copies.
- **რვეული** — a notebook pad with a per-line syllable counter (bar lengths at
  a glance) and live rhyme suggestions for the last word written. Persists to
  `localStorage`.
- Query + mode stored in the URL hash, so searches are shareable links.

## Files

| File | Role |
| --- | --- |
| `engine.js` | Rhyme engine: Mtavruli→Mkhedruli normalization, syllable/vowel analysis, rhyme-unit detection, class-aware ending comparison, the four search modes, front-coded dictionary decoder |
| `ka-words.js` | 386,201 word forms, front-coded to 3.3MB (shared-prefix length byte + suffix per token) |
| `app.js` | UI: search, tabs, syllable groups/filter, notebook pad, clipboard, URL hash |
| `index.html`, `styles.css` | Markup and the night-studio visual theme |

## Dictionary sources & licenses

Word list built by expanding the hunspell dictionary from
[gamag/ka_GE.spell](https://github.com/gamag/ka_GE.spell) (MIT) with its own
affix rules; that dictionary is in turn compiled from
[bumbeishvili/GeoWordsDatabase](https://github.com/bumbeishvili/GeoWordsDatabase)
(MIT) and Kevin Scannell's [Crúbadán](http://crubadan.org/) corpus
(CC-BY 4.0). Filtered to modern Mkhedruli, 3–18 letters, at least one vowel.
