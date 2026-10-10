#!/usr/bin/env node
// scrypt 跨语言对拍 · Node 侧：生成夹具 + 反向校验 Java 生成的结果。
//
// 两条口令路径的哈希规格（都来自现有实现，改动它们会让老用户/线上配置失配）：
//
//  A. 登录口令（server/src/auth.js）
//       hash = scrypt(pw_utf8, salt_ascii_bytes, 64, { N:16384, r:8, p:1 })，hex 存储
//       盐是「16 随机字节的 hex 字符串」（32 个 ASCII 字符）——**拿这个字符串的 UTF-8 字节当盐**，
//       不是把它 hex 解码成 16 字节。库里 users.pass_salt / users.pass_hash 就是这么存的。
//
//  B. 管理员口令（server/src/adminpass.js；也是线上 config.json 里 adminPasswordHash 的格式）
//       stored = "scrypt$16384$8$1$<saltB64>$<hashB64>"
//       hash = scrypt(pw_utf8, salt_bytes, 32, { N:16384, r:8, p:1 })，盐是真字节（base64 存）
//
// 输出： fixtures.tsv / admin-fixtures.tsv（TSV，'#' 开头是注释；口令一律 hex 编码，避免转义歧义）
// 用法： node gen-fixtures.mjs                       生成夹具并自检
//        node gen-fixtures.mjs --verify-java <file>   校验 Java 侧生成的 java-generated.tsv
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const N = 16384, R = 8, P = 1;
const LOGIN_KEYLEN = 64;   // auth.js: scryptSync(pw, salt, 64)
const ADMIN_KEYLEN = 32;   // adminpass.js: KEYLEN = 32

// ---- 向量表（盐固定，保证可复现；口令里含中文/emoji/首尾空格等边界）----
const LOGIN_VECTORS = [
  { note: '英文+数字口令', pw: 'pass1234', salt: '00112233445566778899aabbccddeeff' },
  { note: '中文口令（UTF-8 多字节）', pw: '一起看星星吧123', salt: 'ffeeddccbbaa99887766554433221100' },
  { note: 'emoji（4 字节 UTF-8）', pw: '🌙🦊', salt: '0123456789abcdef0123456789abcdef' },
  { note: '最长 64 个 ASCII', pw: 'a'.repeat(64), salt: 'deadbeefdeadbeefdeadbeefdeadbeef' },
  { note: '首尾空格不做 trim', pw: '  spaced  ', salt: 'cafebabecafebabecafebabecafebabe' },
  // 下面这条是「把盐当 hex 解码」的探针：盐不是合法 hex，Java 侧若解码会直接抛错而不是悄悄算错
  { note: '非 hex 盐（盐当字节串的探针）', pw: 'pass1234', salt: 'NaCl-盐-001-不是hex' },
  { note: '空口令', pw: '', salt: '00000000000000000000000000000000' },
];

const ADMIN_VECTORS = [
  { note: '管理员口令（ASCII）', pw: 'test-admin-pw', saltHex: '00112233445566778899aabbccddeeff' },
  { note: '管理员口令（中文）', pw: '管理员口令中文', saltHex: 'deadbeefdeadbeefdeadbeefdeadbeef' },
];

// ---- 计算 ----
const b64 = (buf) => Buffer.from(buf).toString('base64');

/** A. 登录路径：盐 = saltString 的 UTF-8 字节 */
function loginHash(pw, saltString, keylen = LOGIN_KEYLEN) {
  return crypto.scryptSync(Buffer.from(pw, 'utf8'), Buffer.from(saltString, 'utf8'), keylen, { N, r: R, p: P });
}
/** B. 管理员路径 */
function adminStored(pw, saltBytes) {
  const h = crypto.scryptSync(Buffer.from(pw, 'utf8'), saltBytes, ADMIN_KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, b64(saltBytes), b64(h)].join('$');
}
const hex = (b) => Buffer.from(b).toString('hex');

// ---- 自检：文档声称的默认参数是否真的等于显式参数 ----
function checkDefaults() {
  const pw = Buffer.from('pass1234', 'utf8');
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'utf8');
  const withDefaults = crypto.scryptSync(pw, salt, LOGIN_KEYLEN);
  const withExplicit = crypto.scryptSync(pw, salt, LOGIN_KEYLEN, { N, r: R, p: P });
  return withDefaults.equals(withExplicit);
}

// ---- 反向校验：Java 生成的 java-generated.tsv ----
function verifyJava(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  let bad = 0, n = 0;
  for (const line of lines) {
    const [kind, note, pwHex, salt, result] = line.split('\t');
    const pw = Buffer.from(pwHex, 'hex').toString('utf8');
    n++;
    let ok, want;
    if (kind === 'login') {
      ok = hex(loginHash(pw, salt)) === result.toLowerCase();
      want = result;
    } else if (kind === 'admin') {
      // Java 生成的是 scrypt$N$r$p$saltB64$hashB64：解出盐与 hash，用 Node 重算比对
      const parts = String(result).split('$');
      const saltBytes = Buffer.from(parts[4], 'base64');
      const javaHash = parts[5];
      ok = b64(crypto.scryptSync(Buffer.from(pw, 'utf8'), saltBytes, ADMIN_KEYLEN, { N, r: R, p: P })) === javaHash
        && b64(saltBytes) === salt;
      want = result;
    } else {
      console.log('跳过未知类型：' + kind);
      continue;
    }
    console.log((ok ? 'PASS  ' : 'FAIL  ') + '[反向 ' + kind + '] ' + note);
    if (!ok) { bad++; console.log('      Java 给出：' + want); }
  }
  console.log('');
  console.log(bad === 0
    ? '反向校验通过：Java 现场生成的 ' + n + ' 条，Node 全部能认（迁移期两边可互相认口令）'
    : '反向校验失败：' + bad + '/' + n + ' 条不一致');
  return bad === 0;
}

// ---- 主流程 ----
function generate() {
  const t = [];
  t.push('# scrypt 登录口令夹具（Node crypto.scryptSync 生成）');
  t.push('# 列：note <TAB> passwordHex <TAB> saltRaw <TAB> expectHashHex');
  t.push('# 规格：scrypt(pw_utf8, salt_ascii_bytes, 64, N=16384,r=8,p=1)，盐是该字符串的 UTF-8 字节，不是 hex 解码');
  for (const v of LOGIN_VECTORS) {
    t.push([v.note, hex(Buffer.from(v.pw, 'utf8')), v.salt, hex(loginHash(v.pw, v.salt))].join('\t'));
  }
  fs.writeFileSync(path.join(HERE, 'fixtures.tsv'), t.join('\n') + '\n', 'utf8');

  const a = [];
  a.push('# 管理员口令夹具（server/src/adminpass.js 格式，也是线上 config.json 的 adminPasswordHash 格式）');
  a.push('# 列：note <TAB> passwordHex <TAB> saltB64 <TAB> expectStored(scrypt$N$r$p$saltB64$hashB64)');
  for (const v of ADMIN_VECTORS) {
    const saltBytes = Buffer.from(v.saltHex, 'hex');
    a.push([v.note, hex(Buffer.from(v.pw, 'utf8')), b64(saltBytes), adminStored(v.pw, saltBytes)].join('\t'));
  }
  fs.writeFileSync(path.join(HERE, 'admin-fixtures.tsv'), a.join('\n') + '\n', 'utf8');

  console.log('== scrypt 对拍夹具（Node 侧）==');
  console.log('Node 版本：' + process.version);
  console.log('默认参数自检：scryptSync(pw,salt,64) 与显式 {N:16384,r:8,p:1} ' + (checkDefaults() ? '一致 ✔' : '不一致 ✘（文档要改！）'));
  console.log('生成 fixtures.tsv（' + LOGIN_VECTORS.length + ' 条登录向量）、admin-fixtures.tsv（' + ADMIN_VECTORS.length + ' 条管理员向量）');
  return checkDefaults();
}

const args = process.argv.slice(2);
if (args[0] === '--verify-java') {
  if (!args[1]) { console.error('用法：node gen-fixtures.mjs --verify-java <java-generated.tsv>'); process.exit(2); }
  process.exit(verifyJava(args[1]) ? 0 : 1);
}
process.exit(generate() ? 0 : 1);
