import NoteUser from './mys/NoteUser.js'
import MysUser from './mys/MysUser.js'
import common from '../../../lib/common/common.js'
import { promisify } from 'node:util'
import MysApi from './mys/mysApi.js'
import fs from 'node:fs'
import yaml from 'yaml'
import _ from 'lodash'
import GT_Manual from './GT-Manual/GT-Manual.js'
import SignPermission from './SignPermission.js'
import VerificationStats from './VerificationStats.js'
import { resolveServerType } from './mys/serverType.js'
let sqlite3
try {
  sqlite3 = (await import('sqlite3')).default
} catch (err) {
  logger.error('导入sqlite3失败，本插件不支持Yunzai-Bot，非Yunzai-Bot请检查依赖')
}

const _path = process.cwd().replace(/\\/g, '/')
class Cfg {
  constructor() {
    this.file = `${_path}/plugins/genshin/config`
    this.defile = `${_path}/plugins/genshin/defSet`
    this.resfile = `${_path}/plugins/genshin/resources/`
    this.dir = `${_path}/plugins/genshin/yaml`
  }

  get api(){ return this.getConfig('api') }

  /** 用户配置 */
  getConfig(app, y = true) {
    if (y)
      return yaml.parse(fs.readFileSync(`${this.file}/${app}.yaml`, 'utf8'))
    else
      return fs.readFileSync(`${this.file}/${app}.yaml`, 'utf8')
  }

  getdef(app, y = true) {
    if (y)
      return yaml.parse(fs.readFileSync(`${this.defile}/${app}.yaml`, 'utf8'))
    else
      return fs.readFileSync(`${this.defile}/${app}.yaml`, 'utf8')
  }

  setConfig(app, data, y = true) {
    if (y) data = yaml.stringify(data)
    return fs.writeFileSync(`${this.file}/${app}.yaml`, data, 'utf8')
  }

  setCk(ck, device_id) {
    return _.trim(ck, ';') + `; _MHYUUID=${device_id}; `
  }

  async saveSk(userId, data) {
    const qq = String(userId || '')
    const file = `${this.dir}/${qq}.yaml`
    fs.mkdirSync(this.dir, { recursive: true })
    let existing = {}
    if (fs.existsSync(file)) {
      try { existing = yaml.parse(fs.readFileSync(file, 'utf8')) || {} } catch { existing = {} }
    }

    const oldLtuids = new Set()
    for (const [key, item] of Object.entries(existing || {})) {
      const nested = item?.sk && typeof item.sk === 'object' ? item.sk : {}
      const raw = typeof item === 'string' ? item : typeof item?.sk === 'string' ? item.sk : ''
      const getRaw = field => raw.match(new RegExp(`(?:^|;\\s*)${field}=([^;]+)`))?.[1] || ''
      const stuid = item?.stuid || nested.stuid || getRaw('stuid') || getRaw('ltuid') || getRaw('ltuid_v2') || (/^\d+$/.test(key) ? key : '')
      if (stuid) oldLtuids.add(String(stuid))
    }

    let merged = {}
    if (_.isEmpty(data)) {
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } else {
      // 保留该 QQ 原有的其他 Stoken 记录，避免新增绑定覆盖旧账号。
      merged = existing?.uid ? data : { ...(existing || {}), ...(data || {}) }
      fs.writeFileSync(file, yaml.stringify(merged), 'utf8')
    }

    const newLtuids = new Set()
    for (const [key, item] of Object.entries(merged || {})) {
      const nested = item?.sk && typeof item.sk === 'object' ? item.sk : {}
      const raw = typeof item === 'string' ? item : typeof item?.sk === 'string' ? item.sk : ''
      const getRaw = field => raw.match(new RegExp(`(?:^|;\\s*)${field}=([^;]+)`))?.[1] || ''
      const stuid = item?.stuid || nested.stuid || getRaw('stuid') || getRaw('ltuid') || getRaw('ltuid_v2') || (/^\d+$/.test(key) ? key : '')
      if (stuid) newLtuids.add(String(stuid))
    }

    for (const stuid of newLtuids) await VerificationStats.onQQBind(qq, stuid)
    for (const stuid of oldLtuids) {
      if (!newLtuids.has(stuid)) await VerificationStats.onQQUnbind(qq, stuid)
    }
    return true
  }

  async signCk(targetQQs = null) {
    let config = this.getConfig('config')

    const collect = async (qqs, source = null) => {
      let allow = new Set((qqs || []).map(v => String(v)).filter(Boolean))
      let { cks: allCks } = source || await this.getcks(true)
      let signck = _.fromPairs(config.game.map((game) => [game, {}]))
      let signuid = _.fromPairs(config.game.map((game) => [game, []]))

      if (allow.size === 0)
        return { cks: signck, uids: signuid }

      for (let g of config.game)
        for (let uid in allCks[g])
          if (allow.has(String(allCks[g][uid].qq)))
            signck[g][uid] = allCks[g][uid]

      for (let g of config.game)
        signuid[g] = _.map(signck[g], 'uid')

      return { cks: signck, uids: signuid }
    }

    // 主人手动批量任务传入明确QQ范围时，只处理这些QQ。
    if (Array.isArray(targetQQs))
      return await collect(targetQQs)

    // 游戏群名单已改为黑名单，需要从完整账号集合中排除“仅属于黑名单群”的QQ；
    // 不能再把白名单群成员集合当作全部可签到账号。
    let all = await this.getcks(true)
    let candidateQQs = _.uniq(config.game.flatMap(game =>
      Object.values(all.cks[game] || {}).map(ck => String(ck?.qq ?? '')).filter(Boolean)
    ))
    let autoQQs = await SignPermission.getAutoQQs('game', candidateQQs)
    if (autoQQs === null) {
      logger.mark('[自动签到]未限制游戏签到范围，查询全部ck')
      return all
    }

    logger.mark(`[自动签到]按游戏签到权限筛选QQ，共${autoQQs.length}人`)
    return await collect(autoQQs, all)
  }

  async getcks(all, qq = '', note = false) {
    if (qq) qq = Number(qq) || String(qq)
    this.banUid = this.getConfig('banuid')
    let config = this.getConfig('config')
    this.white = this.getConfig('white')

    this.Game = note ? ['gs', 'sr', 'zzz'] : config.game
    let cks = _.fromPairs(this.Game.map((game) => [game, {}]))
    let uids = _.fromPairs(this.Game.map((game) => [game, {}]))

    const dbPath = `${_path}/data/db/data.db`
    const db = new sqlite3.Database(dbPath)
    const Users = `select id as qq, ltuid, ck, device, uids  from Users 
	 left join MysUsers on Users.ltuids Like '%' ||MysUsers.ltuid||'%'
	 where ${all ? `` : `Users.id = '${qq}' and`}
	Users.id is not null and MysUsers.ck is not null;`
    try {
      const rows = await new Promise((resolve, reject) => {
        db.all(Users, [], (err, rows) => {
          if (err) {
            reject(err)
          } else {
            resolve(rows)
          }
        })
      })

      for (let key of this.Game) {
        for (let row of rows) {
          const Data = JSON.parse(row.uids)
          for (let i in Data[key]) {
            if (this.banUid[key]?.includes(Number(Data[key][i]))) continue
            let uid = String(Data[key][i])
            let ck = {
              [uid]: {
                qq: row.qq,
                uid: uid,
                ck: this.setCk(row.ck, row.device),
                skid: `${row.ltuid}_${row.qq}`,
                game_biz: '',
                region: '',
                device_id: row.device,
                ltuid: row.ltuid
              }
            }
            cks[key] = Object.assign({}, cks[key], ck)
          }
          if (!note && ['bh3', 'bh2'].includes(key)) cks = await this.otherck(key, row, cks)
        }
      }
      for (let game of this.Game)
        uids[game] = _.map(cks[game], 'uid')

      return { cks, uids }
    } catch (err) {
      logger.mark(`抛出异常: ${err.message}`)
      return { cks, uids }
    } finally {
      db.close()
    }
  }

  async otherck(game, row, cks) {
    let ck = this.setCk(row.ck, row.device)
    const Data = JSON.parse(row.uids)
    for (let i in Data[game]) {
      if (this.banUid[game]?.includes(Number(Data[game][i]))) continue
      let uid = String(Data[game][i])
      let usergame = JSON.parse(await redis.get(`genshin:usergame:${uid}:${game}_role`))
      if (usergame) {
        let CK = {
          [uid]: {
            qq: row.qq,
            uid: uid,
            ck: ck,
            skid: `${row.ltuid}_${row.qq}`,
            game_biz: usergame.game_biz,
            region: usergame.region,
            device_id: row.device,
            ltuid: row.ltuid
          }
        }
        cks[game] = Object.assign({}, cks[game], CK)
      } else {
        let mysApi = new MysApi('', ck, { log: false }, '', '', game)
        let res
        if (game == 'bh2') {
          res = await mysApi.getData('bh2_cn')
        } else {
          res = await mysApi.getData('bh3_cn')
          if (res?.retcode !== 0) res = await mysApi.getData('bh3_global')
        }

        const roleList = res?.data?.list
        // 单个 UID 查询失败或没有角色时只跳过该 UID，不中断同一账号的其他 UID。
        if (res?.retcode !== 0 || !Array.isArray(roleList) || roleList.length === 0) {
          delete cks[game][uid]
          continue
        }

        let data = roleList.find(item => String(item.game_uid) === uid)
        if (!data) {
          delete cks[game][uid]
          continue
        }

        let CK = {
          [uid]: {
            qq: row.qq,
            uid: uid,
            ck: ck,
            skid: `${row.ltuid}_${row.qq}`,
            game_biz: data.game_biz,
            region: data.region,
            device_id: row.device,
            ltuid: row.ltuid
          }
        }
        cks[game] = Object.assign({}, cks[game], CK)
        await redis.set(`genshin:usergame:${uid}:${game}_role`, JSON.stringify({
          game_biz: data.game_biz,
          region: data.region
        }))
      }
    }
    await common.sleep(_.random(500, 1000))
    return cks
  }

  async signSk(targetQQs = null) {
    const collect = async (qqs, source = null) => {
      let allow = new Set((qqs || []).map(v => String(v)).filter(Boolean))
      let signSks = {}
      if (allow.size === 0) return { sks: signSks, ltuids: [] }

      let allSks = source || await this.getsks(true, '', true)
      for (let id in allSks)
        if (allow.has(String(allSks[id].userId))) signSks[id] = allSks[id]

      return { sks: signSks, ltuids: _.map(signSks, 'id') }
    }

    if (Array.isArray(targetQQs)) return await collect(targetQQs)

    const allSks = await this.getsks(true, '', true)
    const candidateQQs = _.uniq(Object.values(allSks).map(item => String(item?.userId || '')).filter(Boolean))
    const autoQQs = await SignPermission.getAutoQQs('coin', candidateQQs)
    if (autoQQs === null) {
      logger.mark('[米币自动签到]未限制米币签到范围，查询全部sk')
      return { sks: allSks, ltuids: _.map(allSks, 'id') }
    }

    logger.mark(`[米币自动签到]按新米币签到权限筛选QQ，共${autoQQs.length}人`)
    return await collect(autoQQs, allSks)
  }

  async getsks(all, qq, sign, includeIncomplete = false) {
    let list = {}
    try {
      const entries = []
      if (all) {
        const files = fs.readdirSync(`${this.dir}/`).filter(file => file.endsWith('.yaml'))
        for (const file of files) {
          const fileUserId = file.replace(/\.yaml$/i, '')
          const parsed = yaml.parse(fs.readFileSync(`${this.dir}/${file}`, 'utf8')) || {}
          if (!parsed || typeof parsed !== 'object') continue
          for (const [key, item] of Object.entries(parsed)) {
            entries.push({ key, item, fileUserId })
          }
        }
      } else {
        const file = `${this.dir}/${String(qq)}.yaml`
        if (!fs.existsSync(file)) return list
        const parsed = yaml.parse(fs.readFileSync(file, 'utf8')) || {}
        if (!parsed || typeof parsed !== 'object') return list
        for (const [key, item] of Object.entries(parsed)) {
          entries.push({ key, item, fileUserId: String(qq) })
        }
      }

      for (const { key, item, fileUserId } of entries) {
        const itemObj = item && typeof item === 'object' ? item : {}
        const nestedSk = itemObj.sk && typeof itemObj.sk === 'object' ? itemObj.sk : {}
        const rawSk = typeof item === 'string'
          ? item
          : typeof itemObj.sk === 'string' ? itemObj.sk : ''
        const getRaw = (field) => rawSk.match(new RegExp(`(?:^|;\\s*)${field}=([^;]+)`))?.[1] || ''

        const stuid = String(
          itemObj.stuid ||
          nestedSk.stuid ||
          getRaw('stuid') ||
          getRaw('ltuid') ||
          getRaw('ltuid_v2') ||
          (/^\d+$/.test(key) ? key : '')
        )
        const stoken = itemObj.stoken || nestedSk.stoken || getRaw('stoken') || getRaw('stoken_v2')
        const mid = itemObj.mid || nestedSk.mid || getRaw('mid') || getRaw('account_mid_v2') || getRaw('ltmid_v2')
        const ltoken = itemObj.ltoken || nestedSk.ltoken || getRaw('ltoken') || getRaw('ltoken_v2')
        const region = itemObj.region || nestedSk.region || ''
        const regionName = itemObj.region_name || nestedSk.region_name || ''
        const gameBiz = itemObj.game_biz || nestedSk.game_biz || getRaw('game_biz') || ''
        const legacyType = String(itemObj.type || nestedSk.type || '').toLowerCase()
        const uid = itemObj.uid || nestedSk.uid || ''
        const userId = itemObj.userId || nestedSk.userId || (/^\d+$/.test(String(fileUserId || '')) ? fileUserId : '')
        const effectiveUserId = String(userId || '')
        const role = {
          uid: String(uid || ''),
          region: String(region || ''),
          region_name: String(regionName || ''),
          game_biz: String(gameBiz || ''),
          legacyType
        }

        if (!stoken || !stuid || (!includeIncomplete && !ltoken)) continue

        const id = `${stuid}_${effectiveUserId || 'external'}`
        if (!list[id]) {
          list[id] = {
            userId: effectiveUserId,
            ltoken: ltoken || '',
            stoken,
            mid: mid || '',
            stuid,
            uid: role.uid,
            region: role.region,
            region_name: role.region_name,
            game_biz: role.game_biz,
            legacyType,
            id,
            roles: [],
            sk: `stuid=${stuid};stoken=${stoken};mid=${mid || ''};${ltoken ? `ltoken=${ltoken};` : ''}`
          }
        } else {
          const current = list[id]
          if (!current.ltoken && ltoken) current.ltoken = ltoken
          if (!current.mid && mid) current.mid = mid
          if (!current.stoken && stoken) current.stoken = stoken
        }

        const roles = list[id].roles
        const roleKey = [role.uid, role.region, role.region_name, role.game_biz, role.legacyType].join('|')
        if (!roles.some(item => [item.uid, item.region, item.region_name, item.game_biz, item.legacyType].join('|') === roleKey)) {
          roles.push(role)
        }
      }

      for (const [id, item] of Object.entries(list)) {
        const roles = item.roles || []
        const resolution = resolveServerType(roles.length ? roles : [item])
        item.type = resolution.type || ''
        item.serverTypeStatus = resolution.status
        item.serverTypeSource = resolution.source
        item.serverTypeReason = resolution.reason

        // 同一 stuid 可能在 YAML 中有多个游戏角色；保留全部 roles，
        // 同时选取信息最完整的一条作为兼容旧调用方的顶层展示字段。
        const score = role => [role.uid, role.region, role.region_name, role.game_biz].filter(Boolean).length
        const primaryRole = [...roles].sort((a, b) => score(b) - score(a))[0]
        if (primaryRole) {
          item.uid = primaryRole.uid || item.uid
          item.region = primaryRole.region || item.region
          item.region_name = primaryRole.region_name || item.region_name
          item.game_biz = primaryRole.game_biz || item.game_biz
        }
        item.sk = `stuid=${item.stuid};stoken=${item.stoken};mid=${item.mid || ''};${item.ltoken ? `ltoken=${item.ltoken};` : ''}`

        if (sign && item.type !== 'mys') delete list[id]
      }
    } catch (error) {
      logger.error('stoken获取失败：' + error)
    }
    return list
  }

  /** 将刷新后得到的新 Ltoken 回写到所有包含该 stuid 的 SK YAML 记录。 */
  updateSkLtoken(stuid, ltoken) {
    if (!stuid || !ltoken || !fs.existsSync(this.dir)) return 0
    let updated = 0

    const getRaw = (raw, key) => raw.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`))?.[1] || ''
    const setRawLtoken = (raw) => {
      const value = String(raw || '')
      if (/(^|;\\s*)ltoken(?:_v2)?\\s*=/i.test(value)) {
        return value.replace(/(^|;\\s*)ltoken(?:_v2)?\\s*=[^;]*/i, `$1ltoken=${ltoken}`)
      }
      return `${value.replace(/;?\s*$/, '')};ltoken=${ltoken};`
    }

    for (const file of fs.readdirSync(this.dir).filter(name => name.endsWith('.yaml'))) {
      const filePath = `${this.dir}/${file}`
      try {
        const data = yaml.parse(fs.readFileSync(filePath, 'utf8'))
        if (!data || typeof data !== 'object') continue
        let changed = false

        for (const [key, value] of Object.entries(data)) {
          if (typeof value === 'string') {
            const recordStuid = getRaw(value, 'stuid') || getRaw(value, 'ltuid') || (/^\d+$/.test(key) ? key : '')
            if (String(recordStuid) === String(stuid)) {
              data[key] = setRawLtoken(value)
              changed = true
              updated++
            }
            continue
          }

          if (!value || typeof value !== 'object') continue
          const nested = value.sk && typeof value.sk === 'object' ? value.sk : {}
          const rawSk = typeof value.sk === 'string' ? value.sk : ''
          const recordStuid = value.stuid || nested.stuid || getRaw(rawSk, 'stuid') || getRaw(rawSk, 'ltuid') || (/^\d+$/.test(key) ? key : '')
          if (String(recordStuid) !== String(stuid)) continue

          value.ltoken = ltoken
          if (value.sk && typeof value.sk === 'object') value.sk.ltoken = ltoken
          else if (typeof value.sk === 'string') value.sk = setRawLtoken(value.sk)
          changed = true
          updated++
        }

        if (changed) fs.writeFileSync(filePath, yaml.stringify(data), 'utf8')
      } catch (error) {
        logger.warn(`[SK Ltoken更新] ${file} 更新失败：${error.message}`)
      }
    }

    return updated
  }

  async user(e) {
    return await NoteUser.create(e)
  }

  async delck(ltuid, qq) {
    qq = Number(qq) || String(qq)
    let e = {
      user_id: qq,
      qq,
      msg: "删除ck",
      isSr: false,
      isZzz: false
    }

    let user = await this.user(e)
    let mys = await MysUser.create(ltuid)
    if (!mys) return

    await user.delMysUser(ltuid)
  }

  async delsk(qq, stuid) {
    if (!stuid) return
    const file = `${this.dir}/${String(qq)}.yaml`
    if (!fs.existsSync(file)) return
    let sks = yaml.parse(fs.readFileSync(file, 'utf-8')) || {}
    for (const [key, item] of Object.entries(sks)) {
      const nested = item?.sk && typeof item.sk === 'object' ? item.sk : {}
      const raw = typeof item === 'string' ? item : typeof item?.sk === 'string' ? item.sk : ''
      const rawStuid = raw.match(/(?:^|;\s*)(?:stuid|ltuid|ltuid_v2)=([^;]+)/)?.[1] || ''
      const current = item?.stuid || nested.stuid || rawStuid || (/^\d+$/.test(key) ? key : '')
      if (String(current) === String(stuid)) delete sks[key]
    }
    logger.mark(`[qq:${qq}][stuid:${stuid}]删除失效sk`)
    if (_.isEmpty(sks)) fs.unlinkSync(file)
    else fs.writeFileSync(file, yaml.stringify(sks), 'utf8')
    await VerificationStats.onQQUnbind(qq, stuid)
    return true
  }

  countTime(time) {
    let hour = Math.floor((time / 3600) % 24)
    let min = Math.floor((time / 60) % 60)
    let sec = Math.floor(time % 60)
    let msg = ''
    if (hour > 0) msg += `${hour}小时`
    if (min > 0) msg += `${min}分钟`
    if (sec > 0) msg += `${sec}秒`
    return msg
  }

  startGT () {
    let apiCfg = this.getConfig('api')
    if (apiCfg.startApi && apiCfg.Host && apiCfg.Port && apiCfg.Address) new GT_Manual().load()
  }
}

export default new Cfg()
