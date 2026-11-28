import base from "./base.js"
import fetch from "node-fetch"
import lodash from "lodash"
import fs from "node:fs"
import common from "../../../lib/common/common.js"
import { inspectRecordLink } from "./recordLinkType.js"

export default class GachaLog extends base {
  constructor(e) {
    super(e)
    this.model = "gachaLog"

    if (!e.isSr && e.msg) e.isSr = /\/(common|hkrpg)\//.test(e.msg)

    this.urlKey = `${this.prefix}url:`
    /** 绑定的uid */
    this.uidKey = this.e.isSr ? `Yz:srJson:mys:qq-uid:${this.userId}` : `Yz:genshin:mys:qq-uid:${this.userId}`
    this.path = this.e.isSr ? `./data/srJson/${this.e.user_id}/` : `./data/gachaJson/${this.e.user_id}/`

    const gsPool = [
      { type: 301, typeName: "角色" },
      { type: 302, typeName: "武器" },
      { type: 500, typeName: "集录" },
      { type: 200, typeName: "常驻" }
    ]

    const srPool = [
      { type: 11, typeName: "角色" },
      { type: 12, typeName: "光锥" },
      { type: 21, typeName: "角色联动" },
      { type: 22, typeName: "光锥联动" },
      { type: 1, typeName: "常驻" },
      { type: 2, typeName: "新手" }
    ]

    this.pool = e.isSr ? srPool : gsPool
  }

  async logUrl() {
    let url = this.e.msg

    /** 处理url */
    let param = this.dealUrl(url)
    if (!param) return

    if (!await this.checkUrl(param)) return

    this.e.reply("链接发送成功，数据获取中……")

    // 是否全量更新抽卡记录
    this.fetchFullLog = await this.isFetchFullLog()

    /** 制作合并消息 */
    let MakeMsg = []
    let tmpMsg = ""
    /** 按卡池更新记录 */
    for (let i in this.pool) {
      this.type = this.pool[i].type
      this.typeName = this.pool[i].typeName
      let res = await this.updateLog()
      if (res) {
        tmpMsg += `[${this.typeName}]记录获取成功，更新${res.num}条\n`
      }
      if (i <= 1) await common.sleep(500)
    }
    MakeMsg.push(tmpMsg)
    const miaoPrefix = this?.e?.isSr ? "#星铁喵喵" : "#喵喵"
    MakeMsg.push(`\n抽卡记录更新完成。记录展示与统计请使用 Miao-Plugin：\n【${miaoPrefix}抽卡记录】查看记录\n【${miaoPrefix}抽卡统计】查看统计\n【${this?.e?.isSr ? "*" : "#"}导出记录】导出记录数据`)
    await this.e.reply(MakeMsg)

    if (this.fetchFullLog) {
      await this.setFetchFullLog(false)
    }

    return true
  }

  dealUrl(url) {
    // 已明确识别为充值/自助查询的链接不进入抽卡模块，避免 csc authkey 被误校验。
    const link = inspectRecordLink(url)
    if (link.isSrPay) return false

    // timestamp=1641338980〈=zh-cn 修复链接有奇怪符号
    url = url.replace(/〈=/g, "&")
    if (url.includes("getGachaLog?")) url = url.split("getGachaLog?")[1]
    if (url.includes("index.html?")) url = url.split("index.html?")[1]

    // 处理参数
    let arr = new URLSearchParams(url).entries()

    let params = {}
    for (let val of arr) {
      params[val[0]] = val[1]
    }

    if (!params.authkey) {
      this.e.reply("链接复制错误")
      return false
    }

    // 去除#/,#/log
    params.authkey = params.authkey.replace(/#\/|#\/log/g, "")

    return params
  }

  async checkUrl(param) {
    if (!param.region) {
      let res = await this.logApi({
        size: 6,
        authkey: param.authkey,
        region: this.e.isSr ? "prod_gf_cn" : "cn_gf01"
      })
      if (!res?.data?.region) {
        res = await this.logApi({
          size: 6,
          authkey: param.authkey,
          region: this.e.isSr ? "prod_official_usa" : "os_usa"
        })
      }

      if (res?.data?.region) {
        param.region = res?.data?.region
      } else {
        await this.e.reply("链接复制错误或已失效")
        return false
      }
    }

    let res = await this.logApi({
      size: 6,
      authkey: param.authkey,
      region: param.region
    })

    if (res.retcode == -109) {
      await this.e.reply("2.3版本后，反馈的链接已无法查询！请用安卓方式获取链接")
      return false
    }

    if (res.retcode == -101) {
      await this.e.reply("该链接已失效，请重新进入游戏，重新复制链接")
      return false
    }
    if (res.retcode == 400) {
      await this.e.reply("获取数据错误")
      return false
    }
    if (res.retcode == -100) {
      if (this.e.msg.length == 1000) {
        await this.e.reply("输入法限制，链接复制不完整，请更换输入法复制完整链接")
        return false
      }
      await this.e.reply("链接不完整，请长按全选复制全部内容（可能输入法复制限制），或者复制的不是历史记录页面链接")
      return false
    }
    if (res.retcode != 0) {
      await this.e.reply("链接复制错误")
      return false
    }

    if (res?.data?.list && res.data.list.length > 0) {
      this.uid = res.data.list[0].uid
      await redis.setEx(this.uidKey, 3600 * 24 * 30, String(this.uid))

      /** 保存authkey */
      await redis.setEx(`${this.urlKey}${this.uid}`, 86400, param.authkey)

      return true
    } else {
      await this.e.reply("暂无数据，请等待记录后再查询")
      return false
    }
  }

  async logApi(param) {
    // 调用一次接口判断链接是否正确
    let logUrl = "https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog?"
    /** 国际服 */
    if (!["cn_gf01", "cn_qd01"].includes(param.region)) {
      logUrl = "https://public-operation-hk4e-sg.hoyoverse.com/gacha_info/api/getGachaLog?"
    }

    let logParam = new URLSearchParams({
      authkey_ver: 1,
      lang: "zh-cn", // 只支持简体中文
      gacha_type: 301,
      page: 1,
      size: 20,
      end_id: 0,
      ...param
    }).toString()
    const isLd = [21, 22].includes(param.gacha_type)
    let GachaLog =  isLd ? 'getLdGachaLog' : 'getGachaLog'
    if (this.e.isSr) {
      logUrl = `https://public-operation-hkrpg.mihoyo.com/common/gacha_record/api/${GachaLog}?`
      if (!["prod_gf_cn", "prod_qd_cn"].includes(param.region)) {
        logUrl = `https://public-operation-hkrpg-sg.hoyoverse.com/common/gacha_record/api/${GachaLog}?`
      }
      logParam = new URLSearchParams({
        authkey_ver: 1,
        lang: "zh-cn", // 只支持简体中文
        gacha_type: 11,
        page: 1,
        size: 20,
        game_biz: "hkrpg_cn",
        end_id: 0,
        ...param
      }).toString()
    }
    let res = await fetch(logUrl + logParam).catch((err) => {
      logger.error(`[获取抽卡记录失败] ${err}`)
    })
    if (!res || !res.ok) {
      return { retcode: 400 }
    }
    return await res.json()
  }

  async setFetchFullLog(flag) {
    const redisKey = `Yz:settings:fetchFullLog:${this.userId}`
    if (flag) {
      await redis.set(redisKey, 1, { EX: 600 })
      return this.e.reply("已开启全量更新抽卡记录，在10分钟内您的首次抽卡记录将全量更新，用于修复在官方记录有效期内可能发生的数据错误")
    } else {
      await redis.del(redisKey)
      return this.e.reply("已关闭全量更新抽卡记录")
    }
  }

  async isFetchFullLog() {
    const redisKey = `Yz:settings:fetchFullLog:${this.userId}`
    return !!(await redis.get(redisKey))
  }

  /** 更新抽卡记录 */
  async updateLog() {
    /** 获取authkey */
    let authkey = await redis.get(`${this.urlKey}${this.uid}`)
    if (!authkey) return false

    /** 调一次接口判断是否有效 */
    let res = await this.logApi({ gacha_type: this.type, authkey, region: this.getServer() })

    /** key过期，或者没有数据 */
    if (res.retcode !== 0 || !res?.data?.list || res.data.list.length <= 0) {
      logger.debug(`${this.e.logFnc} ${res.message || "error"}`)
      return false
    }

    logger.mark(`${this.e.logFnc}[UID:${this.uid}] 开始获取：${this.typeName}记录...`)
    let all = []

    let logJson = this.readJson()
    /** 第一次获取增加提示 */
    if (lodash.isEmpty(logJson.list) && this.type === 301) {
      await this.e.reply(`开始获取${this.typeName}记录，首次获取数据较多，请耐心等待...`)
    } else if (this.fetchFullLog && this.type === 301) {
      await this.e.reply(`开始获取${this.typeName}记录，全量更新获取数据较多，请耐心等待...`)
    }

    let logRes = await this.getAllLog(logJson.ids, authkey)
    if (logRes.hasErr) {
      this.e.reply(`获取${this.typeName}记录失败`)
      return false
    }

    /** 数据合并 */
    let num = logRes.list.length
    if (num > 0) {
      if (this.fetchFullLog) {
        all = this.mergeGachaData(logRes.list, logJson.list)
      } else {
        all = logRes.list.concat(logJson.list)
      }

      /** 保存json */
      this.writeJson(all)
    }

    return { num }
  }

  // 合并抽卡记录
  mergeGachaData(remoteList, localList) {
    if (remoteList.length === 0) return localList
    if (localList.length === 0) return remoteList
    // 远程记录的最后一条数据id
    const remoteLastId = remoteList[remoteList.length - 1].id;
    if (!remoteLastId) {
      // 可能是mhy数据又出错了
      return remoteList.concat(localList);
    }
    const findIdx = localList.findIndex((item) => item.id === remoteLastId);
    if (findIdx === -1) {
      return remoteList.concat(localList);
    }
    // 截取本地数据并合并
    return remoteList.concat(localList.slice(findIdx + 1));
  }

  /** 递归获取所有数据 */
  async getAllLog(ids, authkey, page = 1, endId = 0) {

    /** 延迟下防止武器记录获取失败 */
    await common.sleep(1000)

    let res = await this.logApi({
      gacha_type: this.type,
      page,
      end_id: endId,
      authkey,
      region: this.getServer()
    })

    if (res.retcode != 0) {
      return { hasErr: true, list: [] }
    }

    if (!res?.data?.list || res.data.list.length <= 0) {
      logger.mark(`${this.e.logFnc}[UID:${this.uid}] 获取${this.typeName}记录完成，共${Number(page) - 1}页`)
      return { hasErr: false, list: [] }
    }

    let list = []
    for (let val of res.data.list) {
      if (!this.fetchFullLog && ids.get(String(val.id))) {
        logger.mark(`${this.e.logFnc}[UID:${this.uid}] 获取${this.typeName}记录完成，暂无新记录`)
        return { hasErr: false, list }
      } else {
        list.push(val)
        endId = val.id
      }
    }
    page++

    if (page % 3 == 0) {
      await common.sleep(500)
    } else {
      await common.sleep(300)
    }

    let res2 = await this.getAllLog(ids, authkey, page, endId)

    list = list.concat(res2.list)

    return { hasErr: res2.hasErr, list }
  }

  // 读取本地json
  readJson() {
    let logJson = []
    let ids = new Map()
    let file = `${this.path}/${this.uid}/${this.type}.json`
    if (fs.existsSync(file)) {
      // 获取本地数据 进行数据合并
      logJson = JSON.parse(fs.readFileSync(file, "utf8"))
      for (let val of logJson) {
        if (val.id) {
          ids.set(String(val.id), val.id)
        }
      }
    }

    return { list: logJson, ids }
  }

  creatFile() {
    if (!fs.existsSync(this.path)) {
      fs.mkdirSync(this.path)
    }
    if (!this.uid) return
    let file = `${this.path}${this.uid}/`
    if (!fs.existsSync(file)) {
      fs.mkdirSync(file)
    }
  }

  writeJson(data) {
    this.creatFile()

    let file = `${this.path}${this.uid}/`

    fs.writeFileSync(`${file}${this.type}.json`, JSON.stringify(data, "", "\t"))
  }

  getServer() {
    switch (String(this.uid).slice(0, -8)) {
      case "1":
      case "2":
        return this.e.isSr ? "prod_gf_cn" : "cn_gf01" // 官服
      case "5":
        return this.e.isSr ? "prod_qd_cn" : "cn_qd01" // B服
      case "6":
        return this.e.isSr ? "prod_official_usa" : "os_usa" // 美服
      case "7":
        return this.e.isSr ? "prod_official_euro" : "os_euro" // 欧服
      case "8":
      case "18":
        return this.e.isSr ? "prod_official_asia" : "os_asia" // 亚服
      case "9":
        return this.e.isSr ? "prod_official_cht" : "os_cht" // 港澳台服
    }
    return "cn_gf01"
  }
}
