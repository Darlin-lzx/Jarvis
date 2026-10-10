export function parseOptions(raw: unknown): unknown[] {
  const out: unknown[] = []
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collect)
      return
    }
    if (typeof value === 'string') {
      const text = value.trim()
      if (text && !/\{\{.*}}/.test(text)) out.push(text)
      return
    }
    if (value != null) out.push(value)
  }

  if (Array.isArray(raw)) {
    collect(raw)
  } else if (typeof raw === 'string' && raw.trim()) {
    const text = raw.trim()
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) collect(parsed)
      } catch {
        // An invalid JSON literal has no selectable options.
      }
    } else {
      collect(text.split(/[、,，]/))
    }
  }
  return out
}
