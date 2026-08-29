import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  clearActualOverride,
  getProgressMatrix,
  getProgressMatrixCalendar,
  getProgressMatrixLegend,
  setActualOverride,
  setPlanDates,
} from '../api/client'
import { useAuth } from '../auth/AuthContext.jsx'
import ImportExportBar from '../components/ImportExportBar.jsx'

// 予定実績表 — one row per item, one column per day, symbols in the cells.
// Not a bar chart: the Gantt view already does that, and this exists to be
// read the way the Toyota-style paper sheet is.

const ENTITY_FILTERS = [
  { key: 'task', label: 'Task' },
  { key: 'function', label: 'Function' },
  { key: 'issue', label: 'Issue' },
  { key: 'incident', label: 'Incident' },
  { key: 'backlog', label: 'Backlog' },
]
const PHASES = ['UR', 'DR', 'DN', 'PU', 'ST', 'UT', 'TR', 'IP', 'MA']

const HEALTH_STYLES = {
  overdue: { row: 'bg-red-50', dot: 'bg-red-500', label: 'Overdue' },
  not_started_late: { row: 'bg-amber-50', dot: 'bg-amber-500', label: 'Late to start' },
  late: { row: 'bg-yellow-50', dot: 'bg-yellow-500', label: 'Late' },
  unplanned: { row: 'bg-gray-50', dot: 'bg-gray-400', label: 'No plan dates' },
  on_track: { row: '', dot: 'bg-green-500', label: 'On track' },
}

// Plan markers read blue, actual markers read green, mixed cells read purple —
// so a row can be scanned without decoding every symbol.
function cellStyle(symbol) {
  const hasPlan = /PS|PR/.test(symbol)
  const hasActual = /RS|R/.test(symbol.replace(/P[SR]/g, ''))
  if (hasPlan && hasActual) return 'bg-purple-100 text-purple-800'
  if (hasPlan) return 'bg-blue-100 text-blue-800'
  return 'bg-green-100 text-green-800'
}

function monthRange(offset = 0) {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0)
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: iso(start), to: iso(end) }
}

// Groups consecutive days by month so the header can span them — a matrix
// crossing a month boundary otherwise shows "29 30 1 2" with no clue where
// the break is.
function monthSpans(days) {
  const spans = []
  for (const d of days) {
    const last = spans[spans.length - 1]
    if (last && last.month === d.month) last.count += 1
    else spans.push({ month: d.month, count: 1 })
  }
  return spans
}

export default function ProgressMatrix() {
  const { slug } = useParams()
  const { user } = useAuth()
  const canWrite = user?.role !== 'client_viewer'
  const [monthOffset, setMonthOffset] = useState(0)
  const [range, setRange] = useState(() => monthRange(0))
  const [entityTypes, setEntityTypes] = useState(['task', 'function', 'issue', 'incident', 'backlog'])
  const [phase, setPhase] = useState('')
  const [owner, setOwner] = useState('')
  const [data, setData] = useState(null)
  const [legend, setLegend] = useState(null)
  const [calendar, setCalendar] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expandedRow, setExpandedRow] = useState(null)
  const [planEditor, setPlanEditor] = useState(null) // the row whose dates are being set

  useEffect(() => setRange(monthRange(monthOffset)), [monthOffset])
  useEffect(() => {
    getProgressMatrixLegend(slug).then(setLegend).catch(() => setLegend(null))
  }, [slug])

  // Weekend/holiday shading comes from the backend's business-day engine, so
  // the greyed-out days are exactly the ones that don't count towards a delay.
  useEffect(() => {
    getProgressMatrixCalendar(slug, range.from, range.to)
      .then(setCalendar)
      .catch(() => setCalendar(null))
  }, [slug, range.from, range.to])

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    getProgressMatrix(slug, { entityTypes, phase, owner, from: range.from, to: range.to })
      .then(setData)
      .catch(() => setError('Could not load the progress matrix — the backend may be unreachable.'))
      .finally(() => setLoading(false))
  }, [slug, entityTypes, phase, owner, range.from, range.to])

  useEffect(load, [load])

  const days = useMemo(() => calendar?.days || [], [calendar])
  const today = calendar?.today
  const spans = useMemo(() => monthSpans(days), [days])
  const rows = useMemo(() => data?.rows || [], [data])
  const owners = useMemo(() => [...new Set(rows.map((r) => r.owner).filter(Boolean))], [rows])

  const savePlanDates = async (row, planStart, planEnd) => {
    await setPlanDates(slug, {
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      baseline_start: planStart || null,
      baseline_end: planEnd || null,
    })
    setPlanEditor(null)
    load()
  }

  const saveActualOverride = async (row, actualStart, actualEnd, reason) => {
    await setActualOverride(slug, {
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      actual_start_override: actualStart || null,
      actual_end_override: actualEnd || null,
      reason: reason || null,
      created_by: localStorage.getItem('pm-again:my-name') || null,
    })
    setPlanEditor(null)
    load()
  }

  const removeActualOverride = async (row) => {
    await clearActualOverride(slug, row.entity_type, row.entity_id)
    setPlanEditor(null)
    load()
  }

  const toggleEntityType = (key) =>
    setEntityTypes((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    )

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Progress Matrix</h2>
          <p className="text-xs text-gray-500">
            予定実績表 — planned vs actual, derived from baselines and status history.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMonthOffset((m) => m - 1)}
            className="px-2 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
          >
            ←
          </button>
          <span className="text-sm text-gray-700 min-w-[9rem] text-center">
            {range.from} → {range.to}
          </span>
          <button
            onClick={() => setMonthOffset((m) => m + 1)}
            className="px-2 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
          >
            →
          </button>
          {monthOffset !== 0 && (
            <button onClick={() => setMonthOffset(0)} className="text-sm text-indigo-600 hover:underline">
              This month
            </button>
          )}
        </div>
      </div>

      {/* Date maintenance belongs to the schedule import, not the Function
          List import: this sheet carries both plan dates and auditable manual
          actual overrides for every Matrix entity (including Functions). */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 rounded-lg border border-gray-200 bg-white px-3 py-2">
        <div>
          <div className="text-sm font-medium text-gray-800">Progress Matrix dates</div>
          <div className="text-xs text-gray-500">
            Bulk plan dates and manual actual overrides; derived actuals remain read-only in the export.
          </div>
        </div>
        <ImportExportBar slug={slug} entity="schedule" onImported={load} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex flex-wrap gap-1">
          {ENTITY_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => toggleEntityType(f.key)}
              className={`px-2.5 py-1 text-sm rounded-full border ${
                entityTypes.includes(f.key)
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          value={phase}
          onChange={(e) => setPhase(e.target.value)}
          className="text-sm border border-gray-300 rounded-md px-2 py-1.5"
        >
          <option value="">All Phases</option>
          {PHASES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          className="text-sm border border-gray-300 rounded-md px-2 py-1.5"
        >
          <option value="">All Owners</option>
          {owners.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>

      {/* Summary */}
      {data?.summary && (
        <div className="flex flex-wrap gap-3 mb-4 text-sm">
          <Stat label="Items" value={data.summary.total} />
          {Object.entries(data.summary.by_health || {}).map(([health, count]) => (
            <Stat
              key={health}
              label={HEALTH_STYLES[health]?.label || health}
              value={count}
              dot={HEALTH_STYLES[health]?.dot}
            />
          ))}
          {data.summary.worst_end_delay_days != null && (
            <Stat label="Worst delay" value={`${data.summary.worst_end_delay_days} bd`} />
          )}
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 mb-3">
          {error}{' '}
          <button onClick={load} className="underline font-medium">
            Retry
          </button>
        </p>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState slug={slug} entityTypes={entityTypes} phase={phase} owner={owner} />
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg table-scroll">
          <table className="text-sm border-collapse">
            <thead>
              {/* Month band — makes a range that crosses a month boundary
                  readable instead of "…29 30 1 2…" with no marker. */}
              <tr className="bg-gray-100 text-gray-600">
                <th className="sticky left-0 z-10 bg-gray-100 px-3 py-1 text-left min-w-[14rem] sm:min-w-[16rem] border-r border-gray-200" />
                {spans.map((s) => (
                  <th
                    key={s.month}
                    colSpan={s.count}
                    className="px-1 py-1 text-xs font-semibold text-left border-l border-gray-200 whitespace-nowrap"
                  >
                    {s.month}
                  </th>
                ))}
              </tr>
              <tr className="bg-gray-50 text-gray-600">
                <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left min-w-[14rem] sm:min-w-[16rem] border-r border-gray-200">
                  Item
                </th>
                {days.map((d) => (
                  <th
                    key={d.date}
                    title={d.holiday_name || undefined}
                    className={`px-0 py-1 w-8 text-center text-xs font-medium ${
                      d.date === today ? 'bg-indigo-100 text-indigo-800 ring-1 ring-indigo-400' : ''
                    } ${!d.is_business_day && d.date !== today ? 'bg-gray-100 text-gray-400' : ''}`}
                  >
                    <div>{d.day}</div>
                    <div className={`text-[9px] font-normal ${d.is_holiday ? 'text-rose-500' : 'text-gray-400'}`}>
                      {d.is_holiday ? '•' : d.weekday}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const style = HEALTH_STYLES[row.health] || {}
                const key = `${row.entity_type}-${row.entity_id}`
                const hasAnalysis = row.cross_check.length > 0 || row.recovery.length > 0 || row.forecast
                return (
                  <RowGroup
                    key={key}
                    row={row}
                    days={days}
                    today={today}
                    style={style}
                    expanded={expandedRow === key}
                    hasAnalysis={hasAnalysis}
                    onToggle={() => setExpandedRow((cur) => (cur === key ? null : key))}
                    columnCount={days.length + 1}
                    canWrite={canWrite}
                    onEditPlan={() => setPlanEditor(row)}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {planEditor && (
        <DatesModal
          row={planEditor}
          onClose={() => setPlanEditor(null)}
          onSavePlan={(start, end) => savePlanDates(planEditor, start, end)}
          onSaveActual={(start, end, reason) => saveActualOverride(planEditor, start, end, reason)}
          onClearActual={() => removeActualOverride(planEditor)}
        />
      )}

      {/* Legend — always visible, never hidden behind a toggle */}
      {legend && (
        <div className="mt-4 bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Legend</h3>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {legend.symbols.map((s) => (
              <div key={s.symbol} className="flex items-center gap-2 text-sm">
                <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${cellStyle(s.symbol)}`}>
                  {s.symbol}
                </span>
                <span className="text-gray-600">{s.meaning}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3 pt-3 border-t border-gray-100">
            {Object.entries(HEALTH_STYLES).map(([health, s]) => (
              <div key={health} className="flex items-center gap-2 text-sm">
                <span className={`w-2.5 h-2.5 rounded-full ${s.dot}`} />
                <span className="text-gray-600">{s.label}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 text-sm">
              <span className="w-2.5 h-2.5 rounded-sm bg-indigo-100 ring-1 ring-indigo-400" />
              <span className="text-gray-600">Today</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="w-2.5 h-2.5 rounded-sm bg-gray-200" />
              <span className="text-gray-600">Weekend / Thai public holiday (not counted in delays)</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="px-1 rounded text-[10px] font-semibold leading-4 bg-green-100 text-green-800 border border-dashed border-gray-600">
                R
              </span>
              <span className="text-gray-600">
                Dashed border = actual date entered by hand (not derived from the activity log)
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800 border border-amber-300">
                ⚠ entered ≠ logged
              </span>
              <span className="text-gray-600">A hand-entered date disagrees with the log</span>
            </div>
          </div>
          {/* Says where each half of the data comes from, so nobody hunts for
              a field to type RS/R into. */}
          <p className="text-xs text-gray-500 mt-3 pt-3 border-t border-gray-100 reading-col">
            <span className="font-medium text-gray-700">PS / PR</span> are plan dates — you set them, by
            clicking an item's name here or from its detail panel.{' '}
            <span className="font-medium text-gray-700">RS / R</span> are actuals — normally derived on their
            own from status changes in the activity log. Where there is no history to derive from (migrated
            work, a status changed on the wrong day) you can enter them by hand; the logged value is kept
            underneath and the marker is drawn with a dashed border so the two are never confused.
          </p>
        </div>
      )}
    </div>
  )
}

// An empty matrix used to say "Items 0" and nothing else, which reads as a
// broken page. It is almost always one of two situations, and both have a
// next action.
function EmptyState({ slug, entityTypes, phase, owner }) {
  const filtered = phase || owner || entityTypes.length < 5
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 reading-col">
      <h3 className="text-sm font-semibold text-gray-800 mb-2">Nothing to show yet</h3>
      <p className="text-sm text-gray-600 mb-3">
        {filtered
          ? 'No items match the current filters. Widen the entity type, phase or owner filter, or move to a different month.'
          : 'This project has no Tasks, Functions or Board items yet — the matrix has nothing to plot.'}
      </p>
      <div className="text-sm text-gray-600 space-y-2">
        <p>
          <span className="font-medium text-gray-800">Plan dates (PS / PR)</span> are set here — click an item's
          name in the left column to set them. They can also be set from a Function or Board Item's detail
          panel, or from the Gantt chart for Tasks.
        </p>
        <p>
          <span className="font-medium text-gray-800">Actual dates (RS / R)</span> are never typed in. They are
          derived automatically from status changes recorded in the activity log — an item becomes RS when it
          moves to In Progress and R when it is completed.
        </p>
      </div>
      <div className="flex flex-wrap gap-3 mt-4">
        <Link to={`/${slug}/functions`} className="text-sm text-indigo-600 hover:underline">
          Go to Functions →
        </Link>
        <Link to={`/${slug}/tasks`} className="text-sm text-indigo-600 hover:underline">
          Go to Tasks →
        </Link>
        <Link to={`/${slug}/board`} className="text-sm text-indigo-600 hover:underline">
          Go to Board →
        </Link>
      </div>
    </div>
  )
}

// Plan and Actual in one place, but visibly two different things: plan dates
// are simply set, actual dates show what the log derived first and only then
// offer a manual override.
function DatesModal({ row, onClose, onSavePlan, onSaveActual, onClearActual }) {
  const [planStart, setPlanStart] = useState(row.plan_start || '')
  const [planEnd, setPlanEnd] = useState(row.plan_end || '')
  const [actualStart, setActualStart] = useState(row.actual_start_override || '')
  const [actualEnd, setActualEnd] = useState(row.actual_end_override || '')
  const [reason, setReason] = useState(row.override_reason || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const run = async (fn, fallback) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err?.response?.data?.detail || fallback)
      setBusy(false)
    }
  }

  const submitPlan = () => {
    if (!planStart && !planEnd) return setError('Set at least one plan date.')
    if (planStart && planEnd && planEnd < planStart) return setError('Plan end cannot be before plan start.')
    return run(() => onSavePlan(planStart, planEnd), 'Could not save the plan dates.')
  }

  const submitActual = () => {
    if (!actualStart && !actualEnd) {
      return setError('Set at least one actual date, or use Clear override to fall back to the log.')
    }
    if (actualStart && actualEnd && actualEnd < actualStart) {
      return setError('Actual end cannot be before actual start.')
    }
    return run(() => onSaveActual(actualStart, actualEnd, reason), 'Could not save the actual dates.')
  }

  const derived = (value) => value || '— nothing logged'

  return (
    <div className="fixed inset-0 bg-black/30 flex items-start justify-center z-50 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-lg p-6 w-full max-w-md my-8" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-gray-900 mb-1">Dates</h3>
        <p className="text-xs text-gray-500 mb-4">
          {row.entity_code ? `${row.entity_code} · ` : ''}
          {row.entity_title}
        </p>
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        {/* ---- plan ---- */}
        <div className="border border-gray-100 rounded-lg p-3 mb-4">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Plan dates (PS / PR)</div>
          <div className="flex gap-3 mb-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Plan Start (PS)</label>
              <input
                type="date"
                value={planStart}
                onChange={(e) => setPlanStart(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Plan End (PR)</label>
              <input
                type="date"
                value={planEnd}
                onChange={(e) => setPlanEnd(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-sm"
              />
            </div>
          </div>
          <button
            onClick={submitPlan}
            disabled={busy}
            className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            Save plan dates
          </button>
        </div>

        {/* ---- actual ---- */}
        <div className="border border-gray-100 rounded-lg p-3 mb-4">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Actual dates (RS / R)</div>

          {/* What the log says — read-only, and shown first, because this is
              the figure that can be defended. */}
          <div className="bg-gray-50 rounded px-3 py-2 mb-3">
            <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">From activity log</div>
            <div className="text-sm text-gray-500">
              Start: <span className="font-medium">{derived(row.actual_start_derived)}</span>
            </div>
            <div className="text-sm text-gray-500">
              End: <span className="font-medium">{derived(row.actual_end_derived)}</span>
            </div>
          </div>

          <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Manual override</div>
          <div className="flex gap-3 mb-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Actual Start (RS)</label>
              <input
                type="date"
                value={actualStart}
                onChange={(e) => setActualStart(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Actual End (R)</label>
              <input
                type="date"
                value={actualEnd}
                onChange={(e) => setActualEnd(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-sm"
              />
            </div>
          </div>
          <label className="block text-xs text-gray-500 mb-1">Reason</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. migrated from the old system — no log history"
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-2"
          />

          {/* Overwriting a date the log actually recorded is the one case
              worth stopping to think about, so it says so before you save. */}
          {(row.actual_start_derived || row.actual_end_derived) && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">
              This item already has dates from the activity log ({derived(row.actual_start_derived)} →{' '}
              {derived(row.actual_end_derived)}). An override replaces them in the chart and in every delay
              calculation — the logged dates are kept and stay visible above.
            </p>
          )}

          <div className="flex gap-2">
            <button
              onClick={submitActual}
              disabled={busy}
              className="px-3 py-1.5 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:opacity-50"
            >
              Save override
            </button>
            {row.has_override && (
              <button
                onClick={() => run(onClearActual, 'Could not clear the override.')}
                disabled={busy}
                className="px-3 py-1.5 text-sm text-red-600 border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-50"
              >
                Clear override
              </button>
            )}
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-full px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-md hover:bg-gray-50"
        >
          Close
        </button>
      </div>
    </div>
  )
}

function Stat({ label, value, dot }) {
  return (
    <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-1.5">
      {dot && <span className={`w-2 h-2 rounded-full ${dot}`} />}
      <span className="text-gray-500">{label}</span>
      <span className="font-semibold text-gray-900">{value}</span>
    </div>
  )
}

function RowGroup({ row, days, today, style, expanded, hasAnalysis, onToggle, columnCount, canWrite, onEditPlan }) {
  const symbols = row.symbols || {}
  return (
    <>
      <tr className={`border-t border-gray-100 ${style.row || ''}`}>
        <th
          className={`sticky left-0 z-10 px-3 py-1.5 text-left font-normal border-r border-gray-200 ${
            style.row || 'bg-white'
          }`}
        >
          <div className="flex items-start gap-2">
            <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${style.dot || 'bg-gray-300'}`} />
            <div className="min-w-0">
              {/* The item name is the affordance for setting plan dates —
                  that's what people try to click first. */}
              {canWrite ? (
                <button
                  onClick={onEditPlan}
                  title="Set plan dates for this item"
                  className="text-gray-900 truncate text-left hover:text-indigo-700 hover:underline"
                >
                  {row.entity_code && <span className="text-gray-500 mr-1">{row.entity_code}</span>}
                  {row.entity_title}
                </button>
              ) : (
                <div className="text-gray-900 truncate">
                  {row.entity_code && <span className="text-gray-500 mr-1">{row.entity_code}</span>}
                  {row.entity_title}
                </div>
              )}
              {/* Quiet, but impossible to miss if you're looking at the row —
                  the hover spells out both values. */}
              {row.has_conflict && (
                <span
                  title={(row.conflict_fields || [])
                    .map((f) => `${f}: log ${row[`${f}_derived`]} vs entered ${row[`${f}_override`]}`)
                    .join(' · ')}
                  className="inline-block mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800 border border-amber-300"
                >
                  ⚠ entered ≠ logged
                </span>
              )}
              <div className="text-xs text-gray-400">
                {row.item_type || row.entity_type}
                {row.phase && <> · {row.phase}</>}
                {row.owner && <> · {row.owner}</>}
                {canWrite && (
                  <button onClick={onEditPlan} className="ml-2 text-indigo-600 hover:underline">
                    {row.plan_start || row.plan_end ? 'Plan dates' : '+ Plan dates'}
                  </button>
                )}
                {hasAnalysis && (
                  <button onClick={onToggle} className="ml-2 text-indigo-600 hover:underline">
                    {expanded ? 'Hide analysis' : `Analysis (${row.cross_check.length + row.recovery.length})`}
                  </button>
                )}
              </div>
            </div>
          </div>
        </th>
        {days.map((d) => {
          const symbol = symbols[d.date]
          // Bonus (spec 5.3): the plan-start cell of something that should
          // have started and hasn't gets called out in place, using the same
          // "planned date has passed with nothing to show for it" rule the
          // Slippage Predictor works from.
          const missedStart = row.health === 'not_started_late' && d.date === row.plan_start
          const isToday = d.date === today
          // A marker sitting on a hand-entered date gets a dashed border, so
          // a typed-in actual is never read as one the log can prove.
          const isOverridden = (row.overridden_days || []).includes(d.date)
          return (
            <td
              key={d.date}
              className={`w-8 text-center align-middle px-0 py-1 ${
                isToday ? 'bg-indigo-50 border-x-2 border-indigo-400' : !d.is_business_day ? 'bg-gray-50/70' : ''
              }`}
            >
              {symbol && (
                <span
                  title={
                    [
                      `${d.date} — ${symbol}`,
                      missedStart && `should have started here (${row.start_delay_days} business days ago)`,
                      isOverridden && 'entered by hand, not derived from the activity log',
                      isOverridden && row.override_reason && `reason: ${row.override_reason}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  }
                  className={`inline-block px-1 rounded text-[10px] font-semibold leading-4 ${
                    missedStart ? 'bg-red-600 text-white ring-2 ring-red-300' : cellStyle(symbol)
                  } ${isOverridden ? 'border border-dashed border-gray-600' : ''}`}
                >
                  {symbol}
                </span>
              )}
            </td>
          )
        })}
      </tr>
      {expanded && (
        <tr className={style.row || 'bg-gray-50/50'}>
          <td colSpan={columnCount} className="px-4 py-3 border-t border-gray-100">
            <AnalysisPanel row={row} />
          </td>
        </tr>
      )}
    </>
  )
}

function AnalysisPanel({ row }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 max-w-4xl">
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Status &amp; Delay</h4>
        <ul className="text-sm text-gray-700 space-y-0.5">
          <li>Status: {row.status.replace('_', ' ')}</li>
          <li>
            Plan: {row.plan_start || '—'} → {row.plan_end || '—'}
          </li>
          <li>
            Actual: {row.actual_start || '—'} → {row.actual_end || '—'}
          </li>
          <li>
            Start delay: {row.start_delay_days == null ? 'n/a' : `${row.start_delay_days} business days`}
          </li>
          <li>End delay: {row.end_delay_days == null ? 'n/a' : `${row.end_delay_days} business days`}</li>
        </ul>
      </div>

      {row.forecast && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Forecast</h4>
          <p className="text-sm text-gray-700">
            Expected completion <span className="font-medium">{row.forecast.forecast_end}</span>
          </p>
          <p className="text-xs text-gray-500 mt-0.5">{row.forecast.basis}</p>
          <DataPoints points={row.forecast.data_points} />
        </div>
      )}

      {row.cross_check.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Cross-check</h4>
          <ul className="space-y-2">
            {row.cross_check.map((c) => (
              <li key={c.code} className="text-sm">
                <span className="text-amber-700">{c.message}</span>
                <DataPoints points={c.data_points} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {row.recovery.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Recovery</h4>
          <ul className="space-y-2">
            {row.recovery.map((r) => (
              <li key={r.code} className="text-sm">
                <span className="text-gray-800">{r.action}</span>
                <DataPoints points={r.data_points} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// Every statement above is shown with the rows of data it was computed from —
// so a suggestion can be checked rather than believed.
function DataPoints({ points }) {
  if (!points?.length) return null
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {points.map((p) => (
        <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-mono">
          {p}
        </span>
      ))}
    </div>
  )
}
