import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'
import { UserDB } from './db/index.js'
import {
  cleanId,
  cleanText,
  makeCounter,
  normalizeCounter,
  cloneCounter,
  hasCounterData,
  mergeCounter,
  incrementCounter,
  counterView,
  sumCounters,
  sumViews,
  aggregateQQCounters,
  aggregateGroupCounters,
  resolvePendingInData,
  removeSnapshotsForLtuid,
  createDetachedSnapshot
} from './VerificationStatsCore.js'

const dir = path.resolve('./data/verification')
const file = path.join(dir, 'stats.json')
const skDir = path.resolve(process.cwd(), 'plugins/genshin/yaml')
let mutationQueue = Promise.resolve()

function withMutation(fn) {
  const task = mutationQueue.then(fn, fn)
  mutationQueue = task.catch(() => {})
  return task
}

function emptyData() {
  return {
    schemaVersion: 3,
    accounts: {},
    community: {},
    detached: {},
    pending: {
      byQQ: {},
      unassigned: { stats: makeCounter(), community: makeCounter() }
    }
  }
}

function normalizeDetached(value = {}) {
  const result = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [qqValue, snapshots] of Object.entries(value)) {
    const qq = cleanId(qqValue)
    if (!qq || !snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)) continue
    const normalized = {}
    for (const [ltuidValue, snapshot] of Object.entries(snapshots)) {
      const ltuid = cleanId(ltuidValue)
      if (!ltuid || ltuid === 'unknown') continue
      const stats = normalizeCounter(snapshot?.stats || snapshot)
      const community = normalizeCounter(snapshot?.community)
      if (!hasCounterData(stats) && !hasCounterData(community)) continue
      normalized[ltuid] = {
        stats,
        community,
        detachedAt: cleanText(snapshot?.detachedAt, 40)
      }
    }
    if (Object.keys(normalized).length) result[qq] = normalized
  }
  return result
}

function normalizePending(value = {}) {
  const byQQ = {}
  const rawByQQ = value?.byQQ && typeof value.byQQ === 'object' ? value.byQQ : {}
  for (const [qqValue, record] of Object.entries(rawByQQ)) {
    const qq = cleanId(qqValue)
    if (!qq) continue
    const stats = normalizeCounter(record?.stats)
    const community = normalizeCounter(record?.community)
    if (hasCounterData(stats) || hasCounterData(community)) byQQ[qq] = { stats, community }
  }
  const unassigned = value?.unassigned || {}
  return {
    byQQ,
    unassigned: {
      stats: normalizeCounter(unassigned?.stats),
      community: normalizeCounter(unassigned?.community)
    }
  }
}

function normalize(data = {}) {
  const accounts = {}
  for (const [ltuidValue, counter] of Object.entries(data.accounts || {})) {
    const ltuid = cleanId(ltuidValue)
    if (!ltuid || ltuid === 'unknown') continue
    accounts[ltuid] = normalizeCounter(counter)
  }

  const community = {}
  for (const [ltuidValue, counter] of Object.entries(data.community || {})) {
    const ltuid = cleanId(ltuidValue)
    if (!ltuid || ltuid === 'unknown') continue
    community[ltuid] = normalizeCounter(counter)
  }

  return {
    schemaVersion: 3,
    accounts,
    community,
    detached: normalizeDetached(data.detached),
    pending: normalizePending(data.pending)
  }
}

function ensureDir() {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function write(data) {
  ensureDir()
  const normalized = normalize(data)
  const tempFile = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2), 'utf8')
  fs.renameSync(tempFile, file)
  return normalized
}

function read() {
  ensureDir()
  if (!fs.existsSync(file)) return write(emptyData())

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return normalize(raw)
  } catch (error) {
    logger.error(`[genshin][verification] 统计文件格式无效，已重新初始化：${error}`)
    return write(emptyData())
  }
}

function getShanghaiKeys(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map(item => [item.type, item.value]))
  const day = `${values.year}-${values.month}-${values.day}`
  return { day, month: day.slice(0, 7) }
}

function firstCleanText(values, max = 60) {
  for (const value of values) {
    const text = cleanText(value, max)
    if (text) return text
  }
  return ''
}

function parseLtuid(cookie) {
  const match = String(cookie || '').match(/(?:^|[;\s])(?:ltuid_v2|account_id_v2|ltuid|account_id|stuid)=(\d+)/)
  return match?.[1] || ''
}

function botList() {
  if (typeof Bot === 'undefined') return []
  if (Array.isArray(Bot.uin)) return Bot.uin.map(id => Bot[id] || Bot[String(id)]).filter(Boolean)
  return [Bot]
}

function nicknameFromEvent(e, qq) {
  if (!e || cleanId(e.user_id) !== cleanId(qq)) return ''
  return cleanText(e?.sender?.nickname || e?.nickname || '')
}

function nicknameFromBot(qq) {
  const userId = Number(qq) || qq
  try {
    for (const bot of botList()) {
      const friend = bot?.pickFriend?.(userId)
      const name = cleanText(friend?.nickname)
      if (name) return name
    }
  } catch (error) {
    logger.debug?.(`[genshin][verification] 获取QQ昵称失败: ${error}`)
  }
  return ''
}

function groupNameFromEvent(e, groupId) {
  if (!e || cleanId(e.group_id) !== cleanId(groupId)) return ''
  return firstCleanText([
    e?.group_name,
    e?.group?.name,
    e?.group?.group_name,
    e?.group?.info?.group_name,
    e?.group?.info?.name
  ])
}

function groupRef(groupId, e = {}) {
  const botId = cleanId(e?.self_id) || (typeof Bot !== 'undefined' ? cleanId(Array.isArray(Bot.uin) ? Bot.uin[0] : Bot.uin) : '')
  return botId ? `${botId}:${cleanId(groupId)}` : cleanId(groupId)
}

function splitGroupRef(ref) {
  const value = cleanId(ref)
  if (!value) return {}
  const index = value.indexOf(':')
  if (index < 0) return { botId: '', groupId: value }
  return { botId: value.slice(0, index), groupId: value.slice(index + 1) }
}

function pickGroup(ref) {
  const { botId, groupId } = splitGroupRef(ref)
  if (!groupId || typeof Bot === 'undefined') return null
  const id = Number(groupId) || groupId
  try {
    if (Array.isArray(Bot.uin)) {
      if (botId) return (Bot[botId] || Bot[Number(botId)])?.pickGroup?.(id) || null
      for (const bot of botList()) {
        const group = bot?.pickGroup?.(id)
        if (group) return group
      }
      return null
    }
    return Bot.pickGroup?.(id) || null
  } catch {
    return null
  }
}

async function getGroupMembers(ref) {
  const group = pickGroup(ref)
  if (!group) return null
  const extract = value => {
    if (value instanceof Map) return [...new Set([...value.keys()].map(cleanId).filter(Boolean))]
    if (Array.isArray(value)) return [...new Set(value.map(item => cleanId(item?.user_id ?? item?.userId ?? item?.qq ?? item?.id)).filter(Boolean))]
    if (value && typeof value === 'object') return [...new Set(Object.keys(value).map(cleanId).filter(Boolean))]
    return []
  }
  try {
    let attempted = false
    let members = []
    if (typeof group.getMemberMap === 'function') {
      attempted = true
      try { members = extract(await group.getMemberMap()) } catch (error) {
        logger.debug?.(`[genshin][verification] getMemberMap 失败 ${ref}: ${error.message}`)
      }
    }
    if (members.length === 0 && group.memberMap) {
      attempted = true
      members = extract(group.memberMap)
    }
    if (members.length === 0 && typeof group.getMemberList === 'function') {
      attempted = true
      members = extract(await group.getMemberList())
    }
    return attempted ? members : null
  } catch (error) {
    logger.error(`[genshin][verification] 获取群成员失败 ${ref}: ${error}`)
    return null
  }
}

function getAllGroupRefs() {
  if (typeof Bot === 'undefined') return []
  const result = []
  const append = (source, fallbackBotId = '') => {
    const entries = source instanceof Map ? [...source.entries()] : Object.entries(source || {})
    for (const [key, item] of entries) {
      const botId = cleanId(item?.bot_id ?? item?.self_id ?? fallbackBotId)
      const rawId = cleanId(item?.group_id ?? item?.groupId ?? item?.id ?? key)
      if (!rawId) continue
      if (rawId.includes(':')) result.push(rawId)
      else result.push(botId ? `${botId}:${rawId}` : rawId)
    }
  }
  if (Array.isArray(Bot.uin)) {
    for (const botId of Bot.uin) append((Bot[botId] || Bot[String(botId)])?.gl, botId)
  } else {
    append(Bot.gl, Bot.uin)
  }
  if (result.length === 0) append(Bot.gl)
  return [...new Set(result)]
}

function groupNameFromBot(ref) {
  const group = pickGroup(ref)
  return firstCleanText([group?.name, group?.group_name, group?.info?.group_name, group?.info?.name])
}

function groupNicknameFromBot(ref, qq) {
  const group = pickGroup(ref)
  const member = group?.pickMember?.(Number(qq) || qq)
  return firstCleanText([member?.card, member?.nickname, member?.info?.card, member?.info?.nickname], 40)
}

function parseSkIdentity(item, key, fileQQ) {
  const value = item && typeof item === 'object' ? item : {}
  const nested = value.sk && typeof value.sk === 'object' ? value.sk : {}
  const raw = typeof item === 'string' ? item : typeof value.sk === 'string' ? value.sk : ''
  const getRaw = field => raw.match(new RegExp(`(?:^|;\\s*)${field}=([^;]+)`))?.[1] || ''
  const ltuid = cleanId(
    value.stuid || nested.stuid || getRaw('stuid') || getRaw('ltuid') ||
    getRaw('ltuid_v2') || (/^\d+$/.test(String(key || '')) ? key : '')
  )
  const qq = cleanId(value.userId || nested.userId || fileQQ)
  return { qq, ltuid }
}

async function loadIdentityMap() {
  const qqToLtuids = {}
  const qqNames = {}
  const ltuidToQQs = {}
  let complete = true
  const add = (qqValue, ltuidValue, name = '') => {
    const qq = cleanId(qqValue)
    const ltuid = cleanId(ltuidValue)
    if (!qq || !ltuid || ltuid === 'unknown') return
    const list = qqToLtuids[qq] ||= []
    if (!list.includes(ltuid)) list.push(ltuid)
    const reverse = ltuidToQQs[ltuid] ||= []
    if (!reverse.includes(qq)) reverse.push(qq)
    if (name && !qqNames[qq]) qqNames[qq] = cleanText(name, 40)
  }

  try {
    const rows = await UserDB.findAll()
    for (const row of rows || []) {
      const qq = cleanId(row?.id)
      if (!qq || (row?.type && row.type !== 'qq')) continue
      if (row?.name && !qqNames[qq]) qqNames[qq] = cleanText(row.name, 40)
      for (const ltuid of String(row?.ltuids || '').split(',')) add(qq, ltuid, row?.name)
    }
  } catch (error) {
    complete = false
    logger.error(`[genshin][verification] 读取QQ-CK绑定关系失败：${error}`)
  }

  try {
    if (fs.existsSync(skDir)) {
      for (const filename of fs.readdirSync(skDir).filter(name => name.endsWith('.yaml'))) {
        const fileQQ = filename.replace(/\.yaml$/i, '')
        if (!/^\d+$/.test(fileQQ)) continue
        try {
          const parsed = yaml.parse(fs.readFileSync(path.join(skDir, filename), 'utf8')) || {}
          if (!parsed || typeof parsed !== 'object') continue
          for (const [key, item] of Object.entries(parsed)) {
            const identity = parseSkIdentity(item, key, fileQQ)
            add(identity.qq, identity.ltuid)
          }
        } catch (error) {
          complete = false
          logger.warn(`[genshin][verification] 读取SK关联文件失败 ${filename}: ${error.message}`)
        }
      }
    }
  } catch (error) {
    complete = false
    logger.error(`[genshin][verification] 扫描SK关联目录失败：${error}`)
  }

  for (const list of Object.values(qqToLtuids)) list.sort()
  return { qqToLtuids, qqNames, ltuidToQQs, complete }
}

function mergePendingIntoAccount(data, qq, ltuid) {
  const pending = data.pending.byQQ[qq]
  if (!pending) return false
  const account = data.accounts[ltuid] ||= makeCounter()
  const community = data.community[ltuid] ||= makeCounter()
  mergeCounter(account, pending.stats)
  mergeCounter(community, pending.community)
  delete data.pending.byQQ[qq]
  return true
}

async function resolvePendingForQQ(qqValue, boundLtuids = null) {
  const qq = cleanId(qqValue)
  if (!qq) return false
  return withMutation(async () => {
    const data = read()
    if (!data.pending.byQQ[qq]) return false
    let ltuids = boundLtuids
    if (!Array.isArray(ltuids)) {
      const identity = await loadIdentityMap()
      if (!identity.complete) return false
      ltuids = identity.qqToLtuids[qq] || []
    }
    const changed = resolvePendingInData(data, qq, ltuids)
    if (changed) write(data)
    return changed
  })
}

async function snapshotUnbind(qqValue, ltuidValue) {
  const qq = cleanId(qqValue)
  const ltuid = cleanId(ltuidValue)
  if (!qq || !ltuid || ltuid === 'unknown') return false
  return withMutation(() => {
    const data = read()
    const changed = createDetachedSnapshot(data, qq, ltuid)
    if (changed) write(data)
    return changed
  })
}

async function onQQBind(qqValue, ltuidValue) {
  const qq = cleanId(qqValue)
  const ltuid = cleanId(ltuidValue)
  if (!qq || !ltuid) return false
  return withMutation(() => {
    const data = read()
    const removed = removeSnapshotsForLtuid(data, ltuid)
    if (removed) write(data)
    return removed
  })
}

async function onQQUnbind(qqValue, ltuidValue) {
  const qq = cleanId(qqValue)
  const ltuid = cleanId(ltuidValue)
  if (!qq || !ltuid) return false
  return withMutation(async () => {
    // Callers update UserDB/SK YAML first, so this is the post-unbind relation map.
    const identity = await loadIdentityMap()
    const data = read()
    const remainingQQs = identity.ltuidToQQs[ltuid] || []
    let changed = false
    if (!identity.complete) {
      logger.warn(`[genshin][verification] 解绑 ltuid:${ltuid} 时关联关系扫描不完整，暂不创建解绑快照`)
      return false
    }
    if (remainingQQs.length === 0) changed = createDetachedSnapshot(data, qq, ltuid) || changed
    if (changed) write(data)
    return changed
  })
}

async function purgeSnapshotsForBoundLtuids(identity) {
  if (!identity?.complete) return false
  return withMutation(() => {
    const data = read()
    let changed = false
    for (const ltuid of Object.keys(identity.ltuidToQQs || {})) {
      changed = removeSnapshotsForLtuid(data, ltuid) || changed
    }
    if (changed) write(data)
    return changed
  })
}

function context(e, fallbackQQ = '', details = {}) {
  const qq = cleanId(details?.qq || e?.user_id || fallbackQQ)
  const eventQQ = cleanId(e?.user_id)
  const nickname = qq ? (nicknameFromEvent(e, qq) || nicknameFromBot(qq)) : ''
  const groupId = eventQQ && eventQQ === qq ? cleanId(e?.group_id) : ''
  const groupName = groupId ? (groupNameFromEvent(e, groupId) || groupNameFromBot(groupRef(groupId, e))) : ''
  const groupNickname = groupId && qq
    ? (groupNicknameFromBot(groupRef(groupId, e), qq) || nickname)
    : ''
  const cookie = details?.cookie || details?.ck || details?.sk || details?.api?.cookie || ''
  const ltuid = cleanId(details?.ltuid || parseLtuid(cookie))
  const community = details?.community === true
  return { qq, nickname, groupId, groupName, groupNickname, ltuid, community }
}

async function increment(field, meta = {}) {
  return withMutation(async () => {
  const data = read()
  const qq = cleanId(meta.qq)
  let ltuid = cleanId(meta.ltuid)
  if (ltuid === 'unknown') ltuid = ''

  let identity = null
  // 没有明确 ltuid 的事件一律先进入 QQ 待归属区，不根据“当前只有一个绑定”猜测账号。
  if (ltuid && qq && data.pending.byQQ[qq]) identity = await loadIdentityMap()

  if (ltuid && qq && data.pending.byQQ[qq] && identity?.complete) {
    const linked = identity.qqToLtuids[qq] || []
    if (linked.length === 1 && linked[0] === ltuid) mergePendingIntoAccount(data, qq, ltuid)
  }

  const { day, month } = getShanghaiKeys()
  let target
  let communityTarget
  if (ltuid) {
    target = data.accounts[ltuid] ||= makeCounter()
    if (meta.community === true) communityTarget = data.community[ltuid] ||= makeCounter()
  } else if (qq) {
    const pending = data.pending.byQQ[qq] ||= { stats: makeCounter(), community: makeCounter() }
    target = pending.stats
    if (meta.community === true) communityTarget = pending.community
  } else {
    target = data.pending.unassigned.stats
    if (meta.community === true) communityTarget = data.pending.unassigned.community
  }

  incrementCounter(target, field, day, month)
  if (communityTarget) incrementCounter(communityTarget, field, day, month)
  return write(data)
  })
}

function getPendingCounters(data, memberQQs = null) {
  const stats = makeCounter()
  const community = makeCounter()
  if (Array.isArray(memberQQs)) {
    for (const qq of new Set(memberQQs.map(cleanId).filter(Boolean))) {
      const pending = data.pending.byQQ[qq]
      mergeCounter(stats, pending?.stats)
      mergeCounter(community, pending?.community)
    }
  } else {
    mergeCounter(stats, data.pending.unassigned.stats)
    mergeCounter(community, data.pending.unassigned.community)
    for (const pending of Object.values(data.pending.byQQ)) {
      mergeCounter(stats, pending.stats)
      mergeCounter(community, pending.community)
    }
  }
  return { stats, community }
}

function buildLtuidRows(accounts, day, month, labels = {}) {
  return Object.entries(accounts || {})
    .filter(([, counter]) => hasCounterData(counter))
    .map(([ltuid, counter]) => ({
      key: ltuid,
      ltuid,
      isSnapshot: labels[ltuid] === 'snapshot',
      stats: counterView(counter, day, month)
    }))
    .sort((a, b) => b.stats.today.triggered - a.stats.today.triggered ||
      b.stats.month.triggered - a.stats.month.triggered ||
      b.stats.lifetime.triggered - a.stats.lifetime.triggered ||
      String(a.key).localeCompare(String(b.key)))
}

function buildQQRows(qqs, identity, data, day, month, groupRef = '') {
  const rows = []
  for (const qq of [...new Set(qqs.map(cleanId).filter(Boolean))]) {
    const aggregate = aggregateQQCounters(data, qq, identity.qqToLtuids[qq] || [])
    if (!hasCounterData(aggregate.counter)) continue
    const liveName = nicknameFromBot(qq)
    const groupName = groupRef ? groupNicknameFromBot(groupRef, qq) : ''
    const name = groupName || liveName || cleanText(identity.qqNames[qq], 40) || qq
    rows.push({ key: qq, qq, name, stats: counterView(aggregate.counter, day, month) })
  }
  return rows.sort((a, b) => b.stats.today.triggered - a.stats.today.triggered ||
    b.stats.month.triggered - a.stats.month.triggered ||
    b.stats.lifetime.triggered - a.stats.lifetime.triggered ||
    String(a.key).localeCompare(String(b.key)))
}

function buildAccountSection(accounts, day, month, title = '米游社账号统计') {
  const rows = buildLtuidRows(accounts, day, month)
  return { title, rows, totalCount: rows.length, stats: sumViews(rows) }
}

function makePendingSection(pendingStats, pendingCommunity, day, month) {
  const stats = counterView(pendingStats, day, month)
  const community = counterView(pendingCommunity, day, month)
  const totalCount = hasCounterData(pendingStats) ? 1 : 0
  return { stats, community, totalCount }
}

async function buildGroupReport(ref, identity, data, day, month, e = null) {
  const members = await getGroupMembers(ref)
  if (members === null) {
    logger.warn(`[genshin][verification] 群 ${ref} 无法获取当前成员列表，已跳过该群统计`)
    return null
  }
  const aggregate = aggregateGroupCounters(data, members, identity.qqToLtuids)
  const accountCounters = {}
  for (const ltuid of aggregate.activeLtuids) {
    accountCounters[ltuid] = data.accounts[ltuid]
  }
  const snapshotLabels = {}
  for (const qq of members) {
    for (const [ltuid, snapshot] of Object.entries(data.detached[qq] || {})) {
      if (aggregate.activeLtuids.includes(ltuid) || Object.prototype.hasOwnProperty.call(accountCounters, ltuid)) continue
      accountCounters[ltuid] = snapshot.stats
      snapshotLabels[ltuid] = 'snapshot'
    }
  }
  const accountRows = buildLtuidRows(accountCounters, day, month, snapshotLabels)
  const pending = getPendingCounters(data, members)
  return {
    ref,
    name: groupNameFromEvent(e, splitGroupRef(ref).groupId) || groupNameFromBot(ref) || '未获取群名',
    members,
    aggregate,
    accountRows,
    accountCounters,
    pending,
    stats: counterView(aggregate.counter, day, month)
  }
}

function getGroupScopedRef(groupId, e) {
  if (!groupId) return ''
  return groupRef(groupId, e)
}

async function getSummary(groupId = '', e = null) {
  const { day, month } = getShanghaiKeys()
  const scopedGroupId = cleanId(groupId)
  if (scopedGroupId) {
    const identity = await loadIdentityMap()
    if (!identity.complete) throw new Error('QQ 与 ltuid 绑定关系读取不完整')
    await purgeSnapshotsForBoundLtuids(identity)
    const data = read()
    const ref = getGroupScopedRef(scopedGroupId, e || {})
    const members = await getGroupMembers(ref)
    if (members === null) throw new Error(`无法获取群 ${scopedGroupId} 的当前成员列表`)
    const aggregate = aggregateGroupCounters(data, members, identity.qqToLtuids)
    const pending = getPendingCounters(data, members)
    return { ...counterView(aggregate.counter, day, month), pendingIncluded: hasCounterData(pending.stats) }
  }
  const data = read()
  const accountTotal = sumCounters(Object.values(data.accounts))
  const pending = getPendingCounters(data)
  mergeCounter(accountTotal, pending.stats)
  return { ...counterView(accountTotal, day, month), pendingIncluded: hasCounterData(pending.stats) }
}

async function getReportData({ groupId = '', e } = {}) {
  const { day, month } = getShanghaiKeys()
  const scopedGroupId = cleanId(groupId)
  const groupScoped = Boolean(scopedGroupId)
  const identity = await loadIdentityMap()
  if (!identity.complete) throw new Error('QQ 与 ltuid 绑定关系读取不完整')
  await purgeSnapshotsForBoundLtuids(identity)
  const data = read()

  let summaryCounter
  let accountSection
  let pending
  let groupRows = []
  let skippedGroupCount = 0
  let userRows = []

  if (groupScoped) {
    const ref = getGroupScopedRef(scopedGroupId, e || {})
    const report = await buildGroupReport(ref, identity, data, day, month, e)
    if (!report) throw new Error(`无法获取群 ${scopedGroupId} 的当前成员列表`)
    summaryCounter = cloneCounter(report.aggregate.counter)
    accountSection = buildAccountSection(report.accountCounters, day, month)
    // Include detached snapshots as account rows for this group's current members.
    accountSection.rows = report.accountRows
    accountSection.totalCount = report.accountRows.length
    accountSection.stats = sumViews(report.accountRows)
    pending = makePendingSection(report.pending.stats, report.pending.community, day, month)
    userRows = buildQQRows(report.members, identity, data, day, month, ref)
  } else {
    const accountRows = buildLtuidRows(data.accounts, day, month)
    accountSection = { title: '米游社账号统计', rows: accountRows, totalCount: accountRows.length, stats: sumViews(accountRows) }
    const pendingCounters = getPendingCounters(data)
    pending = makePendingSection(pendingCounters.stats, pendingCounters.community, day, month)
    summaryCounter = sumCounters(Object.values(data.accounts))
    mergeCounter(summaryCounter, pendingCounters.stats)

    const refs = getAllGroupRefs()
    const groupReports = await Promise.all(refs.map(ref => buildGroupReport(ref, identity, data, day, month)))
    skippedGroupCount = groupReports.filter(report => report === null).length
    groupRows = groupReports
      .filter(report => report && hasCounterData(report.aggregate.counter))
      .map(report => ({ key: report.ref, name: report.name, stats: report.stats }))
      .sort((a, b) => b.stats.today.triggered - a.stats.today.triggered ||
        b.stats.month.triggered - a.stats.month.triggered ||
        b.stats.lifetime.triggered - a.stats.lifetime.triggered ||
        String(a.key).localeCompare(String(b.key)))

    const allQQs = new Set([
      ...Object.keys(identity.qqToLtuids),
      ...Object.keys(data.detached),
      ...Object.keys(data.pending.byQQ)
    ])
    userRows = buildQQRows([...allQQs], identity, data, day, month)
  }

  const groupSection = groupScoped ? null : {
    title: '群聊统计',
    rows: groupRows,
    totalCount: groupRows.length,
    skippedCount: groupScoped ? 0 : (typeof skippedGroupCount === 'number' ? skippedGroupCount : 0)
  }
  const userSection = {
    title: 'QQ统计',
    rows: userRows,
    totalCount: userRows.length,
    // QQ totals are the sum of each QQ's own projection. Shared ltuids may
    // therefore overlap between QQ rows and must not be added to global totals.
    stats: sumViews(userRows)
  }

  return {
    title: groupScoped ? '本群过码使用统计' : '过码使用统计',
    day,
    timezone: 'UTC+8',
    groupScoped,
    summary: counterView(summaryCounter || makeCounter(), day, month),
    summaryIncludesPending: pending.totalCount > 0,
    accountSection,
    pendingSection: pending,
    groupSection,
    userSection,
    hasRows: Boolean(accountSection.totalCount || pending.totalCount || groupSection?.totalCount || userSection.totalCount)
  }
}

export default {
  addTriggered(meta = {}) {
    return increment('triggered', meta)
  },

  addPassed(meta = {}) {
    return increment('passed', meta)
  },

  getStats() {
    return read()
  },

  getSummary,
  getReportData,
  context,
  onQQBind,
  onQQUnbind,
  resolvePendingForQQ,
  snapshotUnbind,
  removeSnapshotsForLtuid(ltuidValue) {
    const ltuid = cleanId(ltuidValue)
    if (!ltuid) return false
    return withMutation(() => {
      const data = read()
      const changed = removeSnapshotsForLtuid(data, ltuid)
      if (changed) write(data)
      return changed
    })
  },
  async getQQBindingsMap() {
    return (await loadIdentityMap()).qqToLtuids
  },
  resolveNickname(qq, e) {
    return nicknameFromEvent(e, qq) || nicknameFromBot(qq)
  },
  resolveGroupName(groupId, e) {
    return groupNameFromEvent(e, groupId) || groupNameFromBot(groupRef(groupId, e))
  },
  resolveGroupNickname(groupId, qq, e) {
    return groupNicknameFromBot(groupRef(groupId, e), qq)
  },
  file
}
