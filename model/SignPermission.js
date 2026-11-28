import fs from 'node:fs'
import yaml from 'yaml'
import cfg from '../../../lib/config/config.js'
import { resolveSignPermission, filterCoinCandidates } from './SignPermissionCore.js'

const root = process.cwd().replace(/\\/g, '/')
const configDir = `${root}/plugins/genshin/config`

function readYaml(name) {
  try {
    return yaml.parse(fs.readFileSync(`${configDir}/${name}.yaml`, 'utf8')) || {}
  } catch {
    return {}
  }
}

function asList(value) {
  return Array.isArray(value) ? value : []
}

function norm(value) {
  return String(value ?? '').trim()
}

function uniq(values) {
  return [...new Set((values || []).map(norm).filter(Boolean))]
}

function isMasterQQ(qq) {
  qq = norm(qq)
  return asList(cfg.masterQQ).some(id => norm(id) === qq)
}

function splitGroupRef(ref) {
  ref = norm(ref)
  if (!ref) return {}
  let idx = ref.indexOf(':')
  if (idx === -1) return { botId: '', groupId: ref }
  return { botId: ref.slice(0, idx), groupId: ref.slice(idx + 1) }
}

function sameGroupRef(left, right) {
  const a = splitGroupRef(left)
  const b = splitGroupRef(right)
  if (!a.groupId || !b.groupId || a.groupId !== b.groupId) return false
  return !a.botId || !b.botId || a.botId === b.botId
}

function isBlacklistedGroup(ref, blacklist) {
  return asList(blacklist).some(item => sameGroupRef(ref, item))
}

function pickGroup(ref) {
  let { botId, groupId } = splitGroupRef(ref)
  if (!groupId) return null
  groupId = Number(groupId) || groupId
  try {
    if (Array.isArray(Bot.uin)) {
      if (botId) {
        let bot = Bot[botId] || Bot[Number(botId)]
        return bot?.pickGroup?.(groupId) || null
      }
      for (let id of Bot.uin) {
        let group = Bot[id]?.pickGroup?.(groupId)
        if (group) return group
      }
      return null
    }
    return Bot.pickGroup?.(groupId) || null
  } catch {
    return null
  }
}

async function getGroupMembers(ref) {
  let group = pickGroup(ref)
  if (!group) return []

  try {
    let data
    if (typeof group.getMemberMap === 'function') data = await group.getMemberMap()
    else if (group.memberMap) data = group.memberMap
    else if (typeof group.getMemberList === 'function') data = await group.getMemberList()

    if (data instanceof Map) return uniq([...data.keys()])
    if (Array.isArray(data))
      return uniq(data.map(item => item?.user_id ?? item?.userId ?? item?.qq ?? item?.id))
    if (data && typeof data === 'object') return uniq(Object.keys(data))
  } catch (error) {
    logger.error(`[签到权限]获取群成员失败 ${ref}: ${error}`)
  }
  return []
}

async function isMember(ref, qq) {
  qq = norm(qq)
  if (!qq) return false

  // pickMember() 在部分适配器中只是创建一个成员对象，即使该 QQ 实际不在群里
  // 也会带 user_id，不能据此判断成员关系。必须以真实群成员表为准。
  let members = await getGroupMembers(ref)
  return members.includes(qq)
}

function getAllGroupRefs() {
  try {
    let values = Bot.gl instanceof Map ? [...Bot.gl.values()] : Object.values(Bot.gl || {})
    return uniq(values.map(item => {
      let botId = item?.bot_id ?? item?.self_id ?? (Array.isArray(Bot.uin) ? Bot.uin[0] : Bot.uin)
      let groupId = item?.group_id ?? item?.groupId ?? item?.id
      return groupId ? `${botId ?? ''}:${groupId}` : ''
    }))
  } catch {
    return []
  }
}

async function membersOfGroups(refs, allWhenEmpty = false) {
  refs = uniq(refs)
  if (refs.length === 0 && allWhenEmpty) refs = getAllGroupRefs()

  let result = []
  for (let ref of refs)
    result.push(...await getGroupMembers(ref))
  return uniq(result)
}

async function belongsToAny(qq, refs) {
  for (let ref of uniq(refs))
    if (await isMember(ref, qq)) return true
  return false
}

/**
 * 返回“只属于游戏签到黑名单群、没有任何非黑名单群成员身份”的 QQ。
 * Bot.gl 中所有已知群均视为黑名单之外的候选群；同一 QQ 只要在其中
 * 任意一个群，就不会因为其同时属于黑名单群而被排除。
 */
async function getGameBlacklistOnlyMembers(blacklist, extraGroupRefs = []) {
  blacklist = uniq(blacklist)
  if (blacklist.length === 0) return new Set()

  const blacklistedMembers = new Set(await membersOfGroups(blacklist))
  if (blacklistedMembers.size === 0) return new Set()

  const knownRefs = uniq([...getAllGroupRefs(), ...extraGroupRefs])
  const nonBlacklistedRefs = knownRefs.filter(ref => !isBlacklistedGroup(ref, blacklist))
  const nonBlacklistedMembers = new Set(await membersOfGroups(nonBlacklistedRefs))

  return new Set([...blacklistedMembers].filter(qq => !nonBlacklistedMembers.has(qq)))
}

async function isGameBlacklistOnlyMember(qq, blacklist, extraGroupRefs = []) {
  qq = norm(qq)
  blacklist = uniq(blacklist)
  if (!qq || blacklist.length === 0 || !await belongsToAny(qq, blacklist)) return false

  const knownRefs = uniq([...getAllGroupRefs(), ...extraGroupRefs])
  for (const ref of knownRefs) {
    if (isBlacklistedGroup(ref, blacklist)) continue
    if (await isMember(ref, qq)) return false
  }
  return true
}

function getWhite() {
  let white = readYaml('white')
  return {
    ...white,
    QQ: asList(white.QQ),
    bbsQQ: asList(white.bbsQQ),
    bbsQQBlack: asList(white.bbsQQBlack),
    gameGroup: asList(white.gameGroup),
    bbsGroup: asList(white.bbsGroup),
    signPush: asList(white.signPush),
    bbsPush: asList(white.bbsPush),
    // 新开关默认开启，兼容升级前“自动游戏签到通知主人”的行为。
    notifyMaster: white.notifyMaster !== false
  }
}

export async function getPermission(qq, contextGroupRef = '') {
  qq = norm(qq)
  let white = getWhite()
  let gameQQ = uniq([...white.QQ, ...white.bbsQQ]).map(norm)
  let coinQQ = white.bbsQQ.map(norm)
  let coinBlack = new Set(white.bbsQQBlack.map(norm))
  const coinDenied = coinBlack.has(qq)

  // 米币黑名单只撤销米币权限，不改动该 QQ 原本的游戏签到授权判断。
  const gameDenied = await isGameBlacklistOnlyMember(qq, white.gameGroup, [...white.bbsGroup, contextGroupRef])
  const gameAllowed = gameQQ.includes(qq) || !gameDenied
  const inCoinScope = white.bbsGroup.length === 0 || await belongsToAny(qq, white.bbsGroup)
  const coinAllowed = !coinDenied && (coinQQ.includes(qq) || inCoinScope)

  return resolveSignPermission({
    isMaster: isMasterQQ(qq),
    coinDenied,
    gameAllowed,
    coinAllowed
  })
}

export function hasLevel(permission, level) {
  if (permission === 'coinOnly') return level === 'coin'
  let rank = { none: 0, game: 1, coin: 2, master: 3 }
  return (rank[permission] || 0) >= (rank[level] || 0)
}

function cronTime(cron) {
  let parts = norm(cron).split(/\s+/)
  if (parts.length < 3) return null
  let values = parts.slice(0, 3).map(part => /^\d+$/.test(part) ? Number(part) : NaN)
  if (values.some(Number.isNaN)) return null
  let [sec, min, hour] = values
  if (sec > 59 || min > 59 || hour > 23) return null
  return { hour, min, sec }
}

export function isBeforeManualTime(level) {
  let config = readYaml('config')
  let time = cronTime(level === 'coin' ? config.bbsSignTime : config.signTime)
  if (!time) return false

  let now = new Date()
  let nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
  let startSeconds = time.hour * 3600 + time.min * 60 + time.sec
  return nowSeconds < startSeconds
}

export async function getMasterTargets(e, level) {
  let white = getWhite()
  let targets
  if (e?.group_id) {
    let ref = `${e.self_id ?? ''}:${e.group_id}`
    targets = await membersOfGroups([ref], false)
  } else {
    // 私聊批量任务按对应群范围收集，并把显式 QQ 名单一并纳入目标。
    let refs = level === 'game'
      ? uniq([...getAllGroupRefs(), ...white.bbsGroup, ...white.gameGroup])
      : uniq(white.bbsGroup)
    targets = await membersOfGroups(refs, true)
    targets.push(...(level === 'game' ? [...white.QQ, ...white.bbsQQ] : white.bbsQQ))
  }

  if (level === 'game') {
    let denied = await getGameBlacklistOnlyMembers(white.gameGroup, [...white.bbsGroup, e?.group_id ? `${e.self_id ?? ''}:${e.group_id}` : ''])
    let explicitQQ = new Set(uniq([...white.QQ, ...white.bbsQQ]))
    targets = targets.filter(qq => !denied.has(norm(qq)) || explicitQQ.has(norm(qq)))
  } else {
    const coinBlack = new Set(white.bbsQQBlack.map(norm))
    targets = targets.filter(qq => !coinBlack.has(norm(qq)))
  }
  return uniq(targets)
}

export async function getAutoQQs(level, candidateQQs = null) {
  let config = readYaml('config')
  let white = getWhite()
  let gameQQ = uniq([...white.QQ, ...white.bbsQQ])
  let coinQQ = uniq(white.bbsQQ)

  // 关闭自动群/QQ白名单时仍执行游戏群黑名单排除；显式 QQ 名单保留优先权。
  if (level === 'game') {
    const denied = await getGameBlacklistOnlyMembers(white.gameGroup, white.bbsGroup)
    const candidates = candidateQQs === null ? null : uniq(candidateQQs)

    if (!config.whiteGroup && gameQQ.length > 0) {
      if (candidates === null) return gameQQ.filter(qq => !denied.has(qq) || gameQQ.includes(qq))
      return candidates.filter(qq => gameQQ.includes(qq))
    }

    if (candidates === null) {
      if (denied.size === 0) return null
      return []
    }

    if (!config.whiteGroup && gameQQ.length === 0 && denied.size === 0) return null
    if (config.whiteGroup && denied.size === 0) return null

    // 黑名单群成员只在其没有任何非黑名单群成员身份时排除。
    // QQ 白名单（含 QQ米币签到名单）属于显式授权，不受群黑名单影响。
    return candidates.filter(qq => !denied.has(qq) || gameQQ.includes(qq))
  }

  // 米币签到白名单与黑名单独立生效：黑名单优先级最高。
  const coinBlack = new Set(white.bbsQQBlack.map(norm))
  const candidates = candidateQQs === null ? null : uniq(candidateQQs)
  const filterCandidates = values => filterCoinCandidates(values, [...coinBlack], candidates)

  if (!config.whiteGroup) {
    if (white.bbsQQ.length > 0) return filterCandidates(white.bbsQQ)
    if (coinBlack.size > 0 && candidates) return candidates.filter(qq => !coinBlack.has(qq))
    return null
  }

  if (white.bbsGroup.length === 0) {
    if (coinBlack.size > 0 && candidates) return candidates.filter(qq => !coinBlack.has(qq))
    return null
  }

  const allowed = uniq([...(await membersOfGroups(white.bbsGroup)), ...white.bbsQQ])
  return filterCandidates(allowed)

}

export function getWhiteConfig() {
  return getWhite()
}

export function isMaster(qq) {
  return isMasterQQ(qq)
}

export function isCoinBlacklisted(qq) {
  return getWhite().bbsQQBlack.map(norm).includes(norm(qq))
}

export default {
  getPermission,
  hasLevel,
  isBeforeManualTime,
  getMasterTargets,
  getAutoQQs,
  getWhiteConfig,
  isMaster,
  isCoinBlacklisted,
  getGroupMembers,
  membersOfGroups
}
