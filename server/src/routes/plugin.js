// 社区插件路由：列表 / 上传 / 下载 / 删除
// 插件 = 声明式清单（manifest JSON）+ 可选 zip 资源包；服务器只校验结构，不执行任何内容。
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const db = require('../db');
const { requireAuth, isAdminReq } = require('../auth');
const visibility = require('../visibility');
const config = require('../config');
const limits = require('../limits');

const router = express.Router();
const PLUGIN_TYPES_OK = ['database', 'regex', 'preset', 'memory', 'widget'];

function validatePluginManifest(m) {
  if (!m || typeof m !== 'object') return '插件清单无效';
  if (!m.id || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(m.id))) return '插件 ID 需为 1-64 位字母/数字/_-';
  if (!m.name || !String(m.name).trim() || String(m.name).length > 40) return '插件名称需 1-40 字符';
  if (!m.version || String(m.version).length > 20) return '插件版本号缺失或过长';
  if (!m.type || PLUGIN_TYPES_OK.indexOf(String(m.type)) < 0) return '插件类型必须是 ' + PLUGIN_TYPES_OK.join('/');
  if (m.type === 'database') {
    const tables = m.data && m.data.tables;
    if (!Array.isArray(tables) || tables.length === 0) return 'database 插件需要 data.tables';
    for (const t of tables) {
      if (!t.name || !Array.isArray(t.columns) || t.columns.length === 0) return '表格「' + (t.name || '?') + '」缺少列定义';
    }
  }
  return null;
}

// 列表（登录后）
router.get('/list', requireAuth, (req, res) => {
  if (limits.readLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const rows = db.prepare('SELECT id, plugin_id, title, description, plugin_type, plugin_version, author_id, author_name, downloads, created_at FROM plugins WHERE ' + visibility.approvedSql() + ' ORDER BY created_at DESC LIMIT 200').all();
  return res.json({ items: rows });
});

// 上传（登录后）：body { content: manifest JSON 文本 或 data:application/zip;base64,xxx, isZip: true }
router.post('/upload', requireAuth, async (req, res) => {
  if (limits.uploadLimited(req)) return res.status(429).json({ error: '上传过于频繁，请稍后再试' });
  const isZip = !!(req.body && req.body.isZip);
  let manifest = null;
  let zipBase64 = '';
  if (isZip) {
    const raw = String(req.body.content || '');
    const m = raw.match(/^data:application\/zip;base64,(.+)$/s);
    if (!m) return res.status(400).json({ error: 'zip 内容格式不正确' });
    zipBase64 = m[1];
    const buf = Buffer.from(zipBase64, 'base64');
    if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'zip 需小于 10MB' });
    // 从 zip 提取 plugin.json（服务端用 unzip 命令；缺失时提示）
    manifest = await new Promise((resolve) => {
      const pdir = path.join(config.UPLOAD_DIR, 'plugin');
      fs.mkdirSync(pdir, { recursive: true });
      const tmp = path.join(pdir, '_tmp_' + Date.now() + '.zip');
      fs.writeFileSync(tmp, buf);
      exec('unzip -p ' + JSON.stringify(tmp) + ' plugin.json', { timeout: 10000 }, (err, stdout) => {
        try { fs.unlinkSync(tmp); } catch (e) {}
        if (err || !stdout) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch (e) { resolve(null); }
      });
    });
    if (!manifest) return res.status(400).json({ error: 'zip 内缺少 plugin.json（或服务器缺少 unzip）' });
  } else {
    try { manifest = JSON.parse(String(req.body.content || '')); } catch { return res.status(400).json({ error: '文件内容不是有效的 JSON' }); }
  }
  const verr = validatePluginManifest(manifest);
  if (verr) return res.status(400).json({ error: verr });
  const pluginId = String(manifest.id);
  const dup = db.prepare('SELECT id FROM plugins WHERE plugin_id = ?').get(pluginId);
  if (dup) return res.status(400).json({ error: '插件 id=' + pluginId + ' 已存在，请修改 manifest 的 id 或联系作者更新' });
  const now = Date.now();
  const pdir = path.join(config.UPLOAD_DIR, 'plugin');
  fs.mkdirSync(pdir, { recursive: true });
  const me = req.user;
  const size = isZip ? Buffer.from(zipBase64, 'base64').length : Buffer.byteLength(String(req.body.content || ''));
  const status = isAdminReq(req) ? 'approved' : 'pending'; // 审核门：管理员自己上传直接公开，其余人待审
  const info = db.prepare('INSERT INTO plugins (plugin_id, title, description, plugin_type, plugin_version, author_id, author_name, filename, is_zip, size, downloads, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(pluginId, String(manifest.name), String(manifest.description || '').slice(0, 500), String(manifest.type), String(manifest.version), me.id, me.username, '', isZip ? 1 : 0, size, now, status);
  const mfile = pluginId + '.json';
  fs.writeFileSync(path.join(pdir, mfile), JSON.stringify(manifest, null, 2), 'utf8');
  if (isZip) {
    const zdir = path.join(pdir, 'files');
    fs.mkdirSync(zdir, { recursive: true });
    fs.writeFileSync(path.join(zdir, pluginId + '.zip'), Buffer.from(zipBase64, 'base64'));
  }
  db.prepare('UPDATE plugins SET filename = ? WHERE id = ?').run(mfile, Number(info.lastInsertRowid));
  return res.json({ ok: true, id: Number(info.lastInsertRowid), plugin_id: pluginId, status });
});

// 下载（登录后，返回 manifest；客户端直接安装）
router.get('/download/:pluginId', requireAuth, (req, res) => {
  if (limits.readLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const pluginId = String(req.params.pluginId || '');
  const row = db.prepare('SELECT id, plugin_id, filename, author_id, status FROM plugins WHERE plugin_id = ?').get(pluginId);
  if (!row || !row.filename) return res.status(404).json({ error: '未找到该插件' });
  if (!visibility.canSee(req, row)) return res.status(404).json({ error: '未找到该插件' }); // 未过审：仅作者与管理员可见
  const abs = path.normalize(path.join(config.UPLOAD_DIR, 'plugin', row.filename));
  if (!abs.startsWith(path.normalize(path.join(config.UPLOAD_DIR, 'plugin')))) return res.status(400).json({ error: '非法路径' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件已丢失' });
  db.prepare('UPDATE plugins SET downloads = downloads + 1 WHERE id = ?').run(row.id);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return res.status(500).json({ error: '清单损坏' }); }
  return res.json({ manifest });
});

// 删除（登录后，仅作者本人）
router.delete('/delete', requireAuth, (req, res) => {
  const pluginId = String(req.query.id || '');
  const row = db.prepare('SELECT id, author_id, filename FROM plugins WHERE plugin_id = ?').get(pluginId);
  if (!row) return res.status(404).json({ error: '未找到该插件' });
  if (row.author_id !== req.user.id) return res.status(403).json({ error: '只能删除自己上传的插件' });
  db.prepare('DELETE FROM plugins WHERE plugin_id = ?').run(pluginId);
  const pdir = path.normalize(path.join(config.UPLOAD_DIR, 'plugin'));
  const targets = [row.filename ? path.join(pdir, row.filename) : '', path.join(pdir, 'files', pluginId + '.zip')];
  for (const t of targets) {
    if (!t) continue;
    const abs = path.normalize(t);
    if (abs.startsWith(pdir)) { try { fs.unlinkSync(abs); } catch (e) {} }
  }
  return res.json({ ok: true });
});

module.exports = router;