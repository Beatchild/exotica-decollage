import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { spawn } from 'node:child_process'
import { createReadStream, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const YT_URL = /^https?:\/\/((www|music|m)\.)?(youtube\.com|youtu\.be)\//
const FETCHABLE = (u: string) => YT_URL.test(u) || u.startsWith('ytsearch1:')

/** Track entries in a Spotify embed page: adjacent "title"/"subtitle" pairs. */
function scanTrackPairs(doc: string): string[] {
  const out: string[] = []
  const re = /"title":"((?:[^"\\]|\\.)*)","subtitle":"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(doc))) {
    try {
      out.push(`${JSON.parse(`"${m[1]}"`)} ${JSON.parse(`"${m[2]}"`)}`)
    } catch { /* skip malformed pair */ }
  }
  return out
}

/**
 * Dev-server-embedded YouTube audio fetcher. The browser can't reach YouTube
 * streams itself (CORS + stream protection), so the Vite dev server shells out
 * to the system yt-dlp and streams bestaudio back to the client, which then
 * decodes, analyzes and keeps only the useful cuts. Dev-time tool only —
 * a static production build has no server half.
 */
function ytFetchPlugin(): Plugin {
  return {
    name: 'yt-fetch',
    configureServer(server) {
      server.middlewares.use('/api/yt-check', (_req, res) => {
        const probe = spawn('yt-dlp', ['--version'])
        let out = ''
        probe.stdout.on('data', (d) => (out += d))
        probe.on('error', () => {
          res.statusCode = 404
          res.end('yt-dlp not found')
        })
        probe.on('close', (code) => {
          res.statusCode = code === 0 ? 200 : 404
          res.end(code === 0 ? out.trim() : 'yt-dlp not found')
        })
      })

      server.middlewares.use('/api/yt-expand', (req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost').searchParams.get('url') ?? ''
        if (!FETCHABLE(url)) {
          res.statusCode = 400
          res.end('Not a YouTube URL')
          return
        }
        const proc = spawn('yt-dlp', [
          '--flat-playlist', '--playlist-end', '8', '--print', 'id', url,
        ])
        let out = ''
        proc.stdout.on('data', (d) => (out += d))
        proc.on('error', () => {
          res.statusCode = 500
          res.end('yt-dlp failed to start — is it installed?')
        })
        proc.on('close', (code) => {
          const ids = out.trim().split(/\r?\n/).filter(Boolean)
          if (code !== 0 || ids.length === 0) {
            res.statusCode = 500
            res.end('Playlist could not be read — private, empty or unavailable.')
            return
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(ids.map((id) => `https://www.youtube.com/watch?v=${id}`)))
        })
      })

      server.middlewares.use('/api/spotify', (req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost').searchParams.get('url') ?? ''
        const m = url.match(/open\.spotify\.com\/.*?(track|playlist|album)\/([A-Za-z0-9]{10,})/)
        if (!m) {
          res.statusCode = 400
          res.end('Not a Spotify track/album/playlist URL')
          return
        }
        void (async () => {
          try {
            const page = await fetch(`https://open.spotify.com/embed/${m[1]}/${m[2]}`)
            const doc = await page.text()
            let queries = scanTrackPairs(doc)
              // the first pair is the playlist/album entity itself: "Name Spotify"
              .filter((q) => !q.endsWith(' Spotify'))
              .filter((q) => q.length > 3 && q.length < 150)
            if (queries.length === 0) {
              // single-track embed: entity "name" then the artist's "name"
              const names = [...doc.matchAll(/"name":"((?:[^"\\]|\\.)*)"/g)]
                .map((x) => { try { return JSON.parse(`"${x[1]}"`) as string } catch { return '' } })
                .filter(Boolean)
              if (names.length >= 2) queries = [`${names[0]} ${names[1]}`]
              else if (names.length === 1) queries = [names[0]]
            }
            queries = [...new Set(queries)].slice(0, 8)
            if (queries.length === 0) {
              res.statusCode = 500
              res.end('No tracks found at that Spotify link.')
              return
            }
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(queries))
          } catch (e) {
            res.statusCode = 500
            res.end(`Spotify page fetch failed: ${e instanceof Error ? e.message : e}`)
          }
        })()
      })

      server.middlewares.use('/api/yt', (req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost').searchParams.get('url') ?? ''
        if (!FETCHABLE(url)) {
          res.statusCode = 400
          res.end('Not a YouTube URL')
          return
        }
        const dir = join(tmpdir(), 'exotica-yt')
        mkdirSync(dir, { recursive: true })
        const proc = spawn('yt-dlp', [
          '-f', 'bestaudio',
          '--no-playlist',
          '--match-filter', 'duration<=1200',
          '--no-simulate',
          '--print', '%(title)s',
          '--print', 'after_move:filepath',
          '-o', join(dir, '%(id)s.%(ext)s'),
          '--force-overwrites',
          url,
        ])
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (d) => (stdout += d))
        proc.stderr.on('data', (d) => (stderr += d))
        const timeout = setTimeout(() => proc.kill(), 120_000)
        proc.on('error', () => {
          clearTimeout(timeout)
          res.statusCode = 500
          res.end('yt-dlp failed to start — is it installed?')
        })
        proc.on('close', (code) => {
          clearTimeout(timeout)
          const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
          const filepath = lines[lines.length - 1]
          const title = lines.slice(0, -1).join(' ') || 'YouTube audio'
          if (code !== 0 || !filepath || !/[\\/]/.test(filepath)) {
            res.statusCode = 500
            res.end(
              lines.length < 2
                ? 'Video was skipped — longer than 20 minutes, or unavailable.'
                : `yt-dlp exited ${code}: ${stderr.slice(-400)}`,
            )
            return
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/octet-stream')
          res.setHeader('X-Title', encodeURIComponent(title))
          const stream = createReadStream(filepath)
          stream.pipe(res)
          stream.on('close', () => rmSync(filepath, { force: true }))
          stream.on('error', () => {
            res.statusCode = 500
            res.end('Could not read downloaded file')
          })
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ytFetchPlugin()],
})
