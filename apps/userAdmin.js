import plugin from '../../../lib/plugins/plugin.js'
import fs from 'node:fs'
import YAML from 'yaml'
import common from '../../../lib/common/common.js'
import GsCfg from '../model/gsCfg.js'
import MysUser from '../model/mys/MysUser.js'
import { MysUserDB, UserDB } from '../model/db/index.js'
import User from '../model/user.js'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import MysInfo from '../model/mys/mysInfo.js'

export class user extends plugin {
  constructor (e) {
    super({
      name: '用户管理',
      dsc: 'CK用户管理',
      event: 'message',
      priority: 300,
      rule: [{
        reg: '^#用户统计$',
        fnc: 'userAdmin',
        permission: "master",
      }, {
        reg: '^#(刷新|重置)用户(缓存|统计|ck|Ck|CK)$',
        fnc: 'resetCache',
        permission: "master",
      }, {
        reg: '^#删除(无效|失效)(用户|ck|Ck|CK)$',
        fnc: 'delDisable',
        permission: "master",
      }, {
        reg: '^#?修复旧c(oo)?k(ie)?$',
        fnc: 'repairOldCk',
        permission: "master",
      }]
    })
    this.User = new User(e)
    this.button = segment.button([
      { text: "用户统计", callback: "#用户统计" },
      { text: "删除无效", callback: "#删除无效用户" },
    ],[
      { text: "刷新统计", callback: "#刷新用户统计" },
      { text: "重置统计", callback: "#重置用户统计" },
    ])
  }

  /** #用户统计$ */
  async userAdmin () {
    let data = await new User(this.e).userAdmin()
    if (!data) return true

    /** 生成图片 */
    this.reply([await this.renderImg('genshin', 'html/admin/userAdmin', data, { retType: "base64" }), this.button])
  }

  /** #刷新用户缓存 / #重置用户缓存 */
  async resetCache () {
    // 清空老数据
    const clearData = /重置/.test(this.e.msg)
    await MysInfo.initCache(true, clearData)
    this.reply([`用户缓存已${clearData ? '重置' : '刷新'}...\n通过【#用户统计】命令可查看详情`, this.button])
  }

  async delDisable () {
    let count = await MysInfo.delDisable()
    this.reply([count > 0 ? `已删除${count}个无效用户` : '暂无无效用户...', this.button])
  }

  /** 扫描并规范化旧字段名的 v2 CK；真正的 v1 Token 不会仅改字段名冒充 v2 */
  async repairOldCk () {
    const normalizeLegacyCk = (rawCk, fallbackLtuid = '') => {
      const parsed = User.parseV2Ck(rawCk)
      const param = parsed.param
      const fallback = /^\d{4,10}$/.test(String(fallbackLtuid || '')) ? String(fallbackLtuid) : ''
      const ltuid = parsed.ltuidV2 || fallback
      const hasLegacyNames = Boolean(
        param.ltoken || param.ltuid || param.cookie_token || param.account_id ||
        param.account_mid || param.ltmid || param.mid
      )

      if (!parsed.ltokenV2 || !parsed.cookieTokenV2) {
        const hasNonV2Token = Boolean(
          (param.ltoken && !/^v2_/i.test(param.ltoken)) ||
          (param.cookie_token && !/^v2_/i.test(param.cookie_token))
        )
        return {
          status: hasNonV2Token ? 'legacy_v1' : 'incomplete',
          ltuid,
          reason: hasNonV2Token
            ? '检测到非v2 Token，不能仅通过修改字段名升级'
            : '缺少ltoken_v2或cookie_token_v2'
        }
      }
      if (!ltuid || !parsed.midV2) {
        return {
          status: 'incomplete',
          ltuid,
          reason: !ltuid ? '缺少有效数字ltuid' : '缺少ltmid_v2/account_mid_v2'
        }
      }

      const normalized = User.buildV2Ck({
        ltuid,
        ltoken: parsed.ltokenV2,
        cookieToken: parsed.cookieTokenV2,
        mid: parsed.midV2,
        mi18nLang: param.mi18nLang
      })
      const alreadyClean = !hasLegacyNames
        && param.ltuid_v2 === ltuid
        && param.account_id_v2 === ltuid
        && param.ltoken_v2 === parsed.ltokenV2
        && param.cookie_token_v2 === parsed.cookieTokenV2
        && param.ltmid_v2 === parsed.midV2
        && param.account_mid_v2 === parsed.midV2
      return {
        status: alreadyClean ? 'v2_clean' : 'v2_repaired',
        ck: normalized,
        ltuid
      }
    }

    // 建立 ltuid -> QQ 反查表。
    const ltuidToQqs = new Map()
    const userRows = await UserDB.findAll()
    for (const row of userRows) {
      const ltuids = String(row.ltuids || '').split(',').map(value => value.trim()).filter(Boolean)
      for (const ltuid of ltuids) {
        if (!ltuidToQqs.has(ltuid)) ltuidToQqs.set(ltuid, [])
        ltuidToQqs.get(ltuid).push(row.id)
      }
    }

    // 扫描 MysUsers 数据库。
    const mysRows = await MysUserDB.findAll()
    let dbV2Clean = 0
    let dbV2Repaired = 0
    let dbLegacy = 0
    let dbIncomplete = 0
    const dbLegacyList = []
    const dbIncompleteList = []
    let dbChanged = false

    for (const row of mysRows) {
      if (!row.ck) continue
      const ltuidKey = String(row.ltuid)
      const ret = normalizeLegacyCk(row.ck, ltuidKey)
      const qqs = ltuidToQqs.get(ltuidKey)?.join('/') || '未关联QQ'
      let uidData = row.uids || {}
      if (typeof uidData === 'string') {
        try { uidData = JSON.parse(uidData) } catch { uidData = {} }
      }
      const uidsText = Object.entries(uidData)
        .filter(([, arr]) => Array.isArray(arr) && arr.length > 0)
        .map(([game, arr]) => `${game}:${arr.join(',')}`)
        .join(' | ') || '无UID'

      if (ret.status === 'v2_clean') {
        dbV2Clean++
      } else if (ret.status === 'v2_repaired') {
        row.ck = ret.ck
        await row.save()
        const mys = await MysUser.create(row.ltuid, row)
        if (mys) mys.setCkData({ ck: ret.ck })
        dbV2Repaired++
        dbChanged = true
        logger.mark(`[修复旧ck] 数据库v2已规范化 ltuid:${ltuidKey}`)
      } else if (ret.status === 'legacy_v1') {
        dbLegacy++
        dbLegacyList.push(`QQ:${qqs} | ltuid:${ltuidKey} | ${uidsText} (${ret.reason})`)
      } else {
        dbIncomplete++
        dbIncompleteList.push(`QQ:${qqs} | ltuid:${ltuidKey} | ${uidsText} (${ret.reason})`)
      }
    }

    // 扫描公共 CK 池。
    const pubCkFile = './plugins/genshin/config/mys.pubCk.yaml'
    let pubTotal = 0
    let pubV2Clean = 0
    let pubV2Repaired = 0
    let pubLegacy = 0
    let pubIncomplete = 0
    const pubLegacyList = []
    const pubIncompleteList = []
    let pubChanged = false

    if (fs.existsSync(pubCkFile)) {
      const pubCks = GsCfg.getConfig('mys', 'pubCk')
      if (Array.isArray(pubCks) && pubCks.length > 0) {
        pubTotal = pubCks.length
        const updatedPubCks = []
        for (let idx = 0; idx < pubCks.length; idx++) {
          const ret = normalizeLegacyCk(pubCks[idx])
          if (ret.status === 'v2_clean') {
            pubV2Clean++
            updatedPubCks.push(pubCks[idx])
          } else if (ret.status === 'v2_repaired') {
            updatedPubCks.push(ret.ck)
            pubV2Repaired++
            pubChanged = true
            logger.mark(`[修复旧ck] 公共CK第${idx + 1}条v2已规范化 ltuid:${ret.ltuid}`)
          } else if (ret.status === 'legacy_v1') {
            updatedPubCks.push(pubCks[idx])
            pubLegacy++
            pubLegacyList.push(`公共CK第${idx + 1}条 | ltuid:${ret.ltuid || '未知'} (${ret.reason})`)
          } else {
            updatedPubCks.push(pubCks[idx])
            pubIncomplete++
            pubIncompleteList.push(`公共CK第${idx + 1}条 | ltuid:${ret.ltuid || '未知'} (${ret.reason})`)
          }
        }
        if (pubChanged) fs.writeFileSync(pubCkFile, YAML.stringify(updatedPubCks), 'utf8')
      }
    }

    if (pubChanged) await GsCfg.change_myspubCk()
    if (dbChanged) await MysInfo.initCache(true)

    const summary = [
      '【旧CK检测与修复完成】',
      `用户库(共${mysRows.length}条)：`,
      `  v2正常 ${dbV2Clean} | v2已规范化 ${dbV2Repaired}`,
      `  非v2旧Token未修改 ${dbLegacy} | 字段不完整 ${dbIncomplete}`,
      `公共池(共${pubTotal}条)：`,
      `  v2正常 ${pubV2Clean} | v2已规范化 ${pubV2Repaired}`,
      `  非v2旧Token未修改 ${pubLegacy} | 字段不完整 ${pubIncomplete}`
    ]

    const detailLines = [
      ...(dbLegacyList.length ? ['--- 数据库旧Token名单（未修改，需重新登录/换取v2 Token）---', ...dbLegacyList] : []),
      ...(dbIncompleteList.length ? ['--- 数据库字段不完整名单（未修改）---', ...dbIncompleteList] : []),
      ...(pubLegacyList.length ? ['--- 公共池旧Token名单（未修改，需重新获取v2 Token）---', ...pubLegacyList] : []),
      ...(pubIncompleteList.length ? ['--- 公共池字段不完整名单（未修改）---', ...pubIncompleteList] : [])
    ]

    if (detailLines.length === 0) {
      summary.push('\n所有存量 CK 均为规范 v2，或已完成字段名规范化。')
      return this.reply(summary.join('\n'))
    }

    logger.mark(`[修复旧ck] 旧Token及异常名单：\n${detailLines.join('\n')}`)
    const isQQBot = this.e?.bot?.version?.name === 'QQBot'
    if (detailLines.length <= 20 || isQQBot) {
      summary.push('', ...detailLines.slice(0, 25))
      if (detailLines.length > 25) summary.push(`...其余 ${detailLines.length - 25} 条已打印至控制台日志`)
      return this.reply(summary.join('\n'))
    }

    await this.reply(summary.join('\n'))
    try {
      const forward = await common.makeForwardMsg(this.e, [detailLines.join('\n')], '旧Token及异常CK名单')
      return this.reply(forward)
    } catch {
      return this.reply(`${detailLines.slice(0, 25).join('\n')}\n...完整名单已打印至控制台日志`)
    }
  }

}
