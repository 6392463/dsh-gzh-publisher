/* 文案体检：把面板里超过 34 个字的字符串挑出来，按长度排，看看谁又写长了。
   短标签、短横幅是这个插件的界面契约；长说明该进 title 悬浮、右栏「本次渲染」或台账。 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const found = [...source.matchAll(/'([^'\\\n]{10,})'|`([^`\\\n]{10,})`/g)]
  .map(match => match[1] ?? match[2] ?? '')
  .filter(text => /[一-龥]/.test(text) && !text.includes('${'))
const long = [...new Set(found)]
  .filter(text => [...text].length > 34)
  .sort((a, b) => [...b].length - [...a].length)
for (const text of long) console.log(`${String([...text].length).padStart(3)}  ${text}`)
console.log(`共 ${long.length} 条 >34 字（最长 ${long[0] ? [...long[0]].length : 0} 字）`)
