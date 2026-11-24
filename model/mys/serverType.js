/**
 * 统一解析 Stoken 对应的服务区类型。
 * 优先使用 game_biz，其次使用 region_name / region；
 * 只有缺少可靠证据时才回退到历史 type。
 * 多个可靠字段互相冲突时返回 conflict，调用方不得猜测。
 */

function clean(value) {
  return String(value ?? '').trim()
}

function classifyBiz(value) {
  const biz = clean(value).toLowerCase()
  if (!biz) return null
  if (/(?:^|_)cn$/.test(biz)) return 'mys'
  if (/(?:^|_)(?:global|tw|os)$/.test(biz)) return 'hoyolab'
  return null
}

function classifyRegionName(value) {
  const name = clean(value).toLowerCase()
  if (!name) return null

  if (/(国服|中国大陆|大陆服|天空岛|世界树|b服|渠道服|安卓国服|ios国服|官服)/i.test(name)) {
    return 'mys'
  }
  if (/(国际服|海外服|美服|欧服|亚服|港澳台|台服|北美服|欧洲服|东南亚服|日本服|韩国服)/i.test(name)) {
    return 'hoyolab'
  }

  // 部分角色接口返回英文区服名称。
  if (/^(america|north america|europe|asia|tw\/hk\/mo|taiwan|hong kong|macau)(?: server)?$/i.test(name)) {
    return 'hoyolab'
  }
  if (/^(mainland china|china mainland|cn server)$/i.test(name)) {
    return 'mys'
  }
  return null
}

function classifyRegion(value, gameBiz = '') {
  const region = clean(value).toLowerCase()
  const biz = clean(gameBiz).toLowerCase()
  if (!region) return null

  // 常见国服服务器标识。
  if (
    /^cn_/.test(region) ||
    /_cn$/.test(region) ||
    /^prod_(?:gf|qd)_cn$/.test(region) ||
    /^cn_prod_(?:gf|bb|mix)\d+$/i.test(region)
  ) {
    return 'mys'
  }

  // 常见国际服服务器标识。
  if (
    /^os_/.test(region) ||
    /^prod_official_/.test(region) ||
    /^prod_gf_(?:us|eu|jp|sg)$/.test(region) ||
    /^tw_prod_/.test(region) ||
    /^glb_prod_/.test(region)
  ) {
    return 'hoyolab'
  }

  // 崩坏3的 android01 / ios01 等命名不带 cn 后缀，
  // 只有在 game_biz 明确指向崩坏3时才将这些区服映射为国服。
  if (/^bh3(?:_|$)/.test(biz) && /^(?:android|ios|pc|bilibili)01$/.test(region)) {
    return 'mys'
  }

  return null
}

function classifyLegacyType(value) {
  const type = clean(value).toLowerCase()
  if (['mys', 'cn', 'mihoyo', 'miyoushe'].includes(type)) return 'mys'
  if (['hoyolab', 'global', 'oversea', 'os'].includes(type)) return 'hoyolab'
  return null
}

export function getGameFromBiz(value) {
  const biz = clean(value).toLowerCase()
  if (biz.startsWith('hk4e')) return 'gs'
  if (biz.startsWith('hkrpg')) return 'sr'
  if (biz.startsWith('nap')) return 'zzz'
  if (biz.startsWith('bh3')) return 'bh3'
  if (biz.startsWith('bh2')) return 'bh2'
  if (biz.startsWith('nxx')) return 'wd'
  return ''
}

export function resolveServerType(records = []) {
  const list = (Array.isArray(records) ? records : [records]).filter(Boolean)
  const evidence = []

  for (const record of list) {
    const biz = clean(record.game_biz)
    const regionName = clean(record.region_name)
    const region = clean(record.region)
    const legacyType = record.legacyType ?? record.rawType ?? record.type

    const bizType = classifyBiz(biz)
    const nameType = classifyRegionName(regionName)
    const regionType = classifyRegion(region, biz)

    if (bizType) evidence.push({ source: 'game_biz', value: biz, type: bizType })
    if (nameType) evidence.push({ source: 'region_name', value: regionName, type: nameType })
    if (regionType) evidence.push({ source: 'region', value: region, type: regionType })
  }

  const strongTypes = [...new Set(evidence.map(item => item.type))]
  if (strongTypes.length > 1) {
    const detail = evidence.map(item => `${item.source}=${item.value}(${item.type})`).join('；')
    return {
      type: '',
      status: 'conflict',
      source: '',
      reason: `服别信息冲突：${detail}`
    }
  }

  if (strongTypes.length === 1) {
    const type = strongTypes[0]
    const sources = [...new Set(evidence.filter(item => item.type === type).map(item => item.source))]
    return {
      type,
      status: 'resolved',
      source: sources.join('+'),
      reason: ''
    }
  }

  const legacyTypes = [...new Set(list.map(record =>
    classifyLegacyType(record.legacyType ?? record.rawType ?? record.type)
  ).filter(Boolean))]

  if (legacyTypes.length > 1) {
    return {
      type: '',
      status: 'conflict',
      source: '',
      reason: '缺少可靠区服信息，历史 type 字段彼此冲突'
    }
  }

  if (legacyTypes.length === 1) {
    return {
      type: legacyTypes[0],
      status: 'fallback',
      source: 'legacy type',
      reason: ''
    }
  }

  return {
    type: '',
    status: 'unknown',
    source: '',
    reason: '缺少可识别的 game_biz、region_name、region 和历史 type'
  }
}
