const DAILY_RETENTION = 7
const MONTHLY_RETENTION = 2

export function cleanId(value) {
  if (value === undefined || value === null || value === '') return ''
  const text = String(value).trim()
  return text === 'undefined' || text === 'null' ? '' : text
}

export function cleanText(value, max = 60) {
  if (value === undefined || value === null || value === '') return ''
  const text = String(value).replace(/[\r\n]/g, ' ').trim()
  if (!text || text.toLowerCase() === 'undefined' || text.toLowerCase() === 'null') return ''
  return text.slice(0, max)
}

export function cleanCount(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

export function makeCounter() {
  return { triggered: 0, passed: 0, daily: {}, monthly: {} }
}

function normalizePeriods(value = {}) {
  const result = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, item] of Object.entries(value)) {
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(key)) continue
    result[key] = {
      triggered: cleanCount(item?.triggered),
      passed: cleanCount(item?.passed)
    }
  }
  return result
}

function prunePeriods(periods, keep) {
  const keys = Object.keys(periods).sort().reverse()
  for (const key of keys.slice(keep)) delete periods[key]
}

export function normalizeCounter(data = {}) {
  const daily = normalizePeriods(data.daily)
  const monthly = normalizePeriods(data.monthly)
  prunePeriods(daily, DAILY_RETENTION)
  prunePeriods(monthly, MONTHLY_RETENTION)
  return {
    triggered: cleanCount(data.triggered),
    passed: cleanCount(data.passed),
    daily,
    monthly
  }
}

export function cloneCounter(counter = {}) {
  return normalizeCounter(counter)
}

export function hasCounterData(counter = {}) {
  const value = normalizeCounter(counter)
  return value.triggered > 0 || value.passed > 0
}

export function mergeCounter(target = makeCounter(), source = {}) {
  const value = normalizeCounter(source)
  target.triggered = cleanCount(target.triggered) + value.triggered
  target.passed = cleanCount(target.passed) + value.passed

  for (const [key, item] of Object.entries(value.daily)) {
    const period = target.daily[key] ||= { triggered: 0, passed: 0 }
    period.triggered += item.triggered
    period.passed += item.passed
  }
  for (const [key, item] of Object.entries(value.monthly)) {
    const period = target.monthly[key] ||= { triggered: 0, passed: 0 }
    period.triggered += item.triggered
    period.passed += item.passed
  }
  prunePeriods(target.daily, DAILY_RETENTION)
  prunePeriods(target.monthly, MONTHLY_RETENTION)
  return target
}

export function incrementCounter(counter, field, day, month) {
  counter[field] = cleanCount(counter[field]) + 1
  const daily = counter.daily[day] ||= { triggered: 0, passed: 0 }
  daily[field] = cleanCount(daily[field]) + 1
  const monthly = counter.monthly[month] ||= { triggered: 0, passed: 0 }
  monthly[field] = cleanCount(monthly[field]) + 1
  prunePeriods(counter.daily, DAILY_RETENTION)
  prunePeriods(counter.monthly, MONTHLY_RETENTION)
  return counter
}

export function counterView(counter = {}, day, month) {
  const make = value => {
    const triggered = cleanCount(value?.triggered)
    const passed = cleanCount(value?.passed)
    return { triggered, passed, failed: Math.max(0, triggered - passed), total: triggered }
  }
  return {
    lifetime: make(counter),
    today: make(counter?.daily?.[day]),
    month: make(counter?.monthly?.[month])
  }
}

export function sumCounters(counters = []) {
  const result = makeCounter()
  for (const counter of counters) mergeCounter(result, counter)
  return result
}

export function sumViews(rows = []) {
  const result = {
    lifetime: { triggered: 0, passed: 0, failed: 0, total: 0 },
    today: { triggered: 0, passed: 0, failed: 0, total: 0 },
    month: { triggered: 0, passed: 0, failed: 0, total: 0 }
  }
  for (const row of rows) {
    const view = row.stats || row
    for (const period of ['lifetime', 'today', 'month']) {
      for (const field of ['triggered', 'passed', 'failed', 'total'])
        result[period][field] += cleanCount(view?.[period]?.[field])
    }
  }
  return result
}

export function aggregateAccountCounters(data, ltuids = []) {
  const result = makeCounter()
  const unique = [...new Set((ltuids || []).map(cleanId).filter(Boolean))]
  for (const ltuid of unique) mergeCounter(result, data?.accounts?.[ltuid])
  return { counter: result, ltuids: unique }
}

export function aggregateQQCounters(data, qq, ltuids = []) {
  const active = new Set((ltuids || []).map(cleanId).filter(Boolean))
  const counter = makeCounter()
  const community = makeCounter()
  for (const ltuid of active) {
    mergeCounter(counter, data?.accounts?.[ltuid])
    mergeCounter(community, data?.community?.[ltuid])
  }

  const snapshots = data?.detached?.[cleanId(qq)] || {}
  for (const [ltuid, snapshot] of Object.entries(snapshots)) {
    if (active.has(ltuid)) continue
    mergeCounter(counter, snapshot?.stats)
    mergeCounter(community, snapshot?.community)
  }

  const pending = data?.pending?.byQQ?.[cleanId(qq)]
  mergeCounter(counter, pending?.stats)
  mergeCounter(community, pending?.community)
  return { counter, community }
}

export function aggregateGroupCounters(data, memberQQs = [], qqToLtuids = {}) {
  const members = [...new Set((memberQQs || []).map(cleanId).filter(Boolean))]
  const activeLtuids = new Set()
  for (const qq of members) {
    for (const ltuid of qqToLtuids?.[qq] || []) activeLtuids.add(cleanId(ltuid))
  }
  activeLtuids.delete('')

  const counter = makeCounter()
  const community = makeCounter()
  for (const ltuid of activeLtuids) {
    mergeCounter(counter, data?.accounts?.[ltuid])
    mergeCounter(community, data?.community?.[ltuid])
  }

  // A detached snapshot belongs to its QQ. A single ltuid snapshot can only
  // contribute once to a given group's report, even if stale duplicate data exists.
  const detachedLtuids = new Set()
  for (const qq of members) {
    const snapshots = data?.detached?.[qq] || {}
    for (const [ltuid, snapshot] of Object.entries(snapshots)) {
      if (activeLtuids.has(ltuid) || detachedLtuids.has(ltuid)) continue
      detachedLtuids.add(ltuid)
      mergeCounter(counter, snapshot?.stats)
      mergeCounter(community, snapshot?.community)
    }
    const pending = data?.pending?.byQQ?.[qq]
    mergeCounter(counter, pending?.stats)
    mergeCounter(community, pending?.community)
  }

  return {
    counter,
    community,
    activeLtuids: [...activeLtuids],
    detachedLtuids: [...detachedLtuids],
    pendingQQs: members.filter(qq => hasCounterData(data?.pending?.byQQ?.[qq]?.stats))
  }
}

export function resolvePendingInData(data, qqValue, boundLtuids = []) {
  const qq = cleanId(qqValue)
  const pending = data?.pending?.byQQ?.[qq]
  if (!qq || !pending) return false
  const ltuids = [...new Set((boundLtuids || []).map(cleanId).filter(Boolean))]
  if (ltuids.length !== 1) return false
  const account = data.accounts[ltuids[0]] ||= makeCounter()
  const community = data.community[ltuids[0]] ||= makeCounter()
  mergeCounter(account, pending.stats)
  mergeCounter(community, pending.community)
  delete data.pending.byQQ[qq]
  return true
}

export function removeSnapshotsForLtuid(data, ltuidValue) {
  const ltuid = cleanId(ltuidValue)
  if (!ltuid) return false
  let changed = false
  for (const [qq, snapshots] of Object.entries(data?.detached || {})) {
    if (Object.prototype.hasOwnProperty.call(snapshots, ltuid)) {
      delete snapshots[ltuid]
      changed = true
    }
    if (Object.keys(snapshots).length === 0) delete data.detached[qq]
  }
  return changed
}

export function createDetachedSnapshot(data, qqValue, ltuidValue, detachedAt = new Date().toISOString()) {
  const qq = cleanId(qqValue)
  const ltuid = cleanId(ltuidValue)
  if (!qq || !ltuid || ltuid === 'unknown' || !hasCounterData(data?.accounts?.[ltuid])) return false

  for (const snapshots of Object.values(data?.detached || {})) {
    if (Object.prototype.hasOwnProperty.call(snapshots, ltuid)) return false
  }

  const snapshots = data.detached ||= {}
  const qqSnapshots = snapshots[qq] ||= {}
  qqSnapshots[ltuid] = {
    stats: cloneCounter(data.accounts[ltuid]),
    community: cloneCounter(data.community?.[ltuid]),
    detachedAt: cleanText(detachedAt, 40)
  }
  return true
}
