import DeviceManager from './device/DeviceManager.js'

export default class getDeviceFp {
  static async Fp(uid, ck, game = 'gs', biz = '', server = '') {
    try {
      const ltuid = game === 'bbs'
        ? (await DeviceManager.getLtuid(ck) || String(uid || ''))
        : await DeviceManager.getLtuid(ck)
      if (!ltuid) return { deviceFp: null, deviceId: null, profile: null }
      const record = await DeviceManager.getForAccount(ltuid, ck, {
        uid,
        game,
        biz,
        server,
        isOs: /(?:os_(?:usa|euro|asia|cht)|prod_(?:official_(?:usa|eur|asia|cht|tw|hk|kr)|gf_(?:us|usa|eu|eur|jp|sg|asia|cht|tw|hk|kr))|global)/i.test(`${server || ''} ${biz || ''}`)
      })
      if (!record?.deviceFp || !record?.deviceId || !record?.profile) {
        return { deviceFp: null, deviceId: null, profile: null }
      }
      return {
        deviceFp: record.deviceFp,
        deviceId: record.deviceId,
        profile: record.profile,
        device: record
      }
    } catch (error) {
      logger.error(`[DeviceManager][getDeviceFp] ${error.stack || error.message}`)
      return { deviceFp: null, deviceId: null, profile: null, error }
    }
  }
}
