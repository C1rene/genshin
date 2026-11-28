import crypto from 'node:crypto'
import fetch from 'node-fetch'

const SESSION_TTL = 15 * 60
// Device FP 每 7 天自动刷新；Date.now() 与 fpUpdatedAt 均使用毫秒。
const FP_REFRESH_INTERVAL = 7 * 24 * 60 * 60 * 1000
const ACCOUNT_PREFIX = 'genshin:device'
const LEGACY_PREFIX = 'genshin:device_fp'
const UNIQUE_PREFIX = 'genshin:device:unique'
const LOCK_PREFIX = 'genshin:device:lock'

// 设备型号按模板选择，硬件、系统、build fingerprint 保持内部一致。
// 每份档案另行生成独立标识，不会因为型号模板相同而共享设备身份。
const DEVICE_TEMPLATES = [
  {
    brand: 'Sony', deviceName: 'Sony Xperia 1 V', deviceModel: 'XQ-DQ72', deviceProduct: 'pdx234',
    deviceBoard: 'taro', androidVersion: '14', sdkVersion: '34', hardware: 'qcom', screenSize: '1644x3840',
    deviceFingerprint: 'Sony/pdx234/pdx234:14/67.1.A.2.220/067001A002220:user/release-keys',
    packageName: 'com.mihoyo.hyperion'
  },
  {
    brand: 'Xiaomi', deviceName: 'Xiaomi 14', deviceModel: '23127PN0CC', deviceProduct: 'houji',
    deviceBoard: 'kalama', androidVersion: '14', sdkVersion: '34', hardware: 'qcom', screenSize: '1200x2670',
    deviceFingerprint: 'Xiaomi/houji/houji:14/UKQ1.231003.002/V816.0.12.0.UNCCNXM:user/release-keys',
    packageName: 'com.mihoyo.hyperion'
  },
  {
    brand: 'OnePlus', deviceName: 'OnePlus 12', deviceModel: 'CPH2581', deviceProduct: 'waffle',
    deviceBoard: 'kalama', androidVersion: '14', sdkVersion: '34', hardware: 'qcom', screenSize: '1440x3168',
    deviceFingerprint: 'OnePlus/waffle/waffle:14/UKQ1.230924.001/R.202401151930:user/release-keys',
    packageName: 'com.mihoyo.hyperion'
  },
  {
    brand: 'Samsung', deviceName: 'Samsung Galaxy S24 Ultra', deviceModel: 'SM-S9280', deviceProduct: 'e3q',
    deviceBoard: 'kalama', androidVersion: '14', sdkVersion: '34', hardware: 'qcom', screenSize: '1440x3120',
    deviceFingerprint: 'samsung/e3qzcx/e3q:14/UP1A.231005.007/S9280ZCU1AXA1:user/release-keys',
    packageName: 'com.mihoyo.hyperion'
  },
  {
    brand: 'Google', deviceName: 'Google Pixel 8 Pro', deviceModel: 'GC3VE', deviceProduct: 'husky',
    deviceBoard: 'zuma', androidVersion: '14', sdkVersion: '34', hardware: 'tensor', screenSize: '1344x2992',
    deviceFingerprint: 'google/husky/husky:14/AP1A.240305.019.A1/115984:user/release-keys',
    packageName: 'com.mihoyo.hyperion'
  }
]

const uuid = () => crypto.randomUUID().toLowerCase()
const hex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex')
// The upstream getFp payload uses fixed-width hexadecimal seed fields.
const hexChars = (length = 16) => crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length)
const pick = (items) => items[crypto.randomInt(0, items.length)]
const int = (min, max) => crypto.randomInt(min, max + 1)
const decimal = (min, max, places = 6) => (min + Math.random() * (max - min)).toFixed(places)
const accountKey = (ltuid) => `${ACCOUNT_PREFIX}:${ltuid}:profile`
const sessionKey = (sessionId) => `${ACCOUNT_PREFIX}:session:${sessionId}`
const uniqueKey = (kind, value) => `${UNIQUE_PREFIX}:${kind}:${value}`

function parseJson(value) {
  if (!value) return null
  try { return JSON.parse(value) } catch { return null }
}

function makeProfile(deviceId = '') {
  const template = pick(DEVICE_TEMPLATES)
  const id = deviceId || uuid()
  const now = Date.now()
  const installDiff = int(1000000000000, 1800000000000)
  return {
    version: 1,
    profileId: uuid(),
    deviceId: id,
    deviceFp: '',
    deviceName: template.deviceName,
    deviceModel: template.deviceModel,
    deviceProduct: template.deviceProduct,
    deviceBoard: template.deviceBoard,
    androidVersion: template.androidVersion,
    sdkVersion: template.sdkVersion,
    hardware: template.hardware,
    screenSize: template.screenSize,
    deviceFingerprint: template.deviceFingerprint,
    brand: template.brand,
    packageName: template.packageName,
    // 生成接口所需的各类独立设备标识。
    oaid: uuid(),
    aaid: uuid(),
    vaid: uuid(),
    adid: uuid(),
    appSetId: uuid(),
    bbsDeviceId: uuid(),
    seedId: uuid(),
    fpDeviceId: hexChars(16),
    seedFp: hexChars(13),
    registrationId: hexChars(19),
    serialNumber: hex(8),
    buildTime: String(int(1680000000000, now)),
    buildUser: `user_${hex(3)}`,
    ramCapacity: String(int(180000, 260000)),
    ramRemain: String(int(150000, 220000)),
    romCapacity: String(int(700, 1024)),
    romRemain: String(int(600, 900)),
    sdCapacity: int(200000, 300000),
    sdRemain: int(180000, 290000),
    batteryStatus: int(35, 100),
    accelerometer: `${decimal(-9, 9)}x${decimal(-9, 9)}x${decimal(-9, 9)}`,
    magnetometer: `${decimal(-80, 80, 5)}x${decimal(-80, 80, 5)}x${decimal(-180, 180, 5)}`,
    gyroscope: `${decimal(-1, 1)}x${decimal(-1, 1)}x${decimal(-1, 1)}`,
    appInstallTimeDiff: installDiff,
    appUpdateTimeDiff: installDiff + int(1000, 900000),
    createdAt: now,
    updatedAt: now
  }
}

function toApiData(profile) {
  return {
    deviceId: profile.deviceId,
    deviceFp: profile.deviceFp || undefined,
    deviceProfile: profile,
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
    registrationId: profile.registrationId,
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
  }
}


export default class DeviceManager {
  static async getLtuid(value = '', allowUid = false) {
    const text = String(value || '')
    const match = text.match(/(?:^|[;\s&])(?:ltuid_v2|account_id_v2|ltuid|account_id|stuid)=(\d+)/)
    if (match?.[1]) return match[1]
    if (allowUid) {
      const uidMatch = text.match(/(?:^|[;\s&])uid=(\d+)/)
      if (uidMatch?.[1]) return uidMatch[1]
    }
    return /^\d{4,12}$/.test(text.trim()) ? text.trim() : ''
  }

  static async reserve(kind, value, owner) {
    if (!value) return false
    const key = uniqueKey(kind, value)
    const current = await redis.get(key)
    if (current && String(current) !== String(owner)) return false
    if (String(current || '') === String(owner)) return true
    const result = await redis.set(key, String(owner), { NX: true })
    if (result === 'OK' || result === true || result === 1) return true
    return String(await redis.get(key) || '') === String(owner)
  }

  static getUniqueProfileFields(profile) {
    return [
      ['profileId', profile.profileId], ['deviceId', profile.deviceId], ['serialNumber', profile.serialNumber], ['registrationId', profile.registrationId], ['oaid', profile.oaid], ['aaid', profile.aaid],
      ['vaid', profile.vaid], ['adid', profile.adid], ['appSetId', profile.appSetId],
      ['bbsDeviceId', profile.bbsDeviceId], ['seedId', profile.seedId], ['seedFp', profile.seedFp], ['fpDeviceId', profile.fpDeviceId], ['deviceFp', profile.deviceFp]
    ]
  }

  // Migrate profiles created by the first refactor, which mistakenly used byte
  // counts where the upstream payload expects character counts (16/13/19).
  static needsFpSeedMigration(profile = {}) {
    return String(profile.fpDeviceId || '').length !== 16
      || String(profile.seedFp || '').length !== 13
      || String(profile.registrationId || '').length !== 19
  }

  static async reserveProfile(profile, owner) {
    for (const [kind, value] of this.getUniqueProfileFields(profile)) {
      if (value && !await this.reserve(kind, value, owner)) return false
    }
    return true
  }

  static async transferProfileReservation(profile, fromOwner, toOwner) {
    for (const [kind, value] of this.getUniqueProfileFields(profile)) {
      if (!value) continue
      const key = uniqueKey(kind, value)
      const currentOwner = await redis.get(key)
      if (currentOwner === toOwner) continue
      if (currentOwner === fromOwner) {
        await redis.set(key, toOwner)
        continue
      }
      if (!currentOwner) {
        const result = await redis.set(key, toOwner, { NX: true })
        if (result === 'OK' || result === true || result === 1 || String(await redis.get(key) || '') === String(toOwner)) continue
      }
      return false
    }
    return true
  }

  static async requestDeviceFp(profile, options = {}) {
    const { default: MysApi } = await import('../mys/mysApi.js')
    const game = ['gs', 'sr', 'zzz', 'bh3', 'bh2', 'wd', 'bbs'].includes(options.game) ? options.game : 'bbs'
    const server = options.server || (options.isOs ? 'os_usa' : 'cn_gf01')
    const biz = options.biz || (options.isOs ? 'hk4e_global' : 'hk4e_cn')
    const uid = String(options.uid || options.ltuid || '100000001')
    const api = new MysApi(uid, options.cookie || '', {
      game,
      log: false,
      device: profile.deviceId,
      deviceProfile: profile
    }, server, biz)
    const sdk = api.getUrl('getFp', toApiData(profile))
    if (!sdk?.url || !sdk?.body) throw new Error('Genshin getFp 请求构造失败')
    const response = await fetch(sdk.url, {
      method: 'POST',
      headers: sdk.headers,
      body: sdk.body,
      timeout: 12000
    })
    if (!response.ok) throw new Error(`getFp HTTP ${response.status}`)
    const result = await response.json()
    const deviceFp = result?.data?.device_fp
    if (!deviceFp) throw new Error(`getFp 未返回 device_fp：${result?.message || result?.retcode || 'unknown'}`)
    return String(deviceFp)
  }

  static async createUniqueProfile(owner, options = {}, preferredDeviceId = '') {
    let lastError
    for (let attempt = 0; attempt < 8; attempt++) {
      const profile = makeProfile(attempt === 0 ? preferredDeviceId : '')
      profile.packageName = options.isOs ? 'com.mihoyo.hoyolab' : 'com.mihoyo.hyperion'
      if (!await this.reserveProfile(profile, owner)) continue
      try {
        profile.deviceFp = await this.requestDeviceFp(profile, options)
        if (!await this.reserve('deviceFp', profile.deviceFp, owner)) {
          lastError = new Error('服务端返回了已分配给其他账号的 Device FP，正在重新申请')
          continue
        }
        profile.updatedAt = Date.now()
        return profile
      } catch (error) {
        lastError = error
        // 请求失败不使用固定 FP 兜底；保留已发起请求的标识，避免之后复用。
        if (attempt >= 2) break
      }
    }
    throw lastError || new Error('无法生成全局唯一的设备档案')
  }

  static async withAccountLock(ltuid, fn) {
    const key = `${LOCK_PREFIX}:${ltuid}`
    const token = uuid()
    for (let attempt = 0; attempt < 900; attempt++) {
      const result = await redis.set(key, token, { NX: true, EX: 90 })
      if (result === 'OK' || result === true || result === 1) {
        try { return await fn() } finally {
          if (String(await redis.get(key) || '') === token) await redis.del(key)
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`获取账号设备锁超时：${ltuid}`)
  }

  static async readAccount(ltuid) {
    return parseJson(await redis.get(accountKey(ltuid)))
  }

  static async writeAccount(ltuid, record) {
    await redis.set(accountKey(ltuid), JSON.stringify(record))
    // 旧 Genshin FP 键仅作为兼容镜像，由 DeviceManager 单向维护。
    await redis.set(`${LEGACY_PREFIX}:${ltuid}:fp`, record.deviceFp)
    // 旧手动绑定入口已废弃，清除 Genshin 自身旧键中的残留覆盖项。
    await redis.del(`${LEGACY_PREFIX}:${ltuid}:id`)
    await redis.del(`${LEGACY_PREFIX}:${ltuid}:bind`)
  }

  static async saveMysUserDevice(ltuid, deviceId) {
    try {
      const { default: MysUser } = await import('../mys/MysUser.js')
      const mysUser = await MysUser.create(String(ltuid))
      if (mysUser && mysUser.device !== deviceId) {
        mysUser.setCkData({ device: deviceId })
        await mysUser.save()
      }
      return mysUser
    } catch (error) {
      logger.warn(`[DeviceManager][ltuid:${ltuid}] MysUser.device 保存失败：${error.message}`)
      return false
    }
  }


  static isCookieToken(cookie = '') {
    const value = String(cookie || '')
    return /(?:^|[;\s&])(?:ltuid_v2|account_id_v2|ltuid|account_id)=\d+/.test(value)
      && /(?:^|[;\s&])cookie_token(?:_v2)?=/.test(value)
  }

  static async ensureRegistered(ltuid, cookie, record, options = {}) {
    if (!this.isCookieToken(cookie) || record?.registeredAt) return false
    const now = Date.now()
    if (record?.registerAttemptAt && now - record.registerAttemptAt < 6 * 60 * 60 * 1000) return false
    record.registerAttemptAt = now
    await this.writeAccount(ltuid, record)
    const registered = await this.registerDevice(ltuid, cookie, record, options)
    if (registered) record.registeredAt = Date.now()
    await this.writeAccount(ltuid, record)
    return registered
  }

  static async getForAccount(ltuid, cookie = '', options = {}) {
    ltuid = String(ltuid || await this.getLtuid(cookie) || '').trim()
    if (!/^\d{4,12}$/.test(ltuid)) return null
    const record = await this.withAccountLock(ltuid, async () => {
      let record = await this.readAccount(ltuid)
      const owner = record?.reservationOwner || `ltuid:${ltuid}`
      if (record?.deviceId && record?.deviceFp && record?.profile) {
        record.profile.ltuid = String(ltuid)
        record.profile.deviceId = record.deviceId
        record.profile.deviceFp = record.deviceFp
        const unique = await this.reserveProfile({ ...record.profile, deviceId: record.deviceId, deviceFp: record.deviceFp }, owner)
        if (unique) {
          if (!record.fpUpdatedAt) {
            record.fpUpdatedAt = record.updatedAt || record.createdAt || Date.now()
            await this.writeAccount(ltuid, record)
          }
          await this.saveMysUserDevice(ltuid, record.deviceId)
          if (!this.needsFpSeedMigration(record.profile)) {
            await this.ensureRegistered(ltuid, cookie, record, { server: record.server || options.server, biz: record.biz || options.biz, isOs: record.isOs || options.isOs, uid: options.uid || record.uid })
          } else {
            logger.warn(`[DeviceManager][ltuid:${ltuid}] 检测到旧版 getFp 种子字段长度不兼容，将在本次读取中迁移并重新申请 Device FP`)
          }
          return record
        }
        logger.warn(`[DeviceManager][ltuid:${ltuid}] 发现重复设备标识，重新生成账号设备档案`)
      }

      const { default: MysUser } = await import('../mys/MysUser.js')
      const mysUser = await MysUser.create(ltuid)
      const preferredDeviceId = mysUser?.device || ''
      const selectedGame = options.game || (mysUser?.uids?.gs?.[0] ? 'gs' : mysUser?.uids?.sr?.[0] ? 'sr' : mysUser?.uids?.zzz?.[0] ? 'zzz' : 'bbs')
      const selectedUid = options.uid || mysUser?.uids?.[selectedGame]?.[0] || ltuid
      const isOs = options.isOs || mysUser?.type === 'hoyolab' || /(?:os_(?:usa|euro|asia|cht)|prod_(?:official_(?:usa|eur|asia|cht|tw|hk|kr)|gf_(?:us|usa|eu|eur|jp|sg|asia|cht|tw|hk|kr))|global)/i.test(`${options.server || ''} ${options.biz || ''}`)
      const server = isOs
        ? (options.server && !/(?:cn_|_cn|prod_gf_cn)/i.test(options.server) ? options.server : 'os_usa')
        : (options.server || 'cn_gf01')
      const defaultBiz = {
        gs: isOs ? 'hk4e_global' : 'hk4e_cn',
        sr: isOs ? 'hkrpg_global' : 'hkrpg_cn',
        zzz: isOs ? 'nap_global' : 'nap_cn',
        bh3: isOs ? 'bh3_global' : 'bh3_cn',
        bh2: isOs ? 'bh2_global' : 'bh2_cn',
        wd: isOs ? 'wd_global' : 'wd_cn',
        bbs: isOs ? 'hk4e_global' : 'hk4e_cn'
      }[selectedGame] || (isOs ? 'hk4e_global' : 'hk4e_cn')
      const biz = isOs
        ? (options.biz && !/_cn$/i.test(options.biz) ? options.biz : defaultBiz)
        : (options.biz || defaultBiz)
      const profile = await this.createUniqueProfile(`ltuid:${ltuid}`, {
        ...options,
        uid: selectedUid,
        ltuid,
        cookie,
        game: selectedGame,
        server,
        biz,
        isOs
      }, preferredDeviceId)
      profile.ltuid = String(ltuid)
      record = {
        version: 1,
        ltuid,
        deviceId: profile.deviceId,
        deviceFp: profile.deviceFp,
        profile,
        reservationOwner: `ltuid:${ltuid}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        fpUpdatedAt: Date.now(),
        server: server || (isOs ? 'os_usa' : 'cn_gf01'),
        biz: biz || (isOs ? 'hk4e_global' : 'hk4e_cn'),
        game: selectedGame,
        uid: selectedUid,
        isOs,
        source: 'genshin-device-manager'
      }
      await this.writeAccount(ltuid, record)
      if (mysUser) {
        mysUser.setCkData({ device: record.deviceId })
        await mysUser.save()
      }
      await this.ensureRegistered(ltuid, cookie, record, { ...options, uid: selectedUid, game: selectedGame, server, biz, isOs })
      return record
    })

    const needsSeedMigration = record && this.needsFpSeedMigration(record.profile)
    const fpExpired = record && Date.now() - Number(record.fpUpdatedAt || record.createdAt || Date.now()) >= FP_REFRESH_INTERVAL
    if (needsSeedMigration || fpExpired) {
      try {
        return await this.refreshDeviceFp(ltuid, cookie, { ...options, force: true }) || record
      } catch (error) {
        logger.warn(`[DeviceManager][ltuid:${ltuid}] ${needsSeedMigration ? '旧版设备指纹参数迁移' : 'Device FP 自动更新'}失败，继续使用当前档案：${error.message}`)
      }
    }
    return record
  }

  static async getForCookie(uid, cookie, game = 'gs', biz = '', server = '') {
    const ltuid = await this.getLtuid(cookie) || (game === 'bbs' ? String(uid || '') : '')
    if (!ltuid) return null
    return await this.getForAccount(ltuid, cookie, { uid, game, biz, server })
  }

  static async createLoginSession(sessionId = '', options = {}) {
    sessionId = String(sessionId || uuid())
    const key = sessionKey(sessionId)
    const existing = parseJson(await redis.get(key))
    if (existing?.deviceId && existing?.deviceFp && existing?.profile) return existing
    const owner = `session:${sessionId}`
    const profile = await this.createUniqueProfile(owner, {
      game: options.game || 'bbs',
      server: options.server || 'cn_gf01',
      biz: options.biz || 'hk4e_cn',
      uid: options.uid || '100000001',
      cookie: '',
      isOs: Boolean(options.isOs)
    })
    const record = {
      version: 1,
      sessionId,
      deviceId: profile.deviceId,
      deviceFp: profile.deviceFp,
      profile,
      reservationOwner: owner,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL * 1000,
      server: options.server || 'cn_gf01',
      biz: options.biz || 'hk4e_cn',
      game: options.game || 'bbs',
      uid: options.uid || '100000001',
      isOs: Boolean(options.isOs)
    }
    await redis.set(key, JSON.stringify(record), { EX: SESSION_TTL })
    return record
  }

  static async getLoginSession(sessionId) {
    if (!sessionId) return null
    const record = parseJson(await redis.get(sessionKey(sessionId)))
    if (!record?.deviceId || !record?.deviceFp || !record?.profile) return null
    return record
  }

  static async completeLoginSession(sessionId, ltuid, cookie = '', options = {}) {
    ltuid = String(ltuid || await this.getLtuid(cookie) || '').trim()
    if (!sessionId || !/^\d{4,12}$/.test(ltuid)) throw new Error('登录会话或 ltuid 无效，无法归档设备档案')
    const session = await this.getLoginSession(sessionId)
    if (!session) throw new Error('临时设备登录会话不存在或已过期')
    return await this.withAccountLock(ltuid, async () => {
      if (!await this.getLoginSession(sessionId)) throw new Error('临时设备登录会话已被其他流程完成或过期')
      const promotedProfile = { ...session.profile, deviceId: session.deviceId, deviceFp: session.deviceFp }
      const accountOwner = `ltuid:${ltuid}`
      if (!await this.transferProfileReservation(promotedProfile, session.reservationOwner, accountOwner)) {
        throw new Error('临时设备档案唯一性登记转移失败，已拒绝覆盖账号设备')
      }
      session.profile.ltuid = String(ltuid)
      session.profile.deviceId = session.deviceId
      session.profile.deviceFp = session.deviceFp
      const record = {
        version: 1,
        ltuid,
        deviceId: session.deviceId,
        deviceFp: session.deviceFp,
        profile: session.profile,
        reservationOwner: accountOwner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        fpUpdatedAt: Date.now(),
        server: options.server || session.server || 'cn_gf01',
        biz: options.biz || session.biz || 'hk4e_cn',
        game: session.game || options.game || 'bbs',
        uid: options.uid || session.uid || ltuid,
        isOs: Boolean(options.isOs ?? session.isOs),
        source: 'passport-login-session'
      }
      await this.writeAccount(ltuid, record)
      await this.saveMysUserDevice(ltuid, record.deviceId)
      await this.ensureRegistered(ltuid, cookie, record, options)
      await redis.del(sessionKey(sessionId))
      return record
    })
  }

  static async abortLoginSession(sessionId) {
    if (!sessionId) return false
    await redis.del(sessionKey(sessionId))
    return true
  }

  static async refreshDeviceFp(ltuid, cookie = '', options = {}) {
    ltuid = String(ltuid || await this.getLtuid(cookie) || '').trim()
    if (!/^\d{4,12}$/.test(ltuid)) return null
    const existing = await this.readAccount(ltuid)
    if (!existing?.profile || !existing.deviceId) return await this.getForAccount(ltuid, cookie, options)
    return await this.withAccountLock(ltuid, async () => {
      const current = await this.readAccount(ltuid)
      if (!current?.profile || !current.deviceId) throw new Error('账号设备档案在刷新期间丢失')
      if (!options.force && Date.now() - Number(current.fpUpdatedAt || current.updatedAt || 0) < FP_REFRESH_INTERVAL) return current
      const profile = {
        ...current.profile,
        deviceFp: '',
        bbsDeviceId: uuid(), seedId: uuid(), fpDeviceId: hexChars(16), seedFp: hexChars(13), registrationId: hexChars(19),
        aaid: uuid(), vaid: uuid(), adid: uuid(), appSetId: uuid(), oaid: uuid()
      }
      const owner = current.reservationOwner || `ltuid:${ltuid}`
      const reserved = await this.reserveProfile({ ...profile, deviceFp: '' }, owner)
      if (!reserved) throw new Error('更新设备标识时发生重复')
      profile.deviceFp = await this.requestDeviceFp(profile, { ...current, ...options, uid: options.uid || current.uid || ltuid, ltuid, cookie })
      if (!await this.reserve('deviceFp', profile.deviceFp, owner)) throw new Error('更新后的 Device FP 与其他账号重复')
      profile.updatedAt = Date.now()
      const record = { ...current, deviceFp: profile.deviceFp, profile, updatedAt: Date.now(), fpUpdatedAt: Date.now(), registeredAt: 0, registerAttemptAt: 0 }
      await this.writeAccount(ltuid, record)
      await this.ensureRegistered(ltuid, cookie, record, { server: current.server, biz: current.biz, isOs: current.isOs, uid: current.uid, ...options })
      return record
    })
  }

  static async registerDevice(ltuid, cookie, record, options = {}) {
    if (!this.isCookieToken(cookie) || !record?.profile || options.isOs || /(?:os_|global|prod_official_(?:usa|eur|asia|cht|tw|hk|kr)|prod_gf_(?:us|usa|eu|eur|jp|sg|asia|cht|tw|hk|kr))/i.test(`${options.server || ''} ${options.biz || ''}`)) return false
    try {
      const { default: MysApi } = await import('../mys/mysApi.js')
      const uid = String(options.uid || ltuid)
      const game = 'bbs'
      const server = options.server || 'cn_gf01'
      const biz = options.biz || 'hk4e_cn'
      const api = new MysApi(uid, cookie, {
        game,
        log: false,
        device: record.deviceId,
        deviceProfile: record.profile
      }, server, biz)
      const data = toApiData(record.profile)
      data.deviceFp = record.deviceFp
      const login = api.getUrl('deviceLogin', data)
      const save = api.getUrl('saveDevice', data)
      if (!login?.url || !save?.url) return false
      login.headers.Cookie = cookie
      save.headers.Cookie = cookie
      const loginRes = await fetch(login.url, { method: 'POST', headers: login.headers, body: login.body, timeout: 10000 })
      const saveRes = await fetch(save.url, { method: 'POST', headers: save.headers, body: save.body, timeout: 10000 })
      const [loginJson, saveJson] = await Promise.all([loginRes.json(), saveRes.json()])
      const loginCode = loginJson?.retcode ?? 'no-retcode'
      const saveCode = saveJson?.retcode ?? 'no-retcode'
      const registered = Number(loginCode) === 0 && Number(saveCode) === 0
      if (registered) {
        logger.mark(`[DeviceManager][ltuid:${ltuid}] 设备注册成功（deviceLogin/saveDevice 均返回 0）`)
      } else {
        logger.warn(`[DeviceManager][ltuid:${ltuid}] 设备注册未成功（deviceLogin=${loginCode}, saveDevice=${saveCode}）；未记录为已注册`)
      }
      return registered
    } catch (error) {
      logger.warn(`[DeviceManager][ltuid:${ltuid}] 设备注册请求失败：${error.message}`)
      return false
    }
  }

  static toApiData(profile) { return toApiData(profile) }
}
