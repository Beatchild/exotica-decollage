/** Open/close a <Section> from outside (palette, nav tabs). */
export function setSectionOpen(id: string, open: boolean) {
  window.dispatchEvent(new CustomEvent('exotica:section', { detail: { id, open } }))
}
