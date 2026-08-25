import type { AudioEngine } from './AudioEngine'

/**
 * Crate persistence: the whole source pool (raw audio + edited boundaries)
 * saved to IndexedDB so curated material survives page reloads. Params travel
 * in the URL hash; crates carry the heavy audio the URL can't.
 */

const DB = 'exotica-decollage'
const STORE = 'crates'

interface StoredSource {
  name: string
  stemKey: string | null
  sampleRate: number
  channels: ArrayBuffer[]
  bounds: number[]
  manual: boolean
}

interface Crate {
  savedAt: number
  sources: StoredSource[]
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        t.oncomplete = () => db.close()
      }),
  )
}

export async function saveCrate(name: string, engine: AudioEngine): Promise<void> {
  const crate: Crate = {
    savedAt: Date.now(),
    sources: engine.sources.map((s) => ({
      name: s.name,
      stemKey: s.stemKey,
      sampleRate: s.buffer.sampleRate,
      channels: Array.from({ length: s.buffer.numberOfChannels }, (_, ch) => {
        const data = s.buffer.getChannelData(ch)
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      }),
      bounds: [...s.bounds],
      manual: s.manual,
    })),
  }
  await tx('readwrite', (store) => store.put(crate, name))
}

export async function loadCrate(name: string, engine: AudioEngine): Promise<number> {
  const crate = await tx<Crate | undefined>('readonly', (store) => store.get(name))
  if (!crate || !engine.ctx) return 0
  engine.clearSources()
  for (const s of crate.sources) {
    const first = new Float32Array(s.channels[0])
    const buf = engine.ctx.createBuffer(s.channels.length, first.length, s.sampleRate)
    s.channels.forEach((ch, i) => buf.getChannelData(i).set(new Float32Array(ch)))
    engine.restoreSource(s.name, buf, s.stemKey, s.bounds, s.manual)
  }
  return crate.sources.length
}

export async function listCrates(): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>('readonly', (store) => store.getAllKeys())
  return keys.map(String).sort()
}

export async function deleteCrate(name: string): Promise<void> {
  await tx('readwrite', (store) => store.delete(name))
}

// ---------- portable .crate files ----------
// binary layout: [u32 header length][JSON header][concatenated Float32 channel data]

interface FileHeader {
  version: 1
  sources: Array<Omit<StoredSource, 'channels'> & { channelCount: number; length: number }>
}

export function exportCrateFile(engine: AudioEngine): Blob {
  const header: FileHeader = {
    version: 1,
    sources: engine.sources.map((s) => ({
      name: s.name,
      stemKey: s.stemKey,
      sampleRate: s.buffer.sampleRate,
      channelCount: s.buffer.numberOfChannels,
      length: s.buffer.length,
      bounds: [...s.bounds],
      manual: s.manual,
    })),
  }
  // pad the JSON to 4-byte alignment so Float32Array views land aligned
  let json = JSON.stringify(header)
  while ((4 + new TextEncoder().encode(json).length) % 4 !== 0) json += ' '
  const headerBytes = new TextEncoder().encode(json)
  const lenBuf = new ArrayBuffer(4)
  new DataView(lenBuf).setUint32(0, headerBytes.length, true)
  const parts: BlobPart[] = [lenBuf, headerBytes]
  for (const s of engine.sources) {
    for (let ch = 0; ch < s.buffer.numberOfChannels; ch++) {
      const d = s.buffer.getChannelData(ch)
      parts.push(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))
    }
  }
  return new Blob(parts, { type: 'application/octet-stream' })
}

export async function importCrateFile(file: File, engine: AudioEngine): Promise<number> {
  if (!engine.ctx) return 0
  const data = await file.arrayBuffer()
  const headerLen = new DataView(data).getUint32(0, true)
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(data, 4, headerLen)),
  ) as FileHeader
  engine.clearSources()
  let off = 4 + headerLen
  for (const s of header.sources) {
    const buf = engine.ctx.createBuffer(s.channelCount, s.length, s.sampleRate)
    for (let ch = 0; ch < s.channelCount; ch++) {
      buf.getChannelData(ch).set(new Float32Array(data, off, s.length))
      off += s.length * 4
    }
    engine.restoreSource(s.name, buf, s.stemKey, s.bounds, s.manual)
  }
  return header.sources.length
}
