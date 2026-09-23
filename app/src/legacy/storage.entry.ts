// 遗留全局入口：把 TS 模块编译为「挂全局 + 立即执行副作用」的旧式脚本，
// 经 esbuild --bundle --format=iife 输出到 web/modules/<同名>.js，
// 使 index.html 的 <script src> 顺序加载方式无需改动。
import '../infra/storage';