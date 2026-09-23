// 单 bundle 入口（P4，单 bundle 改造收尾）：按旧 index.html script 顺序导入全部剩余模块。
// 各模块顶层挂载与裸全局协议原样保留（compat 白名单 + hub 内部引用在第二步拆文件时再收敛）；
// 已 import 化的模块（usage/variables/regex/worldbook/book/...）经消费方引用被 esbuild 统一去重，
// 不再有跨 bundle 内联副本。
import './storage.entry';
import './compat.entry';
import './preset.entry';
import './bm25.entry';
import './archive.entry';
import './api.entry';
import './editor.entry';
import './ui.entry';
import './mobile.entry';
import './cardwriter.entry';
import './assistant.entry';
import './biqi.entry';
import './modals.entry';
import './feedback.entry';
import './chatmode.entry';
import './community.entry';
import './app.entry';
