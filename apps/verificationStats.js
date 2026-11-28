import plugin from '../../../lib/plugins/plugin.js'
import VerificationStats from '../model/VerificationStats.js'

export class verificationStats extends plugin {
  constructor() {
    super({
      name: 'genshin·过码统计',
      dsc: '查看验证码触发与通过次数',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#全部过码次数$',
          permission: 'master',
          fnc: 'getAllVerificationCount'
        },
        {
          reg: '^#全部过码统计$',
          permission: 'master',
          fnc: 'getAllVerificationStats'
        },
        {
          reg: '^#过码次数$',
          permission: 'master',
          fnc: 'getVerificationCount'
        },
        {
          reg: '^#过码统计$',
          permission: 'master',
          fnc: 'getVerificationStats'
        }
      ]
    })
  }

  async getVerificationCount() {
    const groupId = this.e?.group_id ? String(this.e.group_id) : ''
    return this.sendCount(groupId, groupId ? '本群过码次数统计' : '过码次数统计')
  }

  async getAllVerificationCount() {
    return this.sendCount('', '全部过码次数统计')
  }

  async sendCount(groupId, title) {
    let stats
    try {
      stats = await VerificationStats.getSummary(groupId, this.e)
    } catch (error) {
      logger.error(`[过码统计] 获取统计失败：${error}`)
      await this.reply(groupId ? '无法获取当前群成员或账号绑定列表，暂时无法计算本群统计。' : '读取账号绑定关系失败，暂时无法计算统计。')
      return true
    }
    const lines = [
      title,
      `历史累计：触发 ${stats.lifetime.triggered} | 成功 ${stats.lifetime.passed} | 失败 ${stats.lifetime.failed}`,
      `今日：触发 ${stats.today.triggered} | 成功 ${stats.today.passed} | 失败 ${stats.today.failed}`,
      `本月：触发 ${stats.month.triggered} | 成功 ${stats.month.passed} | 失败 ${stats.month.failed}`
    ]
    if (stats.pendingIncluded) lines.push('备注：总数包含尚未归属到 ltuid 的待归属记录')
    await this.reply(lines.join('\n'))
    return true
  }

  async getVerificationStats() {
    const groupId = this.e?.group_id ? String(this.e.group_id) : ''
    return this.sendImageStats(groupId)
  }

  async getAllVerificationStats() {
    return this.sendImageStats('')
  }

  async sendImageStats(groupId) {
    let data
    try {
      data = await VerificationStats.getReportData({ groupId, e: this.e })
    } catch (error) {
      logger.error(`[过码统计] 获取报表数据失败：${error}`)
      await this.reply(groupId ? '无法获取当前群成员或账号绑定列表，暂时无法生成本群统计。' : '读取账号绑定关系失败，暂时无法生成统计报表。')
      return true
    }
    const image = await this.renderImg('genshin', 'html/admin/geetestStats', data, { retType: 'base64' })
    if (!image) {
      await this.reply('过码统计图片生成失败，请查看后台日志。')
      return true
    }
    await this.reply([image])
    return true
  }
}
