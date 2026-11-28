import plugin from '../../../lib/plugins/plugin.js'
import { SrPayData, renderImg } from '../model/srPayLogData.js'
import NoteUser from '../model/mys/NoteUser.js'
import fs from 'fs'
import path from 'path'
import yaml from 'yaml'
import { inspectRecordLink } from '../model/recordLinkType.js'

export class srPayLog extends plugin {
  dirPath = path.resolve('./data/srPayLog/')
  authKey = ''

  constructor () {
    super({
      name: '星铁充值记录',
      dsc: '古老梦华与星琼充值记录,充值统计,消费统计',
      event: 'message',
      priority: 299,
      rule: [
        {
          reg: '^#?(星铁|星穹铁道)?(充值|消费|古老梦华)(记录|统计)$',
          fnc: 'payLog'
        },
        {
          reg: '^#?更新(星铁|星穹铁道)?(充值|消费|古老梦华)(记录|统计)$',
          fnc: 'updatePayLog'
        },
        {
          reg: '(.*)(self-help-query|hkrpg_self_help_inquiry|user-game-search|bill-record-user|customer-claim|player-log|auth_appid=csc|user\\.mihoyo\\.com)(.*)',
          fnc: 'getAuthKey'
        },
        {
          reg: '^#?(星铁|星穹铁道)?(充值|消费|古老梦华)(记录|统计)帮助$',
          fnc: 'payLogHelp'
        }
      ]
    })
  }

  async payLog (e) {
    if (!fs.readdirSync(this.dirPath, 'utf-8').includes(e.user_id + '.yaml')) {
      await this.updatePayLog()
      return true
    }

    const mainUid = await this.isMain(e.user_id)

    let data = fs.readFileSync(this.dirPath + `/${e.user_id}.yaml`, 'utf-8')
    data = yaml.parse(data)

    if (!mainUid) {
      let key = Object.keys(data)
      let img = await renderImg(data[key[0]])
      this.reply(img)
      return true
    }

    if (data[mainUid]) {
      let img = await renderImg(data[mainUid])
      this.reply(img)
      return true
    } else {
      this.reply('当前绑定的星铁uid未获取数据，请私聊获取')
      return false
    }
  }

  async getAuthKey () {
    const link = inspectRecordLink(this.e.msg)

    // 明确的抽卡链接必须放行给 gcLog，绝不能拿 webview_gacha authkey 请求充值接口。
    if (link.isGacha) {
      return false
    }

    // `hkrpg` 只代表星铁，不代表充值。只有“星铁 + 充值业务特征”同时满足才处理。
    if (!link.isSrPay) {
      return false
    }

    if (this.e.isGroup) {
      return false
    }

    if (!link.authkey) {
      this.reply('链接无效,请重新发送')
      return false
    }

    this.authKey = link.authkey

    // 手动粘贴链接时，优先沿用链接自身 region，避免依赖外部事件是否预先填充。
    const region = this.e.region || link.region || ''

    this.reply('正在获取星铁消费数据,可能需要30s~~')

    let data = new SrPayData(this.authKey, this.e.uid, region)
    let imgData = await data.filtrateData()

    if (imgData?.errorMsg) {
      this.reply(imgData.errorMsg)
      return true
    }

    let img = await renderImg(imgData)
    this.reply(img)

    await this.writeData(imgData)
    await redis.setEx(`Yz:starrail:mys:qq-uid:${this.e.user_id}`, 3600 * 24 * 30, imgData.uid)
    await redis.setEx(`Yz:starrail:payLog:${imgData.uid}`, 3600 * 24, this.authKey)
    if (region) {
      await redis.setEx(`Yz:starrail:payLogRegion:${imgData.uid}`, 3600 * 24 * 30, region)
    }
    return true
  }

  async updatePayLog (e) {
    let uid = await redis.get(`Yz:starrail:mys:qq-uid:${this.e.user_id}`)

    if (uid) {
      let mainUid = await this.isMain(this.e.user_id)
      if (mainUid) uid = mainUid

      this.authKey = await redis.get(`Yz:starrail:payLog:${uid}`)

      if (this.authKey) {
        this.reply('正在获取星铁数据,可能需要30s')

        const region = this.e.region || await redis.get(`Yz:starrail:payLogRegion:${uid}`) || ''
        let imgData = await new SrPayData(this.authKey, uid, region).filtrateData()

        if (imgData?.errorMsg) {
          this.reply(imgData.errorMsg)
        } else {
          let img = await renderImg(imgData)
          this.reply(img)
          await this.writeData(imgData)
        }

        return true
      } else {
        this.reply('请先通过小逍遥的【#刷新星铁充值记录】获取一次星铁充值数据')
      }
    } else {
      this.reply('请先通过小逍遥的【#刷新星铁充值记录】获取一次星铁充值数据')
    }

    return true
  }

  payLogHelp (e) {
    e.reply("先发「#扫码登录」，使用米游社或扫码器扫描二维码登录后，再发「#刷新充值记录」或「*刷新充值记录」获取原神/星铁充值记录。")
  }

  async isMain (id, game = 'sr') {
    let user = await NoteUser.create(id)
    return user.getCkUid(game)
  }

  async writeData (imgData) {
    let userPath = this.dirPath + '/' + this.e.user_id + '.yaml'

    if (fs.readdirSync(this.dirPath).includes(`${this.e.user_id}.yaml`)) {
      let data = fs.readFileSync(userPath, 'utf-8')
      data = yaml.parse(data)
      data[imgData.uid] = imgData
      fs.writeFileSync(userPath, yaml.stringify(data), 'utf-8')
    } else {
      let data = {}
      data[imgData.uid] = imgData
      fs.writeFileSync(userPath, yaml.stringify(data), 'utf-8')
    }
  }
}
