import GsCfg from "../model/gsCfg.js"
import fs from "node:fs"
import lodash from "lodash"
import fetch from "node-fetch"
import YAML from "yaml"
import MysInfo from "../model/mys/mysInfo.js"
import User from "../model/user.js"
import common from "../../../lib/common/common.js"

export class setPubCk extends plugin {
  constructor (e) {
    super({
      name: "配置",
      dsc: "#配置ck",
      event: "message",
      priority: 700,
      rule: [
        {
          reg: /^#配置c(oo)?k(ie)?$|^#*配置公共查询c(oo)?k(ie)?$/i,
          fnc: "setPubCk",
          permission: "master"
        },
        {
          reg: "^#使用(全部|用户)ck$",
          fnc: "setUserCk",
          permission: "master"
        }
      ]
    })

    this.file = "./plugins/genshin/config/mys.pubCk.yaml"
  }

  /** 配置公共ck */
  async setPubCk () {
    /** 设置上下文，后续接收到内容会执行doRep方法 */
    this.setContext("pubCk")
    /** 回复 */
    await this.reply("请发送米游社cookie......\n配置后该ck将会加入公共查询池")
  }

  async pubCk () {
    const parsed = User.parseV2Ck(this.e.msg)
    const { param, ltokenV2, cookieTokenV2 } = parsed

    if (!ltokenV2 || !cookieTokenV2) {
      this.finish("pubCk")
      await this.e.reply("Cookie错误：需要有效的 v2 Ltoken 和 Cookie Token；旧字段名仅兼容 v2 Token 值")
      return true
    }

    this.finish("pubCk")

    let ltuid = parsed.ltuidV2
    let mid = parsed.midV2
    if (!/^\d{4,10}$/.test(String(ltuid || '')) || !mid) {
      // 部分浏览器导出的 Cookie 没有通行证 ID 或 MID，尝试从米游社用户信息补齐。
      const tempParts = [
        `ltoken_v2=${ltokenV2}`,
        `cookie_token_v2=${cookieTokenV2}`
      ]
      if (ltuid) tempParts.push(`ltuid_v2=${ltuid}`, `account_id_v2=${ltuid}`)
      if (mid) tempParts.push(`ltmid_v2=${mid}`, `account_mid_v2=${mid}`)
      if (param.mi18nLang) tempParts.push(`mi18nLang=${param.mi18nLang}`)
      this.ck = `${tempParts.join(';')};`
      const userFullInfo = await this.getUserInfo()
      const userInfo = userFullInfo?.data?.user_info
      if (!/^\d{4,10}$/.test(String(ltuid || ''))) ltuid = userInfo?.uid || ''
      if (!mid) mid = userInfo?.mid || ''
    }

    if (!/^\d{4,10}$/.test(String(ltuid || '')) || !mid) {
      const reason = '缺少有效的 ltuid 或 MID，无法生成完整 v2 Cookie'
      logger.mark(`配置公共cookie错误：${reason}`)
      await this.e.reply(`配置公共cookie错误：${reason}`)
      return
    }

    this.ltuid = String(ltuid)
    this.ck = User.buildV2Ck({
      ltuid: this.ltuid,
      ltoken: ltokenV2,
      cookieToken: cookieTokenV2,
      mid,
      mi18nLang: param.mi18nLang
    })

    /** 检查ck是否失效 */
    if (!await this.checkCk()) {
      logger.mark(`配置公共cookie错误：${this.checkMsg || "cookie错误"}`)
      await this.e.reply(`配置公共cookie错误：${this.checkMsg || "cookie错误"}`)
      return
    }

    let ckArr = GsCfg.getConfig("mys", "pubCk") || []

    /** 按 ltuid 精确判断重复，避免账号 ID 子串误判 */
    const duplicated = ckArr.some(existing => User.parseV2Ck(existing).ltuidV2 === this.ltuid)
    if (duplicated) {
      await this.e.reply("配置公共cookie错误：该ck已配置")
      return
    }

    ckArr.push(this.ck)
    this.save(ckArr)
    GsCfg.change_myspubCk()

    await this.e.reply(`配置公共ck成功：第${ckArr.length}个`)
  }

  /** 检查ck是否可用 */
  async checkCk () {
    let url = "https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=hk4e_cn"
    let res = await fetch(url, { method: "get", headers: { Cookie: this.ck } })
    if (!res.ok) return false
    res = await res.json()
    if (res.retcode != 0) {
      this.checkMsg = res.message
      return false
    }

    return true
  }

  // 获取米游社通行证id
  async getUserInfo (server = "mys") {
    try {
      const that = this
      let url = {
        mys: "https://bbs-api.mihoyo.com/user/wapi/getUserFullInfo?gids=2",
        hoyolab: ""
      }
      let res = await fetch(url[server], {
        method: "get",
        headers: {
          Cookie: that.ck,
          Accept: "application/json, text/plain, */*",
          Connection: "keep-alive",
          Host: "bbs-api.mihoyo.com",
          Origin: "https://m.bbs.mihoyo.com",
          Referer: " https://m.bbs.mihoyo.com/"
        }
      })
      if (!res.ok) return res
      res = await res.json()
      return res
    } catch (e) {
      return null
    }
  }

  save (data) {
    data = YAML.stringify(data)
    fs.writeFileSync(this.file, data)
  }

  async setUserCk () {
    let set = "./plugins/genshin/config/mys.set.yaml"

    let config = fs.readFileSync(set, "utf8")
    config = config.replace(/allowUseCookie: [0-1]/g, "allowUseCookie: 1")
    fs.writeFileSync(set, config, "utf8")

    await common.sleep(500)
    await MysInfo.initCache(true)

    await this.reply("开启成功，用户ck已加入公共查询ck池")
  }
}