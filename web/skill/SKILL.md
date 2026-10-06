---
name: bqb-image-host-setup
description: 在用户的 Windows 电脑上配好 BQB Hub 的「画图主机」（本机 ComfyUI 出图）——装 ComfyUI、放置模型、导入工作流、启动画图主机，最后拿到手机要填的地址与配对 token。当用户说「帮我配 BQB Hub 的画图主机 / 让手机能出图 / 配置本机生图」时使用。
---

# BQB Hub「画图主机」AI 配置技能（Windows）

> **这份文件是给电脑上的 AI 编程助手看的执行说明书**（Claude Code / WorkBuddy / Cursor / Codex 等）。
> 你负责在这台 Windows 电脑上一步步配好；**只有第 2 步（下载模型）必须由用户手动做**——
> 模型站点要求登录（未登录接口直接返回 `401 {"message":"The creator of this asset requires you to be logged in to download it"}`），
> 你没有账号，也**不要**尝试绕过登录、爬站或改用第三方镜像。

## 完成标准（做完要达到的状态）

1. 这台电脑的 ComfyUI 能出图（自己能用 API 跑通一张）；
2. 「画图主机」在 **8123** 端口跑着，能连到 ComfyUI；
3. 你打印给用户两样东西：`http://<本机局域网IP>:8123` 和「配对 token」；
4. 用户把这两样填进手机 App（设置 → AI 与生成 → 画图主机）后，点「测试连接」显示「在线 · 模型名」。

## 铁律（务必遵守）

1. **模型文件只能用户自己下载**（第 2 步）。不要把模型文件写进任何安装包、不要转发、不要上传到任何地方。
2. **模型许可必须原样转达用户**（见文末「许可与署名」）：必须署名、**仅个人非商用**、不可再分发模型文件。
3. **每一步验证通过再往下**（每步都写了「验证」）；失败就照第 9 节排错，不要跳步硬试。
4. 写盘的文件必须与**附录 A/B/C 里的内容逐字一致**（用户要换别的模型时，只改 `comfy/workflow.json`，别动主机程序）（尤其 `serve.mjs`、`comfy-workflow.mjs`、工作流 JSON）。
5. 安装/下载类操作**先告诉用户**你要做什么（下载多少 MB、装到哪个目录、是否会开机自启），得到同意再执行。
6. 不要动用户电脑上无关的东西；所有新增文件集中在**一个目录**里（下面统一用 `C:\bqb-host`，用户可以指定别的路径，路径里**不要有中文和空格**）。

## 0. 环境自检（先做，缺一不可）

```powershell
nvidia-smi                      # 要有 NVIDIA 显卡；看显存：≥8GB 舒服，6GB 只能跑小图，<6GB 或没有独显就如实告诉用户「这台机器不适合」并停下
node -v                         # 没有输出 → 第 5 步装 Node.js
Get-PSDrive C | Select-Object Used,Free   # 至少空 30GB
Test-Path "$env:USERPROFILE\Documents\ComfyUI"   # True = 已经装过 ComfyUI，可跳过第 1 步
```

## 1. 装 ComfyUI（出图引擎）

- 打开 <https://www.comfy.org/download> 下载 **Windows 桌面版**安装包，装好（一路下一步即可）。
- 装完启动一次，看到画布界面即可关掉（第 3 步会用它的 API）。
- **验证**：`curl http://127.0.0.1:8188/system_stats` 返回一段 JSON（含显卡信息）就算通。
  - 没通就先启动 ComfyUI（开始菜单里找 `ComfyUI`），等 1~2 分钟再试。
- 记住 ComfyUI 的 **models 目录**（默认 `C:\Users\<用户名>\Documents\ComfyUI\models`；用户装的时候改过位置的话，以 `curl http://127.0.0.1:8188/object_info/UNETLoader` 里返回的路径为准）。

## 2. 模型：**请用户自己下载**（唯一的手动步骤）

**默认方案**（不想挑模型就照这套做——它实测跑通过，最省事；也可以让用户自己找别的模型，见本节末尾「换成别的模型」）。
**不管最后用哪套模型，App 侧都不用改**：档位尺寸、步数、seed、以图改图都由「画图主机」按你配好的工作流自动映射。

对用户说清三件事：① 需要**注册并登录 Civitai**（免费）；② 一共要下 **4 个文件、约 4.5GB**；③ 下完告诉你，你继续。

把下面这张表**原样发给用户**（链接、要下哪个版本、放哪个目录）：

**主模型页**：<https://civitai.com/models/2026594/miaomiao-realskin> → 选版本 **Anima1.3** → 页面上能逐个下载下面 3 个文件：

| 页面上的文件名 | 精确字节数（下完可核对） | 放到 ComfyUI 的 | 备注 |
|---|---|---|---|
| `miaomiaoRealskin_anima13.safetensors` | 4182218328 | `models\diffusion_models\` | 主模型（约 3.9GB） |
| `miaomiaoRealskin_anima13_txt.safetensors` | 1192135096 | `models\text_encoders\` | 文本编码器；**建议改名成 `qwen_3_06b_base.safetensors`**（工作流按这个名字找） |
| `qwen_image_vae.safetensors` | 253806246 | `models\vae\` | VAE（约 242MB） |

**加速 LoRA 页**：<https://civitai.com/models/2619830/turbo-for-anima-less-steps> → 随便挑一个版本下载（**推荐 v1.5 或 V2**，都是 150359362 字节；V4 是 280194468 字节）→ 放进 `models\loras\`

- 这个 LoRA 让 8 步就能出干净图（不加它要 28 步，慢 3 倍）。
- **文件名要和工作流对得上**：工作流里写的是 `anima-turbo-lora-v0.2.safetensors`——
  要么让用户把下载的文件改名成这个，要么**改工作流**（推荐后者，改成用户实际下载的文件名）：
  `comfy\workflow.json` 里 `"105"` 节点的 `inputs.lora_name` 改成实际文件名。
- 同理，若文本编码器没改名，就把工作流里 `"2"` 节点的 `inputs.clip_name` 改成 `miaomiaoRealskin_anima13_txt.safetensors`。
- 若是别的版本导致画面偏糊/偏死，把工作流 `_tiers` 里的步数从 8 调到 12 再试（主机每次出图都读这个文件，改完立即生效，不用重启任何东西）。

**等用户说「下好了」再继续。**

**验证**（PowerShell，贴给用户或自己跑）：

```powershell
$m="$env:USERPROFILE\Documents\ComfyUI\models"
Get-Item "$m\diffusion_models\miaomiaoRealskin_anima13.safetensors" | Select Length   # 期望 4182218328
Get-Item "$m\vae\qwen_image_vae.safetensors" | Select Length                          # 期望 253806246
Get-Item "$m\text_encoders\*.safetensors" | Select Name,Length                        # 期望 1192135096
Get-Item "$m\loras\*.safetensors" | Select Name,Length                                # 期望 150359362（或你选的版本）
```

数量对不上 = 没下完（Civitai 大文件会断，重下那个文件即可）。

### 换成别的模型（可选：用户自带模型时看这里）

主机**不挑模型**——SD1.5 / SDXL / Illustrious / Pony / NoobAI / Flux / SD3 / Qwen-Image / Z-Image …都行，
只要工作流是一份正常的「文生图」API 格式图。换模型时你要做四件事：

1. **让工作流配得上这个模型**（最容易踩的一步）：在 ComfyUI 里用新模型跑通一张 → 菜单 **Workflow → Export (API)** 导出 → 覆盖 `C:\bqb-host\comfy\workflow.json`。
   主机的自动识别条件（不满足就套不上参数，出了图也可能尺寸不对）：
   - 必须有 **`KSampler` 或 `KSamplerAdvanced`**（steps / seed / cfg 从这里套）；
   - 正向/负向要能顺着连线找到**带 `text` 的提示词节点**（中间夹 `ConditioningCombine` 之类的也能穿透）；
   - **尺寸要落在「空 Latent」节点的数值型 `width`/`height` 上**（这是 App 档位尺寸唯一生效的地方）；
   - 「以图改图」还需要能找到 **VAE**（`VAEDecode` 用的那个来源，或任意 `VAELoader`）——单文件 checkpoint 的 VAE 输出也行。
2. **改 `_hint`**（工作流 JSON 里的 `_` 开头的字段，ComfyUI 不认、只给主机和 App 看）：写明这套模型的提示词风格——tag 系写「danbooru 风格 tag，用英文标签、逗号分隔」，自然语言系写「用英文短句描述画面」。App 会把它交给写卡的模型去组织提示词，写错了画面会明显跑偏。
3. **改 `_tiers`（档位尺寸/步数）并按模型调采样参数**：形如
   `"_tiers": {"fast":{"size":512,"steps":8},"draft":{"size":512,"steps":10},"normal":{"size":768,"steps":8},"high":{"size":1024,"steps":10}}`
   （`steps:null` = 用工作流自己的步数；改完立即生效，主机每次出图都读这个文件）。参考值：
   - **SDXL / Illustrious / Pony / NoobAI 系**：25~30 步、cfg 5~7、768~1024；**negative 节点要写正经的负面词**（cfg>1 才生效；默认那套是 cfg 1.0，负面词是摆设）。
   - **SD1.5 系**：**512 原生**——把「标准」档也声明成 512，给它 768 会画崩。
   - **Lightning / Hyper / Turbo / LCM 等加速版**：4~8 步、cfg 1~2（步数按它的模型页说明写）。
   - **分体式（Flux / Qwen-Image / Z-Image 等）**：CLIP、VAE 要配该模型对应的那一套（导出的工作流里已经连着，别手工改错）；`config.json` 的 `weight_dtype` 只对带这个输入的加载节点生效（≥12GB 显存可以删掉那行换精度）。
4. **验证**：先在 ComfyUI 里出一张确认能画，再让用户在 App 里试一次；**App 实际会用的档位参数**看 `curl http://127.0.0.1:8123/api/comfy/status` 里返回的 `tiers`，与你在工作流里声明的一致才算配好。

> ⚠️ 换成别人分享的模型时，**许可要用户自己确认**（站内默认那两个的许可说明只对它们有效）：能否商用、要不要署名、能不能再分发/做衍生。

## 3. 落地工作流，并用 API 真的出一张图

1. 建目录 `C:\bqb-host\comfy`，把**附录 A** 的工作流 JSON 原样写进 `C:\bqb-host\comfy\workflow.json`。
2. 按第 2 步的实际文件名，改好 `"1".inputs.unet_name` / `"2".inputs.clip_name` / `"3".inputs.vae_name` / `"105".inputs.lora_name`。
3. 用 ComfyUI 的 HTTP API 提交一次（**这一步同时验证：模型齐、节点齐、显存够**）：

```powershell
$wf = Get-Content C:\bqb-host\comfy\workflow.json -Raw | ConvertFrom-Json
# 把 prompts 换成一句英文 tag 提示词（这套模型吃 danbooru 风格 tag）
$body = @{ prompt = $wf } | ConvertTo-Json -Depth 40 -Compress
$r = Invoke-RestMethod -Uri http://127.0.0.1:8188/prompt -Method Post -ContentType application/json -Body $body
$r    # 得到 prompt_id，然后用 /history/<id> 查结果；出图存到 ComfyUI 的 output 目录
```

（如果这条 PowerShell 不好用，也可以用 ComfyUI 界面：把 `workflow.json` 拖进窗口 → 点 Run。
两种方式任选，**但必须真的看到一张图**才算过。）

**失败照它报的原文处理**：`找不到 xxx.safetensors` → 文件名/目录不对（回第 2 步）；`Cannot import ... nodes` / `missing node` → 这份工作流只用 ComfyUI 自带节点，说明 ComfyUI 版本太老，让用户更新。

## 4. 装 Node.js（`node -v` 有输出就跳过）

- 到 <https://nodejs.org> 下载 **LTS 版** Windows 安装包（.msi），一路下一步装完。
- **验证**：新开一个 PowerShell 窗口跑 `node -v`，能看到版本号。

## 5. 落地「画图主机」

在 `C:\bqb-host` 下原样写出这些文件（内容见附录）：

| 文件 | 来源 |
|---|---|
| `serve.mjs` | 附录 B-1 |
| `comfy-workflow.mjs` | 附录 B-2 |
| `config.json` | 附录 C-1（**模板，按需改**） |
| `comfy\workflow.json` | 第 3 步已经写好 |
| `启动.cmd` | 附录 C-2 |
| `web\index.html`（可选） | 附录 C-3（只是让浏览器打开 8123 时有个说明页） |

`config.json` 三个要点：`port` 保持 8123；`comfy.base` 保持 `http://127.0.0.1:8188`；`comfy.weight_dtype` 是 `fp8_e4m3fn`（**8GB 显存必须留着**；≥12GB 可以删掉这一行换取更高精度）。`llm` 那段是主机自带测试页用的，留空即可，App 出图用不到。

## 6. 启动，拿到地址与配对 token

```powershell
cd C:\bqb-host
node serve.mjs --lan
```

- 第一次运行 Windows 会弹**防火墙提示** → 必须勾「专用网络」并允许（不让的话手机连不上）。
- 窗口里会打印：`http://192.168.x.x:8123`（**WLAN/以太网那一行**，不是 VMware/VPN/vEthernet 那些）和一行「**配对 token**」。
- 这个 token 会自动存进 `C:\bqb-host\host.json`，以后不变。
- **验证**：另开一个窗口 `curl http://127.0.0.1:8123/api/comfy/status` → 应返回 `{"ok":true,...}`（含模型名与档位声明）。

**把两样东西写给用户**（让他抄进手机）：

```
地址：http://192.168.x.x:8123    ← 换成窗口里 WLAN/以太网那一行
token：<窗口里那串>

手机：设置 → AI 与生成 → 画图主机 → 填地址（不用写 http://）和 token → 打开开关 → 点「测试连接」
```

## 7. 收尾：给用户说清三件事

1. **平时顺序**：先开 ComfyUI（慢）→ 再双击 `C:\bqb-host\启动.cmd`；两个窗口都别关（关了手机就连不上 / 出不了图）。
2. **电脑不能睡眠**：Windows「电源和睡眠」设成"从不"，或出图时别合盖。
3. 想开机自启：把 `启动.cmd` 的快捷方式放进 `shell:startup`（`Win+R` 输入 `shell:startup`）。ComfyUI 桌面版自带开机启动选项。
4. 换 Wi-Fi / 路由器重启后 IP 会变 → 重新看窗口里那行地址，在手机 App 里改一下；想固定就把路由器里这台电脑设成「地址保留」。

## 8. 换模型 / 加 LoRA（用户以后自己折腾时看）

- 换主模型：把新的 `.safetensors` 放进 `models\diffusion_models\`，改 `comfy\workflow.json` 的 `"1".inputs.unet_name`；**不要**改工作流结构（映射靠节点类型自动识别，动结构可能失效）。
- 加 LoRA：在工作流里再插一个 `LoraLoader`（`class_type` 必须是 `LoraLoader`），接在 `UNETLoader`/`CLIPLoader` 与 `KSampler`/两个文本编码之间；注意 `LoraLoader` 的输出 0 = MODEL、1 = CLIP（接反会报 `received_type(MODEL) mismatch`）。
- 每档的**尺寸与步数**写在工作流 JSON 里那一堆 `_tiers` 里（`_` 开头的字段是给 App/主机看的元数据，不影响 ComfyUI 执行）：`{"fast":{"size":512,"steps":8},...}`；改它就能改手机上说"快一点/更精细"时用的参数。`steps: null` = 用工作流自己的步数。

## 9. 排错（照报错对号入座）

| 现象 | 原因 / 处理 |
|---|---|
| 手机「连不上画图主机 / 超时」 | ① 电脑浏览器开 `http://127.0.0.1:8123/` 没反应 → 主机没开（双击 `启动.cmd`）② 手机和电脑不在同一 Wi-Fi/路由器（不该用流量、访客网络）③ 手机开着 VPN → 关掉 ④ 防火墙没放行 → 「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」把 Node.js 在**专用网络**勾上 |
| 手机「连不上 ComfyUI（127.0.0.1:8188）」 | 手机已连上主机，是**电脑上 ComfyUI 没开**（或还在启动）→ 打开它、等界面出来再试 |
| 手机「配对 token 不对 / 401」 | token 抄错 → 重抄；或删掉 `host.json` 重启主机换一串新 token 再填 |
| `/api/comfy/status` 报连不上 ComfyUI | `curl http://127.0.0.1:8188/system_stats` 自查；没通就是 ComfyUI 没起来 |
| 出图报 `找不到 xxx.safetensors` | 文件名/目录与工作流不一致（第 2 步的改名表） |
| 出图报显存不足 / 卡死 | 换小档位（512）、关掉占显存的程序；`config.json` 里 `weight_dtype` 必须是 `fp8_e4m3fn` |
| 出图很慢（>1 分钟） | 8GB 笔记本显卡正常范围：512 约 2 秒、768 约 6~15 秒、1024 约 30 秒；没装加速 LoRA 会慢 3 倍 |
| 主机窗口报 `Cannot find module` | 没装 Node.js，或 `serve.mjs` 与 `comfy-workflow.mjs` 不在同一个目录 |
| 昨天能用今天连不上 | IP 变了（第 7 节） |

## 许可与署名（**必须原样转达给用户**）

- **MiaoMiao RealSkin**（主模型，<https://civitai.com/models/2026594>）：作者要求**署名**；**仅限个人非商用**（商用只允许在 Civitai 自家的付费生成服务里）；**不允许再分发模型文件**、不允许拿它做衍生模型。
- **TURBO for ANIMA**（加速 LoRA，<https://civitai.com/models/2619830>）：同上（署名 + 仅个人非商用 + 不可再分发）。
- 基座模型 **Anima**（作者 circlestone_labs）：CircleStone Labs Non-Commercial License。
- 一句话给用户：**自己写小说配图没问题；不要拿这些图去卖、也不要把模型文件转发给别人。**

---

# 附录 A：工作流 JSON（原样写进 `C:\bqb-host\comfy\workflow.json`）

```json
{{WORKFLOW_JSON}}
```

# 附录 B-1：`serve.mjs`（原样写进 `C:\bqb-host\serve.mjs`）

```js
{{SERVE_MJS}}
```

# 附录 B-2：`comfy-workflow.mjs`（原样写进 `C:\bqb-host\comfy-workflow.mjs`）

```js
{{COMFY_WORKFLOW_MJS}}
```

# 附录 C-1：`config.json`（原样写进 `C:\bqb-host\config.json`）

```json
{{CONFIG_JSON}}
```

# 附录 C-2：`启动.cmd`（原样写进 `C:\bqb-host\启动.cmd`，编码用 ANSI 或 UTF-8，文件名就是中文的「启动.cmd」）

```bat
{{LAUNCH_CMD}}
```

# 附录 C-3：`web\index.html`（可选；只是让浏览器直接打开 8123 时有个说明页）

```html
{{WEB_INDEX}}
```
