import { invoke } from '@tauri-apps/api/core'

/**
 * YouTube transport abstraction: in the browser the Vite dev middleware
 * handles /api/yt; inside the Tauri desktop app the Rust backend shells out
 * to yt-dlp directly. Same behavior either way.
 */

export const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export async function ytAvailableCheck(): Promise<boolean> {
  if (isTauri()) {
    try {
      await invoke<string>('yt_check')
      return true
    } catch {
      return false
    }
  }
  try {
    return (await fetch('/api/yt-check')).ok
  } catch {
    return false
  }
}

/** Expand a YouTube playlist/mix URL into its first entries' watch URLs. */
export async function ytExpand(url: string): Promise<string[]> {
  if (isTauri()) return invoke<string[]>('yt_expand', { url })
  const res = await fetch(`/api/yt-expand?url=${encodeURIComponent(url)}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

/**
 * Spotify link → "song artist" search queries (no direct audio: DRM).
 * Feed each as `ytsearch1:<query>` into ytFetchAudio.
 */
export async function spotifyQueries(url: string): Promise<string[]> {
  if (isTauri()) return invoke<string[]>('spotify_queries', { url })
  const res = await fetch(`/api/spotify?url=${encodeURIComponent(url)}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function ytFetchAudio(url: string): Promise<{ title: string; data: ArrayBuffer }> {
  if (isTauri()) {
    const r = await invoke<{ title: string; b64: string }>('yt_fetch', { url })
    const bin = atob(r.b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { title: r.title, data: bytes.buffer }
  }
  const res = await fetch(`/api/yt?url=${encodeURIComponent(url)}`)
  if (!res.ok) throw new Error(await res.text())
  const title = decodeURIComponent(res.headers.get('X-Title') ?? 'YouTube audio')
  return { title, data: await res.arrayBuffer() }
}
