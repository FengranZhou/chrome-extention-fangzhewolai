// Unit test for tracker.js（飞书埋点）：用假 chrome API 跑，不发真实请求。
// 覆盖：未登记不发 / 未登记 update 弹登记页 / 登记后 13 字段 / session 复用 / 断网不抛错
const sent = []
const listeners = {}
let identity = null
let pass = 0, fail = 0
const check = (name, ok) => { if (ok) pass++; else { fail++; console.error('FAIL: ' + name) } }

Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, configurable: true,
})
globalThis.fetch = async (_url, opt) => { sent.push(JSON.parse(opt.body)) }
const sessionStore = {}
globalThis.chrome = {
  storage: {
    local: { get: async () => ({ identity }) },
    session: { get: async () => sessionStore, set: async (o) => { Object.assign(sessionStore, o) } },
  },
  runtime: {
    getManifest: () => ({ version: '9.9.9' }),
    openOptionsPage: () => { sent.push('OPEN_OPTIONS') },
    onInstalled: { addListener: (f) => { listeners.installed = f } },
    onMessage: { addListener: (f) => { listeners.msg = f } },
  },
}
const tick = () => new Promise((r) => setTimeout(r, 10))

const { feishuTrack, feishuFeedback } = await import('../../tracker.js')

await feishuTrack('start')
check('未登记不上报', sent.length === 0)

await listeners.installed({ reason: 'update' }); await tick()
check('未登记 update 时弹登记页', sent.includes('OPEN_OPTIONS'))

identity = { user_id: 'u-test', name: '测试', dept: '体验中心1部' }
sent.length = 0
await feishuTrack('audit-done', 5)
listeners.msg({ type: 'feishu-track', event: 'collect', extra: 3 }); await tick()
check('登记后两条都上报', sent.length === 2)
const keys = ['user_id', 'name', 'dept', 'source', 'asset', 'type', 'trigger', 'session', 'user', 'host', 'extra', 'event', 'version']
check('payload 13 字段齐全', sent[0] && keys.every((k) => k in sent[0]) && Object.keys(sent[0]).length === 13)
check('事件与备注正确', sent[0].event === 'audit-done' && sent[0].extra === '5' && sent[1].event === 'collect')
check('asset/version 正确', sent[0].asset === 'miaoxiang' && sent[0].version === '9.9.9')
check('同一会话 session 复用', sent[0].session === sent[1].session)

sent.length = 0
const fbOk = await feishuFeedback('按钮点不动')
check('反馈：返回 true 且 event/extra 正确', fbOk === true && sent[0].event === 'feedback' && sent[0].extra === '按钮点不动')
check('反馈：带登记身份', sent[0].name === '测试' && Object.keys(sent[0]).length === 13)

identity = null
sent.length = 0
await feishuFeedback('匿名反馈')
check('反馈：未登记也上报，姓名留空', sent.length === 1 && sent[0].name === '' && sent[0].user_id === '')

globalThis.fetch = async () => { throw new Error('offline') }
check('反馈：断网返回 false', (await feishuFeedback('x')) === false)
let threw = false
try { await feishuTrack('start') } catch (_) { threw = true }
check('断网不抛错', !threw)

console.log(`tracker: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
