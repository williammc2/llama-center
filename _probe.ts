
import { parseAssets, resolve } from './src/lib/assetResolver'
const B = parseAssets([
  { name: 'llama-b10814-bin-ubuntu-sycl-fp16-x64.tar.gz', sizeMB: 51 },
  { name: 'llama-b10814-bin-ubuntu-sycl-fp32-x64.tar.gz', sizeMB: 51 },
  { name: 'llama-b10814-bin-win-sycl-x64.zip', sizeMB: 114 },
  { name: 'llama-b10814-bin-win-cuda-13.3-x64.zip', sizeMB: 142 },
  { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', sizeMB: 373 },
])
// 1) sycl on ubuntu: user just asks 'sycl' — which precision wins?
const s = resolve(B, { os:'linux', arch:'x64', backend:'sycl' })
console.log('ubuntu sycl ->', s.status==='ok'? s.asset.name : s)
// 2) win x64 cuda-12 cudart exact
const c1 = resolve(B, { os:'win', arch:'x64', backend:'cuda', cudaMajor:12, family:'cudart' })
console.log('win x64 cuda12 cudart ->', c1.status==='ok'? c1.asset.name : c1)
// 3) win x64 cuda-13 plain: only 13.3 plain exists -> should pick 13.3 (not cudart)
const c2 = resolve(B, { os:'win', arch:'x64', backend:'cuda', cudaMajor:13, family:'plain' })
console.log('win x64 cuda13 plain ->', c2.status==='ok'? c2.asset.name : c2)
// 4) win x64 cuda-12 plain: no plain 12, only plain 13.3 -> falls back major within plain
const c3 = resolve(B, { os:'win', arch:'x64', backend:'cuda', cudaMajor:12, family:'plain' })
console.log('win x64 cuda12 plain ->', c3.status==='ok'? c3.asset.name+' fellBack='+c3.fellBack : c3)
