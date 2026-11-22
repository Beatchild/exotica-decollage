/**
 * MIDI CONTROL — any class-compliant controller (Web MIDI). MIDI LEARN: pick a
 * target, move a knob / fader / pad, done. Mappings persist. Components
 * subscribe to the targets they own (COMPOSE knobs, WEAVE…); MIX & MASTER
 * handles its own.
 */

export type MidiTarget =
  | 'darkness' | 'space' | 'motion'
  | 'mix.voices' | 'mix.clouds' | 'mix.melody' | 'mix.ghosts' | 'mix.loop' | 'mix.surface'
  | 'layer.stretch' | 'layer.motif' | 'layer.ghosts' | 'layer.loop'
  | 'master.toggle' | 'transport.toggle' | 'weave'

export const MIDI_TARGETS: Array<{ key: MidiTarget; label: string; kind: 'knob' | 'button' }> = [
  { key: 'darkness', label: 'DARKNESS', kind: 'knob' },
  { key: 'space', label: 'SPACE', kind: 'knob' },
  { key: 'motion', label: 'MOTION', kind: 'knob' },
  { key: 'mix.voices', label: 'MIX · VOICES', kind: 'knob' },
  { key: 'mix.clouds', label: 'MIX · CLOUDS', kind: 'knob' },
  { key: 'mix.melody', label: 'MIX · MELODY', kind: 'knob' },
  { key: 'mix.ghosts', label: 'MIX · GHOSTS', kind: 'knob' },
  { key: 'mix.loop', label: 'MIX · LOOP', kind: 'knob' },
  { key: 'mix.surface', label: 'MIX · SURFACE', kind: 'knob' },
  { key: 'layer.stretch', label: 'STRETCH', kind: 'knob' },
  { key: 'layer.motif', label: 'RETURNING MELODY', kind: 'knob' },
  { key: 'layer.ghosts', label: 'GHOST VOICES', kind: 'knob' },
  { key: 'layer.loop', label: 'DISINTEGRATING TAPE', kind: 'knob' },
  { key: 'master.toggle', label: 'MASTER ON / OFF', kind: 'button' },
  { key: 'transport.toggle', label: 'PLAY / PAUSE', kind: 'button' },
  { key: 'weave', label: 'WEAVE A MEMORY', kind: 'button' },
]

/** a control on the device: CC or note, on a channel */
export interface MidiBinding { type: 'cc' | 'note'; ch: number; num: number }

const KEY = 'exotica.midi.v1'

type Listener = (target: MidiTarget, value: number) => void
type StatusListener = () => void

class MidiHub {
  bindings: Partial<Record<MidiTarget, MidiBinding>> = {}
  learning: MidiTarget | null = null
  status: 'off' | 'connecting' | 'ready' | 'unsupported' | 'denied' = 'off'
  inputs: string[] = []
  /** last raw message, for the panel */
  last = ''
  private listeners = new Set<Listener>()
  private statusListeners = new Set<StatusListener>()
  private access: MIDIAccess | null = null
  /** buttons fire on press only */
  private held = new Set<string>()

  constructor() {
    try {
      this.bindings = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<MidiTarget, MidiBinding>>
    } catch { /* storage */ }
  }

  on(fn: Listener) {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  onStatus(fn: StatusListener) {
    this.statusListeners.add(fn)
    return () => { this.statusListeners.delete(fn) }
  }

  private changed() {
    for (const fn of this.statusListeners) fn()
  }

  private save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.bindings)) } catch { /* storage */ }
  }

  async connect() {
    if (this.access) return
    if (!('requestMIDIAccess' in navigator)) {
      this.status = 'unsupported'
      this.changed()
      return
    }
    this.status = 'connecting'
    this.changed()
    try {
      this.access = await navigator.requestMIDIAccess()
      const wire = () => {
        this.inputs = []
        this.access!.inputs.forEach((inp) => {
          this.inputs.push(inp.name ?? 'MIDI input')
          inp.onmidimessage = (e) => this.handle(e.data)
        })
        this.changed()
      }
      this.access.onstatechange = wire
      wire()
      this.status = 'ready'
    } catch {
      this.status = 'denied'
    }
    this.changed()
  }

  learn(t: MidiTarget | null) {
    this.learning = t
    this.changed()
  }

  unbind(t: MidiTarget) {
    delete this.bindings[t]
    this.save()
    this.changed()
  }

  private handle(data: Uint8Array | null) {
    if (!data || data.length < 3) return
    const st = data[0] & 0xf0
    const ch = data[0] & 0x0f
    const num = data[1]
    const val = data[2]
    let type: MidiBinding['type'] | null = null
    let v = 0
    if (st === 0xb0) { type = 'cc'; v = val / 127 }
    else if (st === 0x90) { type = 'note'; v = val > 0 ? 1 : 0 }
    else if (st === 0x80) { type = 'note'; v = 0 }
    if (!type) return
    this.last = `${type.toUpperCase()} ${num} · CH ${ch + 1} · ${val}`
    if (this.learning) {
      // one control drives one target
      for (const k of Object.keys(this.bindings) as MidiTarget[]) {
        const b = this.bindings[k]
        if (b && b.type === type && b.ch === ch && b.num === num) delete this.bindings[k]
      }
      this.bindings[this.learning] = { type, ch, num }
      this.learning = null
      this.save()
      this.changed()
      return
    }
    for (const t of MIDI_TARGETS) {
      const b = this.bindings[t.key]
      if (!b || b.type !== type || b.ch !== ch || b.num !== num) continue
      if (t.kind === 'button') {
        const id = `${type}:${ch}:${num}`
        const down = v > 0.5
        if (down && !this.held.has(id)) {
          this.held.add(id)
          for (const fn of this.listeners) fn(t.key, 1)
        } else if (!down) this.held.delete(id)
      } else {
        for (const fn of this.listeners) fn(t.key, v)
      }
    }
    this.changed()
  }
}

export const midi = new MidiHub()

/** fader position (0–1) → linear gain: bottom = off, top = +6 dB, 0 dB at ~80% */
export const faderToGain = (v: number) => (v < 0.01 ? 0 : Math.pow(10, (-48 + v * 54) / 20))
