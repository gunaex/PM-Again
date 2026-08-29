import { useRef, useState } from 'react'
import { importItems, exportUrl, importTemplateUrl } from '../api/client'

function importErrorMessage(detail) {
  if (!detail) return 'Import failed'
  if (typeof detail === 'string') return detail

  const lines = []
  if (detail.message) lines.push(detail.message)
  if (detail.missing_columns?.length) lines.push(`Missing columns: ${detail.missing_columns.join(', ')}`)
  if (detail.unexpected_columns?.length) lines.push(`Unexpected columns: ${detail.unexpected_columns.join(', ')}`)
  if (detail.errors?.length) {
    const examples = detail.errors.slice(0, 3).map((item) => {
      const location = [item.row && `row ${item.row}`, item.column].filter(Boolean).join(', ')
      return `${location || 'Data'}: ${item.problem || item.message || 'invalid value'}`
    })
    lines.push(...examples)
    if (detail.errors.length > examples.length) lines.push(`and ${detail.errors.length - examples.length} more error(s)`)
  }
  return lines.join(' — ') || 'Import failed'
}

export default function ImportExportBar({ slug, entity, onImported }) {
  const fileRef = useRef(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await importItems(slug, entity, file)
      onImported?.()
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(importErrorMessage(detail))
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  return (
    <div className="flex items-center gap-2">
      <a
        href={importTemplateUrl(slug, entity)}
        className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
      >
        Download Template
      </a>
      <a
        href={exportUrl(slug, entity)}
        className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
      >
        Export
      </a>
      <button
        type="button"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
      >
        {busy ? 'Importing…' : 'Import'}
      </button>
      <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={handleFile} />
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  )
}
