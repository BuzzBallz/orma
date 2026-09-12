import xrpl from 'xrpl'
const c = new xrpl.Client('wss://s.devnet.rippletest.net:51233')
await c.connect()
const si = await c.request({ command: 'server_info' })
console.log('rippled build_version :', si.result.info.build_version)
console.log('network_id           :', si.result.info.network_id)
console.log('validated ledger seq :', si.result.info.validated_ledger.seq)
console.log('close_time (ripple)  :', (await c.request({command:'ledger', ledger_index:'validated'})).result.ledger.close_time)
const fs = await c.request({ command:'feature' })
const want = ['LendingProtocol','LendingProtocolV1_1','SingleAssetVault','fixCleanup3_4_0','PermissionedDomains','MPTokensV1']
for (const [k,v] of Object.entries(fs.result.features)) {
  if (want.includes(v.name)) console.log(`amendment ${v.name.padEnd(22)} enabled=${v.enabled} supported=${v.supported}`)
}
console.log('xrpl.js version      :', xrpl.default?.version ?? (await import('xrpl/package.json', {with:{type:'json'}})).default.version)
await c.disconnect()
