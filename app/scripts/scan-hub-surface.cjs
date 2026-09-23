// P2 处置表测量：各模块对 hub 对象（App/UIManager/CommunityChat/PresetManager）的调用面。
const fs = require('fs');

// 文件 → 需要量测的 hub 对象（对向引用：这些模块引用了谁）
const pairs = {
  'api': ['App'], 'discussion': ['App'], 'editor': ['App'], 'mobile': ['App'],
  'modals': ['App'], 'preset': ['App', 'UIManager'], 'summary': ['App'],
  'ui': ['App', 'CommunityChat', 'PresetManager'], 'update': ['App'],
  'worldbook': ['App'], 'community': ['App', 'UIManager'], 'cardwriter': ['App', 'UIManager'],
  'assistant': ['App'], 'book': ['App'], 'archive': ['App'], 'character': ['App'],
  'database': ['App'], 'memory': ['App'], 'settingsync': ['App', 'UIManager'], 'clientlog': ['App'],
};
const STRING_LIKE = /on(?:click|change|input|keydown|keyup|blur|focus|submit|load|error|contextmenu)\s*=\s*['"]/;

for (const [f, objs] of Object.entries(pairs)) {
  const p = 'src/domain/' + f + '.ts';
  if (!fs.existsSync(p)) { console.log('== ' + f + ' (无此文件)'); continue; }
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const members = {};
  let total = 0, inStrLine = 0, realLine = 0;
  const realSamples = [];
  lines.forEach((ln, i) => {
    for (const o of objs) {
      const re = new RegExp('\\b' + o + '\\.([A-Za-z_$][\\w$]*)', 'g');
      let m;
      while ((m = re.exec(ln))) {
        total++;
        members[m[1]] = (members[m[1]] || 0) + 1;
        const inStr = STRING_LIKE.test(ln) || /['"`]/.test(ln.split(o + '.')[0].slice(-30));
        if (inStr) inStrLine++; else { realLine++; if (realSamples.length < 4) realSamples.push((i + 1) + ': ' + ln.trim().slice(0, 90)); }
      }
    }
  });
  const memList = Object.entries(members).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + 'x' + v).join(' ');
  console.log('== ' + f + '.ts  总=' + total + ' 疑似字符串内=' + inStrLine + ' 真实代码=' + realLine);
  console.log('   成员: ' + (memList.slice(0, 260) || '(无)'));
  if (realSamples.length) console.log('   真实代码样例: ' + realSamples.join(' | '));
}
