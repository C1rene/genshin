import plugin from "../../../lib/plugins/plugin.js"
import fs from "node:fs"
import GachaLog from "../model/gachaLog.js"
import ExportLog from "../model/exportLog.js"

const _path = process.cwd() + "/plugins/genshin"

export class gcLog extends plugin {
  constructor() {
    super({
      name: "抽卡记录",
      dsc: "抽卡记录采集、更新、导入与导出",
      event: "message",
      priority: 300,
      rule: [
        {
          reg: "(.*)authkey=(.*)",
          fnc: "logUrl"
        },
        {
          reg: "^#?(原神|星铁)?(强制)?导入记录(json)?$",
          fnc: "logJson"
        },
        {
          reg: "^#?(原神|星铁)?(强制)?导出记录(json)?(v2|v4)?$",
          fnc: "exportLog"
        },
        {
          reg: "^#?(记录帮助|抽卡帮助)$",
          fnc: "help"
        },
        {
          reg: "^#?(安卓|苹果|电脑|pc|ios)帮助$",
          fnc: "helpPort"
        },
        {
          // #设置全量更新抽卡记录
          reg: "^#?设置全量(更新|获取)(抽卡|祈愿)记录\s*(开|关|on|off)?$",
          fnc: "setFetchFullLog"
        },
      ]
    })
  }

  async init() {
    let file = ["./data/gachaJson", "./data/srJson", "./temp/html/StarRail", "./temp/uigf"]
    for (let i of file) {
      if (!fs.existsSync(i)) {
        fs.mkdirSync(i, { recursive: true })
      }
    }
  }

  /** 抽卡记录链接 */
  async logUrl() {
    const updated = await new GachaLog(this.e).logUrl()
    if (!updated) return false

    if (this.e.isGroup)
      await this.e.reply("已收到链接，请撤回", false, { at: true })
    return true
  }

  /** 导出记录 */
  exportLog() {
    if (this.e.isGroup && !this.e.msg.includes("强制")) {
      return this.reply(`建议私聊导出，若你确认要在此导出，请发送【${this.e.game === 'sr' ? '*' : '#'}强制导出记录】`, false, { at: true })
    }
    if (this.e.msg.includes("v2")) {
      this.e.uigfver = 'v2'
    }else {
      this.e.uigfver = 'v4'
    }
    return new ExportLog(this.e).exportJson()
  }

  logJson() {
    if (this.e.isGroup && !this.e.msg.includes("强制")) {
      return this.reply(`建议私聊导入，若你确认要在此导入，请发送【${this.e.game === 'sr' ? '*' : '#'}强制导入记录】`, false, { at: true })
    }
    
    this.setContext("logJsonFile")
    return this.reply("请发送Json文件")
  }

  async logJsonFile() {
    if (!this.e.file && !/https?:\/\//.test(this.e.msg)) return false

    this.finish("logJsonFile")
    await new ExportLog(this.e).logJson()

    if (this.e.isGroup)
      this.reply("已收到文件，请撤回", false, { at: true })
  }

  help() {
    this.e.reply("先发「#扫码登录」，使用米游社或扫码器扫描二维码登录后，再发「#更新抽卡记录」或「wx更新抽卡记录」或「%更新抽卡记录」获取原神/星铁/zzz抽卡记录。\n支持发送抽卡链接导入记录，支持发送json文件导入历史记录。")
  }

  helpPort() {
    this.help()
  }

  async setFetchFullLog() {
    let isOff = this.e.msg.includes("关") || this.e.msg.includes("off")
    await new GachaLog(this.e).setFetchFullLog(!isOff)
  }

}
