import md5 from 'md5'
import crypto from 'node:crypto'
import _ from 'lodash'
import fetch from 'node-fetch'
import cfg from '../../../../lib/config/config.js'
import getDeviceFp from '../getDeviceFp.js'
import ApiTool from './apiTool.js'
import { resolveServerType, getGameFromBiz } from './serverType.js'

let HttpsProxyAgent = ''
export default class MysApi {
  /**
   * @param uid 游戏uid
   * @param cookie 米游社cookie
   * @param option 其他参数
   * @param option.log 是否显示日志
   * @param isSr 是否星铁
   * @param device 设备device_id
   */
  constructor(uid, cookie, option = { game: 'gs', device: '' }, Server = '', Biz = '', game = '') {
    this.uid = uid
    this.cookie = cookie

    // 兼容 Miao-Yunzai Runtime 旧调用：new MysApi(uid, cookie, option, isSr)
    if (typeof Server === 'boolean') {
      if (Server) option.game = 'sr'
      Server = ''
    }

    this.game = game || option.game || 'gs'
    this.server = Server || this.getServer()
    this.biz = Biz
    this.deviceProfile = option.deviceProfile || null
    this.deviceFp = option.deviceFp || this.deviceProfile?.deviceFp || ''
    this.apiTool = new ApiTool(this.uid, this.server, this.game, this.biz)
    if (this.deviceProfile?.bbsDeviceId) this.apiTool.uuid = this.deviceProfile.bbsDeviceId
    /** 5分钟缓存 */
    this.cacheCd = 300

    this._device = option.device || this.deviceProfile?.deviceId || this.device
    this.option = {
      log: true,
      ...option
    }

    this.types = [
      'test_nine',
      'recognize',
      'results',
      'in',
      'res',
      'qrCodeLogin',
      'qrCodeQuery',
      'AuthKey',
      'AuthKeyByCookieToken',
      'exchange',
      'getBySToken',
      'material'
    ]

    this.gttypes = [
      'recognize',
      'results'
    ]
  }

  /** ltuid -> 最近一次成功刷新结果，短时复用 */
  static ckRefreshCache = new Map()
  /** ltuid -> 正在执行的刷新任务，防止同账号并发刷新 */
  static ckRefreshTasks = new Map()
  static ckRefreshCacheTtl = 60 * 1000
  /** Stoken 列表短时缓存，避免多账号刷新时重复扫描 YAML */
  static skScanCache = null

  static getLtuid(ck = '') {
    let ret = String(ck || '').match(/(?:ltuid_v2|account_id_v2|ltuid|account_id|stuid)=(\d+)/)
    return ret ? ret[1] : ''
  }

  /** 统一生成 genshin 原版要求的 v2 Cookie 字段 */
  static buildV2Ck({ ltuid, ltoken, cookieToken, mid } = {}) {
    const accountId = String(ltuid ?? '').trim()
    const ltokenValue = String(ltoken ?? '').trim()
    const cookieTokenValue = String(cookieToken ?? '').trim()
    const midValue = String(mid ?? '').trim()
    return `ltuid_v2=${accountId};account_id_v2=${accountId};cookie_token_v2=${cookieTokenValue};ltoken_v2=${ltokenValue};ltmid_v2=${midValue};account_mid_v2=${midValue};`
  }


  /** 将 getData 的底层失败原因转换为可读诊断，避免把路由缺失误报为 Stoken 失效。 */
  static describeExchangeFailure(label, response, api) {
    const error = api?._lastRequestError
    if (error?.kind === 'route_missing') {
      return `${label}失败：API 路由未注册 (game=${error.game}, server=${error.server}, biz=${error.biz}, type=${error.type})`
    }
    if (error?.kind === 'network') {
      return `${label}失败：网络请求异常 (${error.message || '未知网络错误'})`
    }
    if (error?.kind === 'http') {
      return `${label}失败：HTTP ${error.status}${error.statusText ? ` ${error.statusText}` : ''}`
    }
    if (error?.kind === 'invalid_json') {
      return `${label}失败：服务端响应不是有效 JSON (${error.message || '解析失败'})`
    }
    if (error?.kind === 'empty_response') {
      return `${label}失败：服务端返回空响应`
    }
    if (response && response.retcode != null && Number(response.retcode) !== 0) {
      return `${label}失败：Passport 返回 retcode=${response.retcode}${response.message ? `，${response.message}` : ''}`
    }
    if (!response) return `${label}失败：请求未获得有效响应`
    if (!response.data) return `${label}失败：响应缺少 data 字段`
    return `${label}失败：响应中缺少预期的 Token 字段`
  }

  /** 按全部角色元数据解析服别，并统一执行 Stoken -> v2 CK 交换。 */
  static async exchangeStoken(sk, records = []) {
    if (!sk?.stuid || !sk?.stoken || !sk?.mid) {
      return { ok: false, reason: 'Stoken 信息不完整' }
    }

    const roleRecords = (records.length ? records : (sk.roles?.length ? sk.roles : [sk]))
      .map(role => ({
        ...role,
        legacyType: role.legacyType ?? sk.legacyType ?? sk.type
      }))
    const resolution = resolveServerType(roleRecords)
    if (!resolution.type) {
      return {
        ok: false,
        ambiguous: resolution.status === 'conflict',
        reason: resolution.reason || '无法可靠判断 Stoken 所属区服'
      }
    }

    const role = roleRecords.find(item => item.game_biz)
      || roleRecords.find(item => item.region || item.region_name)
      || roleRecords[0]
      || sk
    // 角色原始信息只用于服别识别和记录游戏归属，不直接作为 Passport API 路由参数。
    const roleBiz = role.game_biz || sk.game_biz || ''
    const uid = role.uid || sk.uid || sk.stuid
    const game = getGameFromBiz(roleBiz) || 'gs'

    const skText = sk.sk || `stuid=${sk.stuid};stoken=${sk.stoken};mid=${sk.mid};${sk.ltoken ? `ltoken=${sk.ltoken};` : ''}`

    // Passport 的 Stoken 交换是账号级操作，不应使用 bh3/android01 等角色服区服。
    // 使用稳定、已在 gs API 映射中注册的 Passport 上下文，避免角色 region 导致 exchange 路由缺失。
    const passportServer = resolution.type === 'mys' ? 'cn_gf01' : 'os_usa'
    const passportBiz = resolution.type === 'mys' ? 'hk4e_cn' : 'hk4e_global'
    const { default: DeviceManager } = await import('../device/DeviceManager.js')
    const accountDevice = await DeviceManager.getForAccount(String(sk.stuid), '', {
      game: 'bbs', uid, server: passportServer, biz: passportBiz,
      isOs: resolution.type === 'hoyolab'
    })
    if (!accountDevice?.deviceFp || !accountDevice?.deviceId) {
      return { ok: false, reason: '无法取得该账号的 Genshin 设备档案，已停止 Stoken 交换' }
    }
    const mysApi = new MysApi(
      uid,
      skText,
      {
        game: 'gs', log: false,
        device: accountDevice.deviceId,
        deviceFp: accountDevice.deviceFp,
        deviceProfile: accountDevice.profile
      },
      passportServer,
      passportBiz
    )

    let ltoken = ''
    let cookieToken = ''
    if (resolution.type === 'hoyolab') {
      const res = await mysApi.getData('getBySToken')
      if (!res?.data || (res?.retcode != null && Number(res.retcode) !== 0)) {
        return { ok: false, reason: MysApi.describeExchangeFailure('HoYoLAB Stoken 交换', res, mysApi) }
      }
      const tokens = Array.isArray(res.data.tokens) ? res.data.tokens : []
      ltoken = tokens.find(item => Number(item.token_type) === 2)?.token || tokens[0]?.token || ''
      cookieToken = tokens.find(item => Number(item.token_type) === 4)?.token || tokens[1]?.token || ''
      if (!ltoken || !cookieToken) {
        return { ok: false, reason: 'HoYoLAB Stoken 交换成功响应，但未同时返回 token_type=2 和 token_type=4' }
      }
    } else {
      const ltokenRes = await mysApi.getData('exchange', {
        token: sk.stoken,
        type: 2,
        mid: sk.mid
      })
      if (!ltokenRes?.data?.token?.token || (ltokenRes?.retcode != null && Number(ltokenRes.retcode) !== 0)) {
        return { ok: false, reason: MysApi.describeExchangeFailure('获取 Ltoken', ltokenRes, mysApi) }
      }

      const cookieRes = await mysApi.getData('exchange', {
        token: sk.stoken,
        type: 4,
        mid: sk.mid
      })
      if (!cookieRes?.data?.token?.token || (cookieRes?.retcode != null && Number(cookieRes.retcode) !== 0)) {
        return { ok: false, reason: MysApi.describeExchangeFailure('获取 Cookie Token', cookieRes, mysApi) }
      }
      ltoken = ltokenRes.data.token.token
      cookieToken = cookieRes.data.token.token
    }

    if (!ltoken || !cookieToken) {
      return { ok: false, reason: 'Stoken 交换结果缺少 Ltoken 或 Cookie Token' }
    }

    return {
      ok: true,
      ck: MysApi.buildV2Ck({ ltuid: sk.stuid, ltoken, cookieToken, mid: sk.mid }),
      ltoken,
      cookieToken,
      serverType: resolution.type,
      serverTypeSource: resolution.source,
      game
    }
  }

  static isLoginError(res) {
    if (!res) return false
    let retcode = Number(res.retcode)
    if (![-1, -100, 1001, 10001, 10103].includes(retcode)) return false
    let message = String(res.message || res.data?.message || '')
    return /(登录|login|ck失效|cookie.*(失效|过期|invalid|expired)|token.*(expired|失效|过期))/i.test(message)
  }

  /**
   * 使用已保存的 Stoken 刷新 Cookie。
   * 按 ltuid 合并并发任务；只缓存成功结果，避免短暂失败阻止后续重试。
   */
  static async refreshCk(ck, uid, game, server = '', biz = '') {
    let ltuid = MysApi.getLtuid(ck)
    if (!ltuid) return { ok: false, reason: '无法从 Cookie 解析 ltuid' }

    let now = Date.now()
    for (let [key, value] of MysApi.ckRefreshCache) {
      if (now - value.at >= MysApi.ckRefreshCacheTtl) MysApi.ckRefreshCache.delete(key)
    }
    let cache = MysApi.ckRefreshCache.get(ltuid)
    if (cache) {
      if (Date.now() - cache.at < MysApi.ckRefreshCacheTtl && cache.ret?.ck !== ck) return cache.ret
      MysApi.ckRefreshCache.delete(ltuid)
    }

    if (MysApi.ckRefreshTasks.has(ltuid)) {
      return await MysApi.ckRefreshTasks.get(ltuid)
    }

    let task = MysApi.doRefreshCk(ltuid, uid, game, server, biz)
    MysApi.ckRefreshTasks.set(ltuid, task)
    try {
      let ret = await task
      if (ret?.ok) MysApi.ckRefreshCache.set(ltuid, { at: Date.now(), ret })
      return ret
    } finally {
      MysApi.ckRefreshTasks.delete(ltuid)
    }
  }

  /** 从 YAML Stoken 记录换取 Cookie，并通过 User.bing 校验、保存 */
  static async doRefreshCk(ltuid, uid, game, server = '', biz = '') {
    try {
      const [{ default: Cfg }, { default: MysUser }] = await Promise.all([
        import('../Cfg.js'),
        import('./MysUser.js')
      ])

      let sks
      if (MysApi.skScanCache && Date.now() - MysApi.skScanCache.at < 10 * 1000) {
        sks = MysApi.skScanCache.sks
      } else {
        sks = await Cfg.getsks(true, '', false, true)
        MysApi.skScanCache = { at: Date.now(), sks }
      }

      const candidates = Object.values(sks || {}).filter(item =>
        item && String(item.stuid) === String(ltuid) && item.stoken && item.mid
      )
      if (!candidates.length) return { ok: false, reason: '未找到该账号的 Stoken' }

      const stokens = [...new Set(candidates.map(item => String(item.stoken || '')).filter(Boolean))]
      const mids = [...new Set(candidates.map(item => String(item.mid || '')).filter(Boolean))]
      if (stokens.length !== 1 || mids.length !== 1) {
        return { ok: false, reason: '同一 stuid 存在多份不同 Stoken 或 MID，无法安全自动刷新' }
      }

      // 汇总同一 stuid 在所有 QQ YAML、所有游戏角色中的区服证据。
      const roleRecords = candidates.flatMap(item => {
        const roles = Array.isArray(item.roles) && item.roles.length ? item.roles : [item]
        return roles.map(role => ({
          ...role,
          legacyType: role.legacyType ?? item.legacyType ?? item.type
        }))
      })
      const serverResolution = resolveServerType(roleRecords)
      if (!serverResolution.type) {
        return {
          ok: false,
          reason: serverResolution.reason || '无法可靠判断 Stoken 所属区服，已停止刷新',
          ambiguous: serverResolution.status === 'conflict'
        }
      }

      const supportedGames = ['gs', 'sr', 'zzz', 'wd', 'bh3', 'bh2']
      const requestedGame = supportedGames.includes(game) ? game : ''
      const roleForUid = roleRecords.find(item => item.uid && String(item.uid) === String(uid || ''))
      const roleForBiz = roleRecords.find(item => getGameFromBiz(item.game_biz))
      const selectedRole = roleForUid
        || (requestedGame ? roleRecords.find(item => getGameFromBiz(item.game_biz) === requestedGame) : null)
        || roleForBiz
        || roleRecords.find(item => item.uid || item.region || item.game_biz)
        || roleRecords[0]
        || {}

      // BBS 请求没有游戏 UID；交换过程统一使用共享的服别解析和 Token 交换函数。
      const targetGame = requestedGame || getGameFromBiz(selectedRole.game_biz) || 'gs'
      const mys = await MysUser.create(ltuid)
      if (!mys?.ck) return { ok: false, reason: 'MysUsers 中不存在可更新的 Cookie 记录' }

      const exchange = await MysApi.exchangeStoken({
        ...candidates[0],
        stuid: String(ltuid),
        stoken: stokens[0],
        mid: mids[0],
        roles: roleRecords
      }, roleRecords)
      if (!exchange.ok) return exchange

      const ck = exchange.ck
      const ltoken = exchange.ltoken

      const userIds = [...new Set(candidates.map(item => String(item.userId || '')).filter(Boolean))]
      if (!userIds.length) {
        return { ok: false, reason: 'Stoken 记录缺少绑定 QQ，无法通过 User.bing 保存 Cookie' }
      }

      const { default: User } = await import('../user.js')
      let saved = false
      const bindFailures = []
      for (const userId of userIds) {
        const bindEvent = {
          user_id: userId,
          ck,
          AutoupCookie: true,
          logFnc: `[自动刷新Cookie][ltuid:${ltuid}]`,
          game: targetGame,
          isSr: targetGame === 'sr',
          isZzz: targetGame === 'zzz'
        }
        try {
          if (await new User(bindEvent).bing()) saved = true
          else bindFailures.push(userId)
        } catch (error) {
          bindFailures.push(userId)
          logger.warn(`[自动刷新Cookie][ltuid:${ltuid}][QQ:${userId}]保存失败：${error.message}`)
        }
      }
      if (!saved) {
        return { ok: false, reason: `CK 校验或保存失败${bindFailures.length ? `，QQ：${bindFailures.join(',')}` : ''}` }
      }

      Cfg.updateSkLtoken?.(ltuid, ltoken)
      MysApi.skScanCache = null
      logger.mark(`[自动刷新Cookie][ltuid:${ltuid}]已通过 Stoken 交换并经 User.bing 校验保存 Cookie`)
      return { ok: true, ck, ltuid: String(ltuid), qq: userIds[0], ltoken, serverType: exchange.serverType }
    } catch (error) {
      logger.error(`[自动刷新Cookie][ltuid:${ltuid}]刷新异常：${error.stack || error.message}`)
      return { ok: false, reason: '刷新过程发生异常' }
    }
  }

  /* eslint-disable quotes */
  get device() {
    if (!this._device) this._device = this.getGuid()
    return this._device
  }

  getUrl(type, data = {}) {
    const profile = data.deviceProfile || this.deviceProfile
    if (profile) {
      this.deviceProfile = profile
      this._device = data.deviceId || profile.deviceId || this._device
      this.deviceFp = data.deviceFp || profile.deviceFp || this.deviceFp
      if (profile.bbsDeviceId) this.apiTool.uuid = profile.bbsDeviceId
    }
    const profileData = profile ? {
      productName: profile.deviceProduct,
      deviceType: profile.deviceModel,
      modelName: profile.deviceModel,
      oaid: profile.oaid,
      aaid: profile.aaid,
      vaid: profile.vaid,
      adid: profile.adid,
      appSetId: profile.appSetId,
      bbsDeviceId: profile.bbsDeviceId,
      hoyolabDeviceId: profile.bbsDeviceId,
      seedId: profile.seedId,
      fpDeviceId: profile.fpDeviceId,
      seedFp: profile.seedFp,
      osVersion: profile.androidVersion,
      deviceInfo: profile.deviceFingerprint,
      board: profile.deviceBoard,
      hardware: profile.hardware,
      screenSize: profile.screenSize,
      sdkVersion: profile.sdkVersion,
      packageName: profile.packageName,
      serialNumber: profile.serialNumber,
      buildTime: profile.buildTime,
      buildUser: profile.buildUser,
      ramCapacity: profile.ramCapacity,
      ramRemain: profile.ramRemain,
      romCapacity: profile.romCapacity,
      romRemain: profile.romRemain,
      sdCapacity: profile.sdCapacity,
      sdRemain: profile.sdRemain,
      batteryStatus: profile.batteryStatus,
      accelerometer: profile.accelerometer,
      magnetometer: profile.magnetometer,
      gyroscope: profile.gyroscope,
      appInstallTimeDiff: profile.appInstallTimeDiff,
      appUpdateTimeDiff: profile.appUpdateTimeDiff
    } : {}
    let urlMap = this.apiTool.getUrlMap({ ...profileData, ...data, deviceProfile: profile, deviceId: data.deviceId || this.device })
    if (!urlMap[type]) return false

    let { url, query = '', body = '', config = '', types = '', sign = ''  } = urlMap[type]

    if (query) url += `?${query}`
    if (body) body = JSON.stringify(body)

    this.forumid = data.forumid || ''
    let headers = this.getHeaders(types, query, body, sign)

    if (profile) {
      const osVersion = profile.androidVersion || '13'
      const modelName = profile.deviceModel || 'XQ-BC52'
      const deviceBrand = profile.brand || profile.deviceFingerprint?.split('/')[0] || 'Android'
      const deviceDisplay = profile.deviceFingerprint?.split('/')[3] || 'release'
      headers['x-rpc-device_id'] = profile.deviceId
      headers['x-rpc-device_name'] = profile.deviceName || `${deviceBrand} ${modelName}`
      headers['x-rpc-device_model'] = modelName
      headers['x-rpc-sys_version'] = osVersion
      headers['x-rpc-csm_source'] = 'myself'
      if (headers['User-Agent'] && !/^okhttp\//i.test(headers['User-Agent'])) {
        headers['User-Agent'] = `Mozilla/5.0 (Linux; Android ${osVersion}; ${modelName} Build/${deviceDisplay}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/111.0.5563.116 Mobile Safari/537.36 miHoYoBBS/2.118.1`
      }
    }

    const deviceFp = data.deviceFp || profile?.deviceFp || this.deviceFp
    if (deviceFp) {
      headers['x-rpc-device_fp'] = deviceFp
      this._device_fp = { retcode: 0, data: { device_fp: deviceFp } }
    }
    const deviceId = data.deviceId || profile?.deviceId
    if (deviceId) headers['x-rpc-device_id'] = deviceId

    if (type == 'deviceLogin' || type == 'saveDevice') {
      try {
        headers['x-rpc-sys_version'] = profile?.androidVersion || '13'
        headers['x-rpc-client_type'] = '2'
        headers['x-rpc-channel'] = 'miyousheluodi'
        headers['x-rpc-csm_source'] = 'home'
        headers['Host'] = 'bbs-api.miyoushe.com'
        headers['User-Agent'] = 'okhttp/4.9.3'
        headers['Referer'] = 'https://app.mihoyo.com/'
        headers['DS'] = this.getDs2()
      } catch (error) {
        logger.error(`[genshin]设备信息解析失败：${error.message}`)
      }
    }

    if (type == 'material') {
      headers['x-rpc-client_type'] = '4'
      headers['Referer'] = 'https://bbs-api-os.hoyolab.com/'
    }

    return { url, headers, body, config }
  }

  getServer() {
    const _uid = String(this.uid)
    const isSr = this.game == 'sr'
    const isZzz = this.game == 'zzz'
    const isWd = this.game == 'wd'
    if (isWd) {
      switch (_uid.slice(0, -7)) {
        case '11':
          return 'cn_prod_bb01'// B服
        case '21':
          return 'cn_prod_mix01'// 渠道服(华为)
        case '10':
          return 'tw_prod_wd01'// 台服
        case '20':
          return 'glb_prod_wd01'// 国际服
      }
    } else if (isZzz) {
      switch (_uid.slice(0, -8)) {
        case '10':
          return 'prod_gf_us'// 美服
        case '15':
          return 'prod_gf_eu'// 欧服
        case '13':
          return 'prod_gf_jp'// 亚服
        case '17':
          return 'prod_gf_sg'// 港澳台服
      }
    } else {
      switch (_uid.slice(0, -8)) {
        case '5':
          return isSr ? 'prod_qd_cn' : 'cn_qd01'// B服
        case '6':
          return isSr ? 'prod_official_usa' : 'os_usa'// 美服
        case '7':
          return isSr ? 'prod_official_eur' : 'os_euro'// 欧服
        case '8':
        case '18':
          return isSr ? 'prod_official_asia' : 'os_asia'// 亚服
        case '9':
          return isSr ? 'prod_official_cht' : 'os_cht'// 港澳台服
      }
    }
    return isWd ? 'cn_prod_gf01' : (isZzz || isSr) ? 'prod_gf_cn' : 'cn_gf01'// 官服
  }

  async getData(type, data = {}, cached = false, refreshed = false) {
    this._lastRequestError = null
    if (!refreshed) this._ckRefreshResult = null
    // 保存原始参数用于刷新 Cookie 后重试；后续处理只修改浅拷贝。
    let originData = { ...data }
    data = { ...data }

    // 所有账号设备信息统一由 Genshin DeviceManager 提供；不再读取 ZZZ 命名空间或手动绑定键。
    const explicitProfile = data.deviceProfile || this.option.deviceProfile || null
    if (explicitProfile) {
      data.deviceProfile = explicitProfile
      data.deviceId = explicitProfile.deviceId
      data.deviceFp = explicitProfile.deviceFp
      this.deviceProfile = explicitProfile
      this._device = data.deviceId || this._device
      this.deviceFp = data.deviceFp || this.deviceFp
      if (data.deviceFp) this._device_fp = { retcode: 0, data: { device_fp: data.deviceFp } }
    } else {
      const ltuid = this.game === 'bbs'
        ? (MysApi.getLtuid(this.cookie) || String(this.uid || ''))
        : MysApi.getLtuid(this.cookie)
      if (ltuid && /^\d{4,12}$/.test(String(ltuid))) {
        const device = await getDeviceFp.Fp(this.uid, this.cookie, this.game, this.biz, this.server)
        if (!device?.deviceFp || !device?.deviceId || !device?.profile) {
          logger.error(`[DeviceManager][ltuid:${ltuid}] 无法取得完整设备档案，已中止 ${type} 请求`)
          return false
        }
        data = {
          ...data,
          deviceId: device.deviceId,
          deviceFp: device.deviceFp,
          deviceProfile: device.profile
        }
        this.deviceProfile = device.profile
        this.deviceRecord = device.device || null
        this.deviceLtuid = String(ltuid)
        this._device = device.deviceId
        this.deviceFp = device.deviceFp
        this._device_fp = { retcode: 0, data: { device_fp: device.deviceFp } }
      } else if (type === 'qrCodeLogin' || type === 'qrCodeQuery') {
        const { default: DeviceManager } = await import('../device/DeviceManager.js')
        const session = await DeviceManager.createLoginSession('', { game: 'bbs', server: 'cn_gf01', biz: 'hk4e_cn' })
        this.deviceProfile = session.profile
        this.option.deviceProfile = session.profile
        this.deviceSessionId = session.sessionId
        this._device = session.deviceId
        this.deviceFp = session.deviceFp
        this._device_fp = { retcode: 0, data: { device_fp: session.deviceFp } }
        data = { ...data, deviceId: session.deviceId, deviceFp: session.deviceFp, deviceProfile: session.profile }
      }
    }

    if (!this.types.includes(type)) {
      if (!this._device_fp && !data?.Getfp && !data?.headers?.['x-rpc-device_fp']) {
        this._device_fp = await this.getData('getFp', { ...data, Getfp: true })
      }
      if (type === 'getFp' && !data?.Getfp) return this._device_fp
    }

    let { url, headers, body, config } = this.getUrl(type, data)
    if (!url) {
      this._lastRequestError = {
        kind: 'route_missing',
        type,
        game: this.game,
        server: this.server,
        biz: this.biz
      }
      return false
    }

    let cacheKey = this.cacheKey(type, data)
    let cache = await redis.get(cacheKey)
    if (cache) return JSON.parse(cache)

    let reqCk = this.cookie
    headers.Cookie = this.cookie

    if (data.headers) {
      headers = { ...headers, ...data.headers }
      delete data.headers
    }

    if (type == 'sign' && (data.validate || data.geetest_validate)) {
      headers['x-rpc-challenge'] = data.challenge || data.geetest_challenge
      headers['x-rpc-validate'] = data.validate || data.geetest_validate
      headers['x-rpc-seccode'] = `${data.validate || data.geetest_validate}|jordan`
    }

    if (!this.types.includes(type)) {
      if (type !== 'getFp' && !headers['x-rpc-device_fp'] && this._device_fp?.data?.device_fp) {
        headers['x-rpc-device_fp'] = this._device_fp.data.device_fp
      }
    }

    let param = {
      headers,
      agent: await this.getAgent(),
      timeout: 10000
    }
    if (body) {
      param.method = 'post'
      param.body = body
    } else if (type == 'bbsGetCookie' && !/cn_|_cn/.test(this.server)) {
      param.method = 'post'
    } else {
      param.method = 'get'
    }

    let response = {}
    let start = Date.now()
    if (this.gttypes.includes(type)) {
      param = {
        method: 'post',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: config
      }
    }

    try {
      response = await fetch(url, param)
    } catch (error) {
      this._lastRequestError = {
        kind: 'network',
        message: error?.message || String(error)
      }
      logger.error(error.toString())
      return false
    }

    if (!response.ok) {
      this._lastRequestError = {
        kind: 'http',
        status: response.status,
        statusText: response.statusText
      }
      logger.error(`[米游社接口][${type}][${this.uid}] ${response.status} ${response.statusText}`)
      return false
    }
    if (this.option.log) logger.mark(`[米游社接口][${type}][${this.uid}] ${Date.now() - start}ms`)

    let res
    try {
      res = await response.json()
    } catch (error) {
      this._lastRequestError = {
        kind: 'invalid_json',
        message: error?.message || String(error)
      }
      logger.warn(`[米游社接口][${type}][${this.uid}] 响应 JSON 解析失败：${error?.message || error}`)
      return false
    }
    if (!res || typeof res !== 'object') {
      this._lastRequestError = { kind: 'empty_response' }
      logger.mark('mys接口没有返回有效数据')
      return false
    }

    res.api = type
    if (Number(res.retcode) === 5003 && this.deviceProfile) {
      const profile = this.deviceProfile || {}
      const record = this.deviceRecord || {}
      logger.warn(`[DeviceManager][ltuid:${this.deviceLtuid || 'unknown'}] ${type} 返回 retcode=5003；设备字段长度：deviceId=${String(profile.deviceId || this._device || '').length}, deviceFp=${String(profile.deviceFp || this.deviceFp || '').length}, fpDeviceId=${String(profile.fpDeviceId || '').length}, seedFp=${String(profile.seedFp || '').length}, registrationId=${String(profile.registrationId || '').length}；registered=${Boolean(record.registeredAt)}, registerAttempted=${Boolean(record.registerAttemptAt)}, cookieTokenPresent=${/(?:^|[;\s&])cookie_token(?:_v2)?=/.test(String(this.cookie || ''))}`)
    }
    if (cached) this.cache(res, cacheKey)

    // 社区签到使用 SK，不能换成 CK 重试；保留原始登录失效结果。
    const isBbsSk = this.game === 'bbs' && /(?:^|;)\s*stoken\s*=/.test(reqCk)
    // 只有实际游戏 Cookie 请求才尝试自动刷新；Stoken 交换接口本身不能递归刷新。
    if (!isBbsSk && !refreshed && !/exchange|getBySToken/.test(type) && MysApi.isLoginError(res)) {
      let refresh = await MysApi.refreshCk(reqCk, this.uid, this.game, this.server, this.biz)
      this._ckRefreshResult = refresh
      if (refresh?.ok && refresh.ck && refresh.ck !== reqCk) {
        this.cookie = refresh.ck
        return await this.getData(type, originData, cached, true)
      }
      if (refresh?.ok && refresh.ck === reqCk) {
        this._ckRefreshResult = { ...refresh, ok: false, reason: '刷新后 Cookie 未发生变化' }
      }
      if (!this._ckRefreshResult?.ok && refresh?.reason) {
        logger.mark(`[自动刷新Cookie][uid:${this.uid}]${refresh.reason}`)
      }
    }

    return res
  }

  getHeaders(types, query = '', body = '', sign = false) {
    const profile = this.deviceProfile || {}
    const osVersion = profile.androidVersion || '13'
    const modelName = profile.deviceModel || 'XQ-BC52'
    const deviceName = profile.deviceName || 'Sony XQ-BC52'
    const buildId = profile.deviceFingerprint?.split('/')[3] || '61.2.A.0.472A'
    const androidAgent = `Mozilla/5.0 (Linux; Android ${osVersion}; ${modelName} Build/${buildId}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/111.0.5563.116 Mobile Safari/537.36`
    const header = {
      'x-rpc-app_version': '2.118.1',
      'x-rpc-client_type': '5',
      'x-rpc-device_id': this._device,
      'User-Agent': `${androidAgent} miHoYoBBS/2.118.1`,
      Referer: 'https://act.mihoyo.com/'
    }

    const header_os = {
      'x-rpc-app_version': '4.23.0',
      'x-rpc-client_type': '2',
      'x-rpc-device_id': this._device,
      'User-Agent': `${androidAgent} miHoYoBBSOversea/4.23.0`,
      Referer: 'https://act.hoyolab.com/'
    }

    const header_bbs = {
      'x-rpc-app_version': '2.118.1',
      'x-rpc-channel': 'miyousheluodi',
      'x-rpc-client_type': '2',
      Referer: 'https://app.mihoyo.com/',
      'User-Agent': 'okhttp/4.9.3',
      'x-rpc-device_id': this._device,
      'x-rpc-device_model': modelName,
      'x-rpc-device_name': deviceName,
      'x-rpc-sys_version': osVersion
    }

    let client
    if (/_cn/.test(this.biz) || /cn_|_cn/.test(this.server)) {
      client = header
    } else {
      client = header_os
    }

    let signgame = this.game == 'gs' ? 'hk4e' : this.game == 'sr' ? 'hkrpg' : this.game == 'zzz' ? 'zzz' : this.game == 'bh3' ? 'bh3' : this.game == 'bh2' ? 'bh2' : 'nxx'
    let x_rpc = {
      'x-rpc-device_model': modelName,
      'x-rpc-device_name': deviceName,
      'x-rpc-sys_version': osVersion,
      'x-rpc-signgame': signgame,
      'x-rpc-platform': 'android'
    }

    switch (types) {
      // 细分签到
      case 'sign':
        if (/_cn/.test(this.biz) || /cn_|_cn/.test(this.server))
          return {
            ...header,
            ...x_rpc,
            'X-Requested-With': 'com.mihoyo.hyperion',
            'x-rpc-channel': 'miyousheluodi',
            DS: this.SignDs()
          }
        else
          return {
            ...header_os,
            ...x_rpc,
            'X-Requested-With': 'com.mihoyo.hoyolab',
            'x-rpc-channel': 'google',
            DS: this.SignDs()
          }
      case 'bbs':
        return {
          ...header_bbs,
          DS: (sign ? this.bbsDs(query, body) : this.SignDs("7a047e46eadd8693f09513e55bdf6bd8"))
        }
      case 'qrcode':
        return {
          'Host': 'passport-api.miyoushe.com',
          'x-rpc-device_os': `Android ${this.deviceProfile?.androidVersion || '13'}`,
          'x-rpc-lifecycle_id': this.deviceProfile?.bbsDeviceId || crypto.randomUUID(),
          'x-rpc-app_id': 'bll8iq97cem8',
          'x-rpc-device_id': this._device,
          'x-rpc-device_name': this.deviceProfile?.deviceName || 'Android',
          'x-rpc-device_fp': this.deviceFp || this.deviceProfile?.deviceFp || '',
          'x-rpc-client_type': '2',
          'x-rpc-game_biz': 'bbs_cn',
          'x-rpc-sdk_version': '1.3.1.2',
          'x-rpc-device_model': this.deviceProfile?.deviceModel || 'Android',
          'Content-Type': 'application/json',
          'User-Agent': `okhttp/4.8.0`,
          'Connection': 'Keep-Alive',
          'Accept-Encoding': 'gzip, deflate, br'
        }
      case 'hoyocode':
        return {
          ...header_os
        }
      case 'authkey':
        return {
          ...header_bbs,
          DS: this.getDs2()
        }
      case 'exchange':
        return {
          ...header,
          'x-rpc-device_fp': this.deviceFp || this.deviceProfile?.deviceFp || '',
          'x-rpc-device_name': this.deviceProfile?.deviceName || 'Android',
          'x-rpc-device_model': this.deviceProfile?.deviceModel || 'Android',
          'x-rpc-app_id': 'bll8iq97cem8'
        }
      case 'getBySToken':
        return {
          ...header_os,
          'x-rpc-app_id': 'c9oqaq3s3gu8'
        }
      case 'noheader':
        return {}
    }
    return {
      ...client,
      DS: this.getDs(query, body)
    }
  }

  getDs(q = '', b = '') {
    let n = ''
    if (/_cn/.test(this.biz) || /cn_|_cn/.test(this.server)) {
      n = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'
    } else {
      n = 'okr4obncj8bw5a65hbnn5oo6ixjc3l9w'
    }
    let t = Math.round(new Date().getTime() / 1000)
    let r = Math.floor(Math.random() * 900000 + 100000)
    let DS = md5(`salt=${n}&t=${t}&r=${r}&b=${b}&q=${q}`)
    return `${t},${r},${DS}`
  }

  getDs2() {
    let t = Math.round(new Date().getTime() / 1000)
    let r = this.randomString(6)
    let DS = md5(`salt=WGtruoQrwczmsjLOPXzJLnaAYycsLavx&t=${t}&r=${r}`)
    return `${t},${r},${DS}`
  }

  bbsDs(q = "", b, salt = "t0qEgfub6cvueAPgR5m9aQWWVciEer7v") {
    let t = Math.floor(Date.now() / 1000)
    let r = _.random(100001, 200000)
    let DS = md5(`salt=${salt}&t=${t}&r=${r}&b=${b}&q=${q}`)
    return `${t},${r},${DS}`
  }

  SignDs(salt = 'jEpJb9rRARU2rXDA9qYbZ3selxkuct9a') {
    const t = Math.floor(Date.now() / 1000)
    let r = this.randomString(6)
    const DS = md5(`salt=${salt}&t=${t}&r=${r}`)
    return `${t},${r},${DS}`
  }

  getGuid() {
    return crypto.randomUUID().toLowerCase()
  }

  randomString(length = 32) {
    let randomStr = ''
    for (let i = 0; i < length; i++) {
      randomStr += _.sample('abcdefghijklmnopqrstuvwxyz0123456789')
    }
    return randomStr
  }

  cacheKey(type, data) {
    return 'Yz:genshin:mys:cache:' + md5(this.uid + type + JSON.stringify(data))
  }

  async cache(res, cacheKey) {
    if (!res || res.retcode !== 0) return
    redis.setEx(cacheKey, this.cacheCd, JSON.stringify(res))
  }

  async getAgent() {
    let proxyAddress = cfg.bot.proxyAddress
    if (!proxyAddress) return null
    if (proxyAddress === 'http://0.0.0.0:0') return null

    if (/_cn/.test(this.biz) || /cn_|_cn/.test(this.server)) return null

    if (HttpsProxyAgent === '') {
      HttpsProxyAgent = await import('https-proxy-agent').catch((err) => {
        logger.error(err)
      })

      HttpsProxyAgent = HttpsProxyAgent ? HttpsProxyAgent.HttpsProxyAgent : undefined
    }

    if (HttpsProxyAgent) {
      return new HttpsProxyAgent(proxyAddress)
    }

    return null
  }
}
