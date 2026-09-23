# 第三方声明（Third-Party Notices）

本项目（BQB Hub）自身代码以 MIT 许可发布，见 [LICENSE](LICENSE)。随项目分发的第三方字体与运行依赖如下。

## 1. 随 App 分发的字体

`web/assets/fonts/` 下的字体文件随 APK 一并分发，均为 **SIL Open Font License 1.1**：

| 文件 | 字体 | 上游 |
|---|---|---|
| `NotoSerifSC.woff2` | Noto Serif SC（思源宋体 / Source Han Serif 同源） | https://github.com/notofonts/noto-cjk |
| `lxgw/files/lxgwwenkai-regular-subset-*.woff2`、`lxgw/lxgwwenkai-regular.css` | LXGW WenKai（霞鹜文楷，衍生自 Fontworks 的 Klee One） | https://github.com/lxgw/LxgwWenKai |

两份字体的版权归其各自作者所有，按 OFL 1.1 授权使用（允许商用与再分发；不得单独出售字体本身；修改后的版本不得使用保留字体名，若上游声明了保留名）。协议全文见下；App 内置副本在 `web/assets/fonts/LICENSES.txt`。

### SIL Open Font License 1.1（全文）

```
Copyright (c) 2007, SIL International (https://scripts.sil.org/OFL)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply to any
document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may include
source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical writer or
other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a
copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or in
the appropriate machine-readable metadata fields within text or binary
files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright
Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be
distributed entirely under this license, and must not be distributed under
any other license. The requirement for fonts to remain under this license
does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not
met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER
DEALINGS IN THE FONT SOFTWARE.
```

## 2. 构建期与运行期依赖（npm）

以下依赖通过 `npm install` 安装，**不以源码形式存在于本仓库**，随各自包分发：

- 根工程：`@capacitor/cli`（MIT，构建期）、`@capacitor/android` / `@capacitor/core`（MIT，打包进 APK 的 Java 侧依赖）
- `app/`：Vite、Vitest、esbuild、ESLint、fast-check、typescript-eslint（MIT）、TypeScript（Apache-2.0）、lightningcss（MPL-2.0，仅构建期使用）
- `server/`：Express（MIT）、Nodemailer（MIT-0）、geoip-lite（Apache-2.0，其内置的 GeoLite2 数据版权归 MaxMind，按其许可使用）

经清点，全部依赖为宽松许可，无 GPL/AGPL/SSPL 类传染性许可。完整依赖树以其各自的 `package-lock.json` 为准。

## 3. 未包含的第三方内容

本仓库**不包含**任何第三方创作的世界书/预设内容。社区服务（用户上传的世界书与预设）由各上传者自行负责，与代码仓库无关。
