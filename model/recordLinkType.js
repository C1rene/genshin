/**
 * 识别抽卡/充值记录链接类型。
 *
 * 设计原则：
 * 1. `hkrpg` 只能说明这是星铁相关链接，不能说明它是充值链接。
 * 2. 抽卡链接优先识别，避免 webview_gacha authkey 被充值模块抢走。
 * 3. 星铁充值必须同时满足“星铁特征 + 充值业务特征”。
 * 4. 对未知但带 authkey 的链接不武断分类，交给原有业务自行校验。
 */
export function inspectRecordLink (message = '') {
  const text = String(message || '').replace(/〈=/g, '&').trim()
  const urlMatch = text.match(/https?:\/\/[^\s\u4e00-\u9fa5<>"']+/i)
  const raw = urlMatch?.[0] || text

  let hostname = ''
  let pathname = ''
  let searchParams

  try {
    const url = new URL(raw)
    hostname = url.hostname.toLowerCase()
    pathname = url.pathname.toLowerCase()
    searchParams = url.searchParams
  } catch (error) {
    // 兼容只复制 query 参数、或被聊天客户端裁掉协议/域名的情况。
    const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw
    searchParams = new URLSearchParams(query)
  }

  const authkey = searchParams.get('authkey') || ''
  const authAppid = (searchParams.get('auth_appid') || '').toLowerCase()
  const gameBiz = (searchParams.get('game_biz') || '').toLowerCase()
  const region = searchParams.get('region') || ''
  const lowerRaw = raw.toLowerCase()

  // 抽卡业务特征。只要明确命中，就优先按抽卡处理。
  const isGacha =
    authAppid === 'webview_gacha' ||
    /(?:\/|\b)(?:gacha_record|gacha_info)(?:\/|\b)/i.test(pathname || lowerRaw) ||
    /get(?:ld)?gachalog/i.test(lowerRaw)

  // hkrpg 本身只用于确认“星铁”，绝不能单独作为充值判据。
  const isStarRail =
    gameBiz.includes('hkrpg') ||
    hostname.includes('hkrpg') ||
    pathname.includes('/hkrpg/') ||
    lowerRaw.includes('/hkrpg/')

  // 充值/自助查询业务特征。
  const hasPayMarker =
    authAppid === 'csc' ||
    lowerRaw.includes('self-help-query') ||
    lowerRaw.includes('hkrpg_self_help_inquiry') ||
    lowerRaw.includes('user-game-search') ||
    lowerRaw.includes('bill-record-user') ||
    lowerRaw.includes('customer-claim') ||
    lowerRaw.includes('player-log')

  // 必须同时是“星铁 + 充值业务”，并且不能已经被识别成抽卡。
  const isSrPay = !isGacha && isStarRail && hasPayMarker

  return {
    raw,
    authkey,
    authAppid,
    gameBiz,
    region,
    isGacha,
    isStarRail,
    isSrPay
  }
}
