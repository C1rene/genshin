import plugin from '../../../lib/plugins/plugin.js'
import common from '../../../lib/common/common.js'
import Cfg from '../model/Cfg.js'
import User from '../model/user.js'
import MysApi from '../model/mys/mysApi.js'
import MysInfo from '../model/mys/mysInfo.js'
import qrcode from '../model/qrCode.js'
import GachaLog from '../model/gachaLog.js'

let refreshingAllCk = false

export class qrCode extends plugin {
    constructor() {
        super({
            name: 'genshin·刷新',
            dsc: 'Stoken 绑定、Cookie 刷新及抽卡链接',
            event: 'message',
            priority: Cfg.getConfig('config').priority,
            rule: [
                {
                    reg: '^#?(刷新|更新)全部(c|C)(oo)?k(ie)?$',
                    permission: 'master',
                    fnc: 'upAllCookie'
                },
                {
                    reg: '^#?(原神|星铁|绝区零)?(刷新|更新)(c|C)(oo)?k(ie)?$',
                    fnc: 'upCookie'
                },
                {
                    reg: '^#?(原神|星铁|绝区零)?绑定(s|S)(to)?k(en)?$',
                    fnc: 'bindStoken'
                },
                {
                    reg: '^#?米币查询$',
                    fnc: 'bbsisSign'
                },
                {
                    reg: '^#?(我的|删除)(s|S)(to)?k(en)?$',
                    fnc: 'getStoken'
                },
                {
                    reg: '^#?(原神|星铁|绝区零)?(s|S)(to)?k(en)?(帮助|教程)$',
                    fnc: 'helpStoken'
                },
                {
                    reg: "^#?(刷新|更新|获取)抽卡(链接|记录)?$",
                    fnc: 'refreshGachaLog'
                }
            ]
        })
    }

    async helpStoken(e) {
        let gametype = e.game == 'zzz' ? '%' : e.game == 'sr' ? '*' : '#'
        let msgs = [
            '[stoken帮助]',
            '支持国服与国际服：',
            '1、使用抓包软件抓取米游社/Hoyolab APP 的请求',
            '2、在请求头 Cookie 中找到 stuid、stoken、mid（ltoken 可选）',
            '3、自行构造如下格式的 Stoken 信息：',
            '{"stuid":"抓取的stuid","stoken":"抓取的stoken","mid":"抓取的mid"}',
            '4、先绑定对应游戏 UID，再发送“绑定sk”指令',
            '5、按提示发送 Stoken 信息，绑定成功后可使用“刷新ck”换取 Cookie',
            '也可以由其他插件将 Stoken 记录写入本插件的 yaml 账号数据。'
        ]
        return e.reply([msgs.join('\n'), segment.button([
            { text: `${gametype}绑定sk`, callback: `${gametype}绑定sk` },
            { text: `${gametype}刷新ck`, callback: `${gametype}刷新ck` }
        ])])
    }

    async bbsisSign(e) {
        let { sks, ltuids } = await new qrcode(e).getStoken(e, true)

        let msgs = []
        for (let i of ltuids) {
            let mysApi = new MysApi(sks[i].stuid, sks[i].sk, { game: 'bbs' }, sks[i].region)

            let res = await mysApi.getData('bbsisSign')
            if (!res?.data) {
                msgs.push(`stuid：${sks[i].stuid}，请求异常：${res.message}`)
  		    } else {
                msgs.push(`米游社通行证：${sks[i].stuid}`)
                msgs.push(`当前米游币数量为：${res.data.total_points}，今日剩余可获取：${res.data.can_get_points}`)
            }
            msgs.push('*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-')
        }
        msgs = msgs.join('\n')
        return e.reply(msgs)
    }

    async getStoken(e) {
        if(e.group) return e.reply('请私聊发送指令')
        let { sks, ltuids } = await new qrcode(e).getStoken(e)

        let msgs = []
        msgs.push('stoken绑定信息：')
        if (e.msg.match('删除')) {
            for (let i of ltuids) {
                await Cfg.delsk(e.user_id, sks[i].stuid)
                msgs.push(`已删除stoken：${sks[i].stuid}`)
                msgs.push('*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-')
            }
            msgs = msgs.join('\n')
            return e.reply(msgs)
        }

        for (let i of ltuids) {
            msgs.push(`米游社通行证：${sks[i].stuid}`)
            msgs.push(`stoken：${sks[i].sk}`)
            msgs.push('*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-')
        }
        msgs = msgs.join('\n')
        return e.reply(msgs)
    }

    /** 复用 MysApi 的统一服别判断与 Stoken 交换逻辑。 */
    async exchangeCkBySk(sk, records = []) {
        return await MysApi.exchangeStoken(sk, records)
    }

    async upCookie(e) {
        // 允许没有旧 ltoken 的 SK 参与刷新；服别由 game_biz / region_name / region 综合判断。
        let { sks, ltuids } = await new qrcode(e).getStoken(e, false, true)
        if (!sks || !ltuids?.length) return false

        for (let id of ltuids) {
            const sk = sks[id]
            const ret = await this.exchangeCkBySk(sk, sk.roles || [sk])
            if (!ret.ok) {
                await e.reply(`stuid:${sk.stuid}，${ret.reason}`)
                continue
            }

            e.ck = ret.ck
            const bound = await new User(e).bing()
            if (bound) {
                Cfg.updateSkLtoken(sk.stuid, ret.ltoken)
                MysApi.ckRefreshCache.set(String(sk.stuid), {
                    at: Date.now(),
                    ret: { ok: true, ck: ret.ck, ltuid: String(sk.stuid), qq: e.user_id, ltoken: ret.ltoken }
                })
                MysApi.skScanCache = null
                await e.reply(`stuid:${sk.stuid}，Cookie 刷新成功`)
            }
        }
    }

    /** 主人指令：按 stuid 去重，汇总所有角色区服证据后批量刷新 Cookie。 */
    async upAllCookie(e) {
        if (refreshingAllCk) {
            return e.reply('刷新全部ck任务正在进行中，请稍后再试')
        }

        const skMap = await Cfg.getsks(true, '', false, true)
        const entries = Object.values(skMap || {})
        if (!entries.length) return e.reply('暂无已绑定的stoken数据')

        const groups = new Map()
        for (const entry of entries) {
            const stuid = String(entry.stuid || '')
            if (!stuid) continue
            if (!groups.has(stuid)) groups.set(stuid, { stuid, bindings: [], roles: [] })
            const group = groups.get(stuid)
            group.bindings.push(entry)
            const roles = Array.isArray(entry.roles) && entry.roles.length ? entry.roles : [entry]
            for (const role of roles) {
                const normalized = {
                    ...role,
                    legacyType: role.legacyType ?? entry.legacyType ?? entry.type
                }
                const key = [normalized.uid, normalized.game_biz, normalized.region_name, normalized.region, normalized.legacyType].join('|')
                if (!group.roles.some(item => [item.uid, item.game_biz, item.region_name, item.region, item.legacyType].join('|') === key)) {
                    group.roles.push(normalized)
                }
            }
        }

        const list = [...groups.values()]
        if (!list.length) return e.reply('没有找到可刷新的 Stoken 记录')

        refreshingAllCk = true
        const start = Date.now()
        let successCount = 0
        let bindingSuccessCount = 0
        const skFailList = []
        const ambiguousList = []
        const bindFailList = []

        try {
            await e.reply(`开始刷新全部ck，共 ${list.length} 个 Stuid 账号，请稍候...`)

            for (let idx = 0; idx < list.length; idx++) {
                const group = list[idx]
                const bindings = group.bindings
                const representative = bindings.find(item => item.stoken && item.mid && item.userId)
                    || bindings.find(item => item.stoken && item.mid)
                    || bindings[0]
                const stokens = [...new Set(bindings.map(item => String(item.stoken || '')).filter(Boolean))]
                const mids = [...new Set(bindings.map(item => String(item.mid || '')).filter(Boolean))]

                try {
                    if (stokens.length !== 1 || mids.length !== 1) {
                        ambiguousList.push(`stuid:${group.stuid} - 同一账号存在多份不同 Stoken 或 MID`)
                        continue
                    }
                    if (!representative?.stoken || !representative?.mid) {
                        skFailList.push(`stuid:${group.stuid} - Stoken 或 MID 不完整`)
                        continue
                    }

                    const sk = {
                        ...representative,
                        stuid: group.stuid,
                        stoken: stokens[0],
                        mid: mids[0],
                        roles: group.roles,
                        sk: `stuid=${group.stuid};stoken=${stokens[0]};mid=${mids[0]};${representative.ltoken ? `ltoken=${representative.ltoken};` : ''}`
                    }
                    const ret = await this.exchangeCkBySk(sk, group.roles)
                    if (!ret.ok) {
                        const line = `QQ:${[...new Set(bindings.map(item => String(item.userId || '')).filter(Boolean))].join('/')} (stuid:${group.stuid}) - ${ret.reason}`
                        if (ret.ambiguous) ambiguousList.push(line)
                        else skFailList.push(line)
                        logger.warn(`[刷新全部ck] stuid:${group.stuid} 交换失败：${ret.reason}`)
                        continue
                    }

                    const userIds = [...new Set(bindings.map(item => String(item.userId || '')).filter(Boolean))]
                    if (!userIds.length) {
                        bindFailList.push(`stuid:${group.stuid} - 缺少绑定 QQ，无法通过 User.bing 保存`)
                        continue
                    }

                    let accountSaved = false
                    for (const userId of userIds) {
                        const bindEvent = {
                            user_id: userId,
                            ck: ret.ck,
                            AutoupCookie: true,
                            logFnc: '[刷新全部ck]'
                        }
                        try {
                            const ok = await new User(bindEvent).bing()
                            if (ok) {
                                accountSaved = true
                                bindingSuccessCount++
                            } else {
                                bindFailList.push(`QQ:${userId} (stuid:${group.stuid}) - CK 校验或保存失败`)
                            }
                        } catch (error) {
                            bindFailList.push(`QQ:${userId} (stuid:${group.stuid}) - ${error?.message || '未知异常'}`)
                        }
                    }

                    if (accountSaved) {
                        successCount++
                        Cfg.updateSkLtoken(group.stuid, ret.ltoken)
                        MysApi.ckRefreshCache.set(group.stuid, {
                            at: Date.now(),
                            ret: { ok: true, ck: ret.ck, ltuid: group.stuid, qq: userIds[0], ltoken: ret.ltoken }
                        })
                        MysApi.skScanCache = null
                        logger.mark(`[刷新全部ck]更新成功 (${idx + 1}/${list.length}) stuid:${group.stuid} server:${ret.serverType}`)
                    }
                } catch (error) {
                    bindFailList.push(`stuid:${group.stuid} - ${error?.message || '未知异常'}`)
                    logger.error(`[刷新全部ck]处理异常 stuid:${group.stuid}`, error)
                }

                finally {
                    if (idx < list.length - 1) {
                        await common.sleep(1000 + Math.floor(Math.random() * 1000))
                    }
                }
            }

            const elapsed = Cfg.countTime(Math.max(1, Math.round((Date.now() - start) / 1000)))
            const msgs = [
                '【刷新全部ck完成】',
                `账号：${list.length} | 成功：${successCount} | 成功绑定关系：${bindingSuccessCount} | SK 失效/异常：${skFailList.length} | 区服不明确：${ambiguousList.length} | 绑定失败：${bindFailList.length}`,
                `总耗时：${elapsed}`
            ]

            const appendFailList = (title, items) => {
                if (!items.length) return
                msgs.push(`\n${title}：`)
                msgs.push(...items.slice(0, 15))
                if (items.length > 15) msgs.push(`...其余 ${items.length - 15} 条请查看控制台日志`)
            }
            appendFailList('SK 失效/异常列表', skFailList)
            appendFailList('区服冲突/无法判断列表', ambiguousList)
            appendFailList('CK 绑定失败列表', bindFailList)

            await e.reply(msgs.join('\n'))
        } finally {
            refreshingAllCk = false
        }
    }

    async bindStoken(e) {
        if(e.group) return e.reply('请私聊发送指令')
        let uid = await MysInfo.getUid(e, false)
        if (!uid) return e.reply('请绑定uid后再操作')
        let game = e.game
        await redis.set(`genshin:bindStoken:${e.user_id}:uid`, uid, {
            EX: 120
        })
        await redis.set(`genshin:bindStoken:${e.user_id}:game`, game, {
            EX: 120
        })
        //先throw一步
        this.setContext('toBindStoken')
        await e.reply(`为UID ${uid}绑定stoken，请发送stoken信息，或者发送“取消”取消绑定`, false, { at: true, recallMsg: 100 })
    }

    async toBindStoken() {
        let raw = this.e.msg.trim()
        if (raw.includes('取消')) {
            await this.e.reply('已取消', false, { at: true, recallMsg: 100 })
            this.finish('toBindStoken')
            return false
        }
        let info
        try {
            info = JSON.parse(raw)
        } catch (error) {
            await this.e.reply('Stoken 信息格式错误，请发送 JSON 格式内容')
            this.finish('toBindStoken')
            return false
        }
        if (!info?.stuid || !info?.stoken || !info?.mid) {
            await this.e.reply('Stoken 信息格式错误，至少需要 stuid、stoken、mid')
            this.finish('toBindStoken')
            return false
        }

        let sk = `stuid=${info.stuid};stoken=${info.stoken};mid=${info.mid};`
        let uid = await redis.get(`genshin:bindStoken:${this.e.user_id}:uid`)
        let game = await redis.get(`genshin:bindStoken:${this.e.user_id}:game`) || this.e.game || 'gs'
        if (!uid || !game) {
            await this.e.reply('绑定信息已过期，请重新发送绑定sk指令')
            this.finish('toBindStoken')
            return false
        }

        let mysApi = new MysApi(uid, sk, { game, log: false })
        let ltoken = ''
        let cookieToken = ''
        if (!/cn_|_cn/.test(mysApi.getServer())) {
            let res = await mysApi.getData('getBySToken')
            let tokens = res?.data?.tokens || []
            ltoken = (tokens.find(item => Number(item.token_type) === 2) || tokens[0])?.token || ''
            cookieToken = (tokens.find(item => Number(item.token_type) === 4) || tokens[1])?.token || ''
        } else {
            let ltokenRes = await mysApi.getData('exchange', { token: info.stoken, type: 2, mid: info.mid })
            if (!ltokenRes?.data?.token?.token) {
                await this.e.reply(`绑定Stoken失败，获取Ltoken异常：${ltokenRes?.message || '接口返回为空'}`)
                this.finish('toBindStoken')
                return false
            }
            let cookieRes = await mysApi.getData('exchange', { token: info.stoken, type: 4, mid: info.mid })
            if (!cookieRes?.data?.token?.token) {
                await this.e.reply(`绑定Stoken失败，获取Cookie Token异常：${cookieRes?.message || '接口返回为空'}`)
                this.finish('toBindStoken')
                return false
            }
            ltoken = ltokenRes.data.token.token
            cookieToken = cookieRes.data.token.token
        }

        if (!ltoken || !cookieToken) {
            await this.e.reply('绑定Stoken失败，未能交换出完整的 Ltoken 和 Cookie Token，请确认 Stoken 是否有效')
            this.finish('toBindStoken')
            return false
        }

        info.ltoken = ltoken
        this.e.ck = MysApi.buildV2Ck({ ltuid: info.stuid, ltoken, cookieToken, mid: info.mid })

        mysApi = new MysApi(uid, this.e.ck, { game, log: false })
        let res = await mysApi.getData('UserGame')
        let list = res?.data?.list || []
        if (list.length === 0) {
            await this.e.reply('绑定Stoken失败，未查询到游戏 UID，请确认账号已绑定对应游戏角色')
            this.finish('toBindStoken')
            return false
        }

        let msg = await new qrcode(this.e).bindStoken(this.e, list, info)
        await this.e.reply(msg)
        await new User(this.e).bing()
        MysApi.ckRefreshCache.set(String(info.stuid), { at: Date.now(), ret: { ok: true, ck: this.e.ck, ltuid: String(info.stuid), qq: this.e.user_id } })
        MysApi.skScanCache = null
        this.finish('toBindStoken')
        return false
    }

    async refreshGachaLog(e) {
        if (e.group && e.msg.match('获取')) return e.reply('请私聊发送指令')
        let uid = await MysInfo.getUid(e, false)
        if (!uid) return e.reply('请绑定uid后再操作')
        let game = e.game || (e.isSr ? 'sr' : e.isZzz ? 'zzz' : 'gs')
        let ckUser = await MysInfo.checkUidBing(uid, game)
        if (!ckUser?.ck) return e.reply([`UID：${uid}未绑定Cookie，请先绑定sk或绑定Cookie，再尝试【#刷新ck】`, segment.button([
            { text: '#刷新ck', callback: '#刷新ck' }
        ])])

        let ck = ckUser.ck
        let mysApi
        let authkey
        let region
        let isGlobal = /^(1[0-9]|[6-9])[0-9]{8}/i.test(String(uid))

        if (isGlobal) {
            // 国际服直接使用已绑定 Cookie Token 获取 AuthKey，不再依赖本插件保存 Stoken。
            mysApi = new MysApi(uid, ck, { game, device: ckUser.device })
            let res = await mysApi.getData('AuthKeyByCookieToken')
            if (!res?.data?.authkey) return e.reply(`authkey获取失败，异常：${res?.message || '接口返回为空'}`)
            authkey = res.data.authkey
            region = mysApi.getServer()

            let url = `https://public-operation-hk4e-sg.hoyoverse.com/gacha_info/api/getGachaLog?authkey_ver=1&sign_type=2&auth_appid=webview_gacha&init_type=301&gacha_id=1fb9ed6285b467a840231a4e839c00171550e217&timestamp=${Math.floor(Date.now() / 1000)}&lang=zh-cn&device_type=mobile&plat_type=ios&region=${region}&authkey=${encodeURIComponent(authkey)}&game_biz=hk4e_global&gacha_type=301&page=1&size=20&end_id=0`
            if (e.msg.match('获取')) return e.reply(`UID：${uid}抽卡链接：\n${url}`)
            e.msg = url
            await new GachaLog(e).logUrl()
            return
        }

        let ltuidMatch = String(ck).match(/ltuid=(\d+)|ltuid_v2=(\d+)/)
        let ltuid = ltuidMatch?.[1] || ltuidMatch?.[2]
        if (!ltuid) return e.reply('当前 Cookie 无法识别 ltuid')

        // 全局扫描已保存的 Stoken，兼容由其他插件写入到其他用户 YAML 的同账号记录。
        let sks = await Cfg.getsks(true, '', false, true)
        let matches = Object.values(sks || {}).filter(item => String(item.stuid) === String(ltuid))
        let sk = matches.find(item => item.type === 'mys' || /cn_|_cn/.test(item.region || '')) || matches[0]
        if (!sk) return e.reply(`未找到 ltuid:${ltuid} 对应的 Stoken，请确认其他插件已写入绑定信息`)

        mysApi = new MysApi(uid, sk.sk, { game, log: false, device: ckUser.device })
        let res = await mysApi.getData('AuthKey')
        if (!res?.data?.authkey) return e.reply(`authkey获取失败，异常：${res?.message || '接口返回为空'}`)
        authkey = res.data.authkey
        region = mysApi.getServer()

        let url = `https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog?authkey_ver=1&sign_type=2&auth_appid=webview_gacha&init_type=301&gacha_id=fecafa7b6560db5f3182222395d88aaa6aaac1bc&timestamp=${Math.floor(Date.now() / 1000)}&lang=zh-cn&device_type=mobile&plat_type=ios&region=${region}&authkey=${encodeURIComponent(authkey)}&game_biz=hk4e_cn&gacha_type=301&page=1&size=20&end_id=0`
        if (e.msg.match('获取')) return e.reply(`UID：${uid}抽卡链接：\n${url}`)
        e.msg = url
        await new GachaLog(e).logUrl()
    }
}
