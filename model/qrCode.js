import Cfg from './Cfg.js'
import _ from 'lodash'
import base from './base.js'
import { resolveServerType } from './mys/serverType.js'

export default class qrCode extends base {
    constructor(e) {
        super(e)
        this.model = 'qrCode'
    }

    bindStoken(e, list, info) {
        let datalist = {}
        const role = list[0] || {}
        const serverType = resolveServerType([{
            uid: role.game_uid,
            game_biz: role.game_biz || info.game_biz || '',
            region_name: role.region_name,
            region: role.region,
            legacyType: ''
        }])
        datalist[info.stuid] = {
            stuid: info.stuid,
            stoken: info.stoken,
            ltoken: info.ltoken,
            mid: info.mid,
            uid: role.game_uid,
            userId: e.user_id,
            type: serverType.type || '',
            game_biz: role.game_biz || info.game_biz || '',
            region_name: role.region_name,
            region: role.region
        }
        Cfg.saveSk(e.user_id, datalist)
        let msg = 'stoken绑定成功您可通过下列指令进行操作:'
        msg += '\n【#米币查询】查询米游币余额'
        msg += '\n【#mys原神签到】获取米游币'
        msg += '\n【#更新抽卡记录】更新原神抽卡记录'
        msg += '\n【#刷新ck】刷新失效cookie'
        msg += '\n【#我的stoken】查看stoken绑定信息'
        msg += '\n【#删除stoken】删除stoken绑定信息'

        return msg
    }

    async getStoken(e, qrCode, includeIncomplete = false) {
        let sign = qrCode == true ? true : false
        let type = e.game == 'zzz' ? '%' : e.game == 'sr' ? '*' : '#'
        let sks = await Cfg.getsks(false, e.user_id, sign, includeIncomplete)
        if (_.isEmpty(sks)) {
            e.reply([`未找到可用的 Stoken，请先使用【${type}绑定sk】绑定，或确认其他插件已写入 Stoken 数据`, segment.button([
                { text: `${type}绑定sk`, callback: `${type}绑定sk` }
            ])], false, { at: true })
            return false
        }

        let ltuids = _.map(sks, 'id')

        return { sks, ltuids }
    }
}
