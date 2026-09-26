// Modals：全部弹窗模板（从 www/modules/modals.js 深度类型化）。
// 模板集合为静态 HTML 字符串；init 时挂载到 body 的 #modalContainer。
export type ModalName =
  | 'modalPreset' | 'modalPresetEdit' | 'modalSysPrompt' | 'modalModuleEdit' | 'modalRegex'
  | 'modalConfirm' | 'modalProtagonist' | 'modalWBEntry' | 'modalWBBook'
  | 'modalCommunityLogin' | 'modalCommunityRegister' | 'modalCommunityForgot' | 'modalCommunityProfile'
  | 'modalCommunityWbUpload' | 'modalCommunityPresetUpload' | 'modalCommunityPresetDetail'
  | 'modalCommunityWbCrop' | 'modalCommunityWbDetail' | 'modalCommunityRename' | 'modalCharCardImport'
  | 'modalDBRecord' | 'modalAppUpdate' | 'modalWbAddSheet' | 'modalWbBookSheet' | 'modalAdminAuth' | 'modalWBEntryView';

export const Modals: {
  _modals: Record<string, string>;
  init(): void;
} = {
  _modals: {
    modalPreset: `<div class="modal-overlay" id="modalPreset">
  <div class="modal"><div class="modal-header"><h3 id="modalPresetTitle">保存预设</h3><button class="icon-btn" onclick="UIManager.closeModal('modalPreset')">✕</button></div>
  <div class="modal-body"><div class="form-group"><label>预设名称</label><input type="text" id="presetName"></div></div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalPreset')">取消</button><button class="primary" onclick="UIManager.savePreset()">保存</button></div></div>
</div>`,

    modalPresetEdit: `<div class="modal-overlay" id="modalPresetEdit">
  <div class="modal"><div class="modal-header"><h3 id="modalPresetEditTitle">编辑预设</h3><button class="icon-btn" onclick="UIManager.closeModal('modalPresetEdit')">✕</button></div>
  <div class="modal-body">
    <input type="hidden" id="editPresetId">
    <div class="form-group"><label>预设名称</label><input type="text" id="editPresetName"></div>
  </div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalPresetEdit')">取消</button><button class="primary" onclick="UIManager.savePresetEdit()">保存修改</button></div></div>
</div>`,

    modalSysPrompt: `<div class="modal-overlay" id="modalSysPrompt">
  <div class="modal"><div class="modal-header"><h3>系统提示词</h3><button class="icon-btn" onclick="UIManager.closeModal('modalSysPrompt')">✕</button></div>
  <div class="modal-body"><input type="hidden" id="spId"><div class="form-group"><label>名称</label><input type="text" id="spName"></div><div class="form-group"><label>提示词内容</label><textarea id="spContent" rows="8"></textarea></div></div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalSysPrompt')">取消</button><button class="primary" onclick="UIManager.saveSysPrompt()">保存</button></div></div>
</div>`,

    modalModuleEdit: `<div class="modal-overlay" id="modalModuleEdit">
  <div class="modal"><div class="modal-header"><h3 id="modalModuleTitle">编辑模块</h3><button class="icon-btn" onclick="UIManager.closeModal('modalModuleEdit')">✕</button></div>
  <div class="modal-body">
    <input type="hidden" id="moduleEditId">
    <div class="form-group"><label>模块名称</label><input type="text" id="moduleEditName" placeholder="如：角色设定、文风指引"></div>
    <div class="form-row">
      <div class="form-group"><label>类型</label><select id="moduleEditKind"><option value="system">system</option><option value="user_think">user（思维链）</option></select></div>
      <div class="form-group"><label>适用模式</label><select id="moduleEditMode"><option value="both">两个模式都用</option><option value="novel">只用在续写模式</option><option value="chat">只用在演出模式</option></select></div>
    </div>
    <div style="font-size:12px;color:var(--text-muted);line-height:1.5;margin:-2px 0 10px;">类型＝这条模块的去处，位置由软件负责，模块里不用写「放在历史之后」这类说明。<br>・system：按顺序拼进<b>最前面的系统提示词</b>（世界书、正文/演出记录之前）——大部分设定、文风、协议放这里。<br>・user（思维链）：放在<b>最后一条用户消息的末尾</b>（贴着生成点，实测越靠后越管用）——讲「思考多长、想什么、什么时候停」的模块选它；思考强度设为关闭（或模型没有原生思考通道）时软件会自动跳过它。<br>导入的酒馆预设里 role=user 但与思考无关的条目（文风、禁词等）显示为「user（末尾·非思维链）」：同样放末尾，但不受思考开关影响。</div>
    <div class="form-group"><label>模块内容</label><textarea id="moduleEditContent" rows="8" placeholder="输入该模块的提示词内容..."></textarea></div>
  </div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalModuleEdit')">取消</button><button class="primary" onclick="UIManager.saveModule()">保存</button></div></div>
</div>`,

    modalRegex: `<div class="modal-overlay" id="modalRegex">
  <div class="modal wide"><div class="modal-header"><h3 id="modalRegexTitle">正则规则</h3><button class="icon-btn" onclick="UIManager.closeModal('modalRegex')">✕</button></div>
  <div class="modal-body"><input type="hidden" id="regexId"><div class="form-group"><label>规则名称</label><input type="text" id="regexName"></div>
  <div class="form-row"><div class="form-group"><label>正则表达式 (JavaScript)</label><input type="text" id="regexFind"></div><div class="form-group"><label>替换为 ($1-$9, {match})</label><input type="text" id="regexReplace"></div></div>
  <div class="form-row"><div class="form-group"><label>执行时机</label><select id="regexTiming"><option value="before">发送前替换</option><option value="after">接收后替换</option></select></div><div class="form-group" style="display:flex;align-items:flex-end;gap:12px;"><label style="display:flex;align-items:center;gap:8px;"><span>启用</span><span class="toggle"><input type="checkbox" id="regexEnabled" checked><span class="slider"></span></span></label></div></div></div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalRegex')">取消</button><button class="primary" onclick="UIManager.saveRegexRule()">保存</button></div></div>
</div>`,

    modalConfirm: `<div class="modal-overlay" id="modalConfirm">
  <div class="modal" style="max-width:400px;"><div class="modal-header"><h3>确认操作</h3><button class="icon-btn" onclick="UIManager.closeModal('modalConfirm')">✕</button></div>
  <div class="modal-body"><p id="confirmMessage"></p></div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalConfirm')">取消</button><button class="accent" id="confirmBtn" onclick="UIManager.confirmAction()">确认</button></div></div>
</div>`,

    modalProtagonist: `<div class="modal-overlay" id="modalProtagonist">
  <div class="modal"><div class="modal-header"><h3 id="modalProtagonistTitle">添加主角</h3><button class="icon-btn" onclick="UIManager.closeModal('modalProtagonist')">✕</button></div>
  <div class="modal-body">
    <input type="hidden" id="protagEditId">
    <div class="form-row"><div class="form-group"><label>姓名</label><input type="text" id="protagModalName" placeholder="主角姓名"></div><div class="form-group"><label>性别</label><input type="text" id="protagModalGender" placeholder="男/女/其他"></div></div>
    <div class="form-row"><div class="form-group"><label>年龄</label><input type="text" id="protagModalAge" placeholder="16"></div><div class="form-group"><label>职业</label><input type="text" id="protagModalOccupation" placeholder="高中生/冒险者/社畜"></div></div>
    <div class="form-group"><label>性格</label><input type="text" id="protagModalPersonality" placeholder="开朗乐观、有些冒失"></div>
    <div class="form-group"><label>外貌</label><textarea id="protagModalAppearance" rows="2" placeholder="外貌描述..."></textarea></div>
    <div class="form-group"><label>背景故事</label><textarea id="protagModalBackstory" rows="3" placeholder="背景故事..."></textarea></div>
    <div class="form-group"><label>能力技能</label><textarea id="protagModalAbilities" rows="2" placeholder="特殊能力、技能..."></textarea></div>
    <div class="form-group"><label>口头禅</label><input type="text" id="protagModalCatchphrase" placeholder="标志性台词"></div>
  </div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalProtagonist')">取消</button><button class="primary" onclick="UIManager.saveProtagonistFromModal()">保存</button></div></div>
</div>`,

modalWBEntry: `<div class="modal-overlay" id="modalWBEntry">
  <div class="modal"><div class="modal-header"><h3 id="modalWBEntryTitle">添加条目</h3><button class="icon-btn" onclick="UIManager.closeModal('modalWBEntry')">✕</button></div>
  <div class="modal-body">
    <input type="hidden" id="wbEntryEditId">
    <div class="form-group"><label>类型</label><select id="wbEntryType" onchange="UIManager.toggleWBEntryFields()"><option>世界观</option><option>角色</option><option>初始</option><option>其他</option><option>变量</option></select></div>
    <div class="form-group"><label>名称</label><input type="text" id="wbEntryName" placeholder="条目名称"></div>
    <div class="form-group"><label>内容</label><textarea id="wbEntryContent" rows="6" placeholder="条目的详细内容..."></textarea></div>
    <div id="wbEntryVarHint" style="display:none;font-size:12px;color:var(--text-muted);line-height:1.75;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-top:6px;">
      <b>变量条目：一个条目 = 一个变量。</b>名称就是变量名（如「任务数量」）；内容写它的讲解——是什么、怎么变化、范围或失败条件（可用 <code>{{user}}</code> 指代主角，也可用 <code>{{getvar::其它变量}}</code>）。<br>
      启用后每轮会把讲解与当前值发给模型，模型在正文之后按软件给定的格式回报新值，软件收进「变量」面板（输入栏上侧的小箭头），<b>不会留在正文里</b>。
    </div>
    <div id="wbEntryFields">
	    <label style="font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px;margin-top:4px;">
	      <input type="checkbox" id="wbEntryInject" checked> 注入（默认开启；关闭后此条目不注入）
	    </label>
    </div>
  </div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalWBEntry')">取消</button><button class="primary" onclick="UIManager.saveWBEntryFromModal()">保存</button></div></div>
</div>`,

    // 条目全文查看（只读）：点条目卡片右侧「查看」直接打开，内容区可滑动；需要改再点「编辑」。
    modalWBEntryView: `<div class="modal-overlay" id="modalWBEntryView">
  <div class="modal" style="max-width:560px;"><div class="modal-header"><h3 id="wbViewTitle">条目内容</h3><button class="icon-btn" onclick="UIManager.closeModal('modalWBEntryView')">✕</button></div>
  <div class="modal-body">
    <div id="wbViewMeta" style="font-size:12px;color:var(--text-muted);margin-bottom:6px;"></div>
    <div id="wbViewContent" style="white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;line-height:1.85;font-size:14px;max-height:60vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--bg-tertiary);"></div>
  </div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalWBEntryView')">关闭</button><button class="primary" onclick="UIManager.editFromWBView()">✎ 编辑</button></div></div>
</div>`,

    modalWBBook: `<div class="modal-overlay" id="modalWBBook">
  <div class="modal" style="max-width:400px;"><div class="modal-header"><h3 id="modalWBBookTitle">新建世界书</h3><button class="icon-btn" onclick="UIManager.closeModal('modalWBBook')">✕</button></div>
  <div class="modal-body"><input type="hidden" id="wbBookEditId"><div class="form-group"><label>世界书名称</label><input type="text" id="wbBookName" placeholder="例如：东大陆设定集"></div></div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalWBBook')">取消</button><button class="primary" onclick="UIManager.saveWBBookFromModal()">保存</button></div></div>
</div>`,

    modalCommunityLogin: `<div class="modal-overlay" id="modalCommunityLogin">
  <div class="modal"><div class="modal-header"><h3>登录社区</h3><button class="icon-btn" onclick="UIManager.closeModal('modalCommunityLogin')">✕</button></div>
  <div class="modal-body">
    <div class="form-group"><label>邮箱</label><input type="email" id="communityLoginEmail" placeholder="注册邮箱"></div>
    <div class="form-group"><label>密码</label><input type="password" id="communityLoginPassword" placeholder="至少 4 位"></div>
    <div style="font-size:12px;color:var(--text-muted);margin-top:4px;text-align:center;"><a href="javascript:void(0)" onclick="CommunityChat.switchToForgot()" style="color:var(--primary);">忘记密码？</a>　还没有账号？<a href="javascript:void(0)" onclick="CommunityChat.switchToRegister()" style="color:var(--primary);">立即注册</a></div>
  </div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalCommunityLogin')">取消</button><button class="primary" onclick="CommunityChat.doLogin()">登录</button></div></div>
</div>`,

    modalCommunityRegister: `<div class="modal-overlay" id="modalCommunityRegister">
  <div class="modal"><div class="modal-header"><h3>注册社区账号</h3><button class="icon-btn" onclick="UIManager.closeModal('modalCommunityRegister')">✕</button></div>
  <div class="modal-body">
    <div class="form-group"><label>昵称</label><input type="text" id="communityRegisterUsername" placeholder="2-20 位中英文/数字/_"></div>
    <div class="form-group"><label>密码</label><input type="password" id="communityRegisterPassword" placeholder="至少 4 位"></div>
    <div class="form-group"><label>确认密码</label><input type="password" id="communityRegisterPassword2" placeholder="再次输入密码"></div>
    <div class="form-group"><label>邮箱</label>
      <div style="display:flex;gap:6px;">
        <input type="email" id="communityRegisterEmail" placeholder="用于登录和找回密码" style="flex:1;min-width:0;">
        <button class="small" id="registerSendCodeBtn" onclick="CommunityChat.sendCode('register')" style="flex-shrink:0;">发送验证码</button>
      </div>
    </div>
    <div class="form-group"><label>验证码</label><input type="text" id="communityRegisterCode" placeholder="邮箱收到的 6 位数字" inputmode="numeric" maxlength="6"></div>
    <div style="font-size:12px;color:var(--text-muted);margin-top:4px;text-align:center;">已有账号？<a href="javascript:void(0)" onclick="CommunityChat.switchToLogin()" style="color:var(--primary);">去登录</a></div>
  </div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalCommunityRegister')">取消</button><button class="primary" onclick="CommunityChat.doRegister()">注册</button></div></div>
</div>`,

    modalCommunityForgot: `<div class="modal-overlay" id="modalCommunityForgot">
  <div class="modal"><div class="modal-header"><h3>找回密码</h3><button class="icon-btn" onclick="UIManager.closeModal('modalCommunityForgot')">✕</button></div>
  <div class="modal-body">
    <div class="form-group"><label>注册邮箱</label>
      <div style="display:flex;gap:6px;">
        <input type="email" id="communityForgotEmail" placeholder="注册时填写的邮箱" style="flex:1;min-width:0;">
        <button class="small" id="forgotSendCodeBtn" onclick="CommunityChat.sendCode('reset')" style="flex-shrink:0;">发送验证码</button>
      </div>
    </div>
    <div class="form-group"><label>验证码</label><input type="text" id="communityForgotCode" placeholder="邮箱收到的 6 位数字" inputmode="numeric" maxlength="6"></div>
    <div class="form-group"><label>新密码</label><input type="password" id="communityForgotNewPassword" placeholder="至少 4 位"></div>
  </div>
  <div class="modal-footer"><button onclick="CommunityChat.switchToLogin()">返回登录</button><button class="primary" onclick="CommunityChat.doResetPassword()">重置密码</button></div></div>
</div>`,

    modalCommunityProfile: `<div class="modal-overlay" id="modalCommunityProfile">
  <div class="modal"><div class="modal-header"><h3>个人中心</h3><button class="icon-btn" onclick="UIManager.closeModal('modalCommunityProfile')">✕</button></div>
  <div class="modal-body" style="display:flex;flex-direction:column;gap:10px;">
    <!-- 虚线圆角框：昵称 + 修改昵称 -->
    <div style="border:1.5px dashed var(--border);border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:12px;">
      <span style="font-size:16px;">👤</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:15px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" id="cpNickname"></div>
      </div>
      <button class="small" onclick="CommunityChat.openRename()">修改昵称</button>
    </div>
    <!-- 邮箱（登录账号）：显示真实邮箱，让用户知道自己是用哪个邮箱登录的 -->
    <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border:1px solid var(--border);border-radius:12px;">
      <span style="font-size:14px;">📧</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;color:var(--text-muted);">邮箱（登录账号）</div>
        <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" id="cpEmail"></div>
      </div>
    </div>
    <!-- 退出登录 -->
    <button class="small danger" style="padding:10px;border-radius:12px;background:var(--bg-tertiary);color:var(--accent);font-size:14px;" onclick="CommunityChat.logout()">退出登录</button>
    <!-- 分类：我的世界书 / 我的预设 -->
    <div style="display:flex;gap:6px;margin-top:2px;border-bottom:1px solid var(--border);">
      <div class="cup-tab active" id="cpTabWb" onclick="CommunityChat.cpSwitchTab('wb')" style="flex:1;text-align:center;padding:10px 0;font-size:14px;cursor:pointer;color:var(--primary);font-weight:600;border-bottom:2px solid var(--primary);">我的世界书</div>
      <div class="cup-tab" id="cpTabPreset" onclick="CommunityChat.cpSwitchTab('preset')" style="flex:1;text-align:center;padding:10px 0;font-size:14px;cursor:pointer;color:var(--text-muted);border-bottom:2px solid transparent;">我的预设</div>
    </div>
    <div id="cpWbPane" style="display:flex;flex-direction:column;gap:2px;max-height:280px;overflow-y:auto;"></div>
    <div id="cpPresetPane" style="display:none;max-height:280px;overflow-y:auto;"></div>
  </div>
</div>
</div>`,

    modalCommunityWbUpload: `<div class="modal-overlay" id="modalCommunityWbUpload">
  <div class="modal"><div class="modal-header"><h3>↑ 上传世界书</h3><button class="icon-btn" onclick="UIManager.closeModal('modalCommunityWbUpload')">✕</button></div>
  <div class="modal-body">
    <div class="form-group"><label>选择要上传的世界书</label><select id="wbUploadSelect" style="font-size:14px;"></select></div>
    <div style="font-size:12px;color:var(--text-muted);margin:-4px 0 10px;">选择软件内已有的世界书，将序列化后公开到社区。</div>
    <div class="form-group"><label>封面图片（可选）</label>
      <div class="wb-cover-pick" onclick="document.getElementById('communityWbCoverInput').click()">
        <img id="wbCoverPreview" alt="" style="width:100%;height:100%;object-fit:cover;display:none;">
        <span id="wbCoverPlaceholder">点击选择图片</span>
      </div>
    </div>
    <div class="form-group"><label>简介</label><textarea id="wbUploadDesc" rows="3" placeholder="写点什么介绍它（可选）" maxlength="500"></textarea></div>
    <div class="form-group"><label>分类</label><select id="wbUploadCategory"><option value="奇幻">奇幻</option><option value="科幻">科幻</option><option value="都市">都市</option><option value="古风">古风</option><option value="二次元">二次元</option><option value="综合">综合</option></select></div>
    <div id="wbUploadEmpty" style="display:none;font-size:12px;color:var(--accent);">软件里还没有世界书，先在「世界」页创建一个再上传吧。</div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">提交后需管理员审核通过才会公开（个人中心 → 我的世界书 里看状态）。上传立即完成；用于检索的 AI 标签会在后头自动补齐（用你自己的 API key，失败不影响分享）。</div>
  </div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalCommunityWbUpload')">取消</button><button class="primary" id="wbUploadBtn" onclick="CommunityChat.doWbUpload()">上传</button></div></div>
</div>`,

    modalCommunityPresetUpload: `<div class="modal-overlay" id="modalCommunityPresetUpload">
  <div class="modal"><div class="modal-header"><h3>上传预设</h3><button class="icon-btn" onclick="UIManager.closeModal('modalCommunityPresetUpload')">✕</button></div>
  <div class="modal-body">
    <div class="form-group"><label>选择要上传的预设</label>
      <select id="predUploadSelect"></select>
    </div>
    <div style="font-size:12px;color:var(--text-muted);margin:-4px 0 10px;">选择软件内已有的预设，将序列化后公开到社区（只含提示词模块与正则，不含你的对话内容）。</div>
    <div class="form-group"><label>封面图片（可选）</label>
      <div class="wb-cover-pick" onclick="document.getElementById('communityPredCoverInput').click()">
        <img id="predCoverPreview" alt="" style="width:100%;height:100%;object-fit:cover;display:none;">
        <span id="predCoverPlaceholder">点击选择图片</span>
      </div>
    </div>
    <div class="form-group"><label>简介</label><textarea id="predUploadDesc" rows="3" placeholder="写点什么介绍它（可选）" maxlength="500"></textarea></div>
    <div class="form-group"><label>分类</label><select id="predUploadCategory"><option value="奇幻">奇幻</option><option value="科幻">科幻</option><option value="都市">都市</option><option value="古风">古风</option><option value="二次元">二次元</option><option value="写作技巧">写作技巧</option><option value="综合">综合</option></select></div>
    <div id="predUploadEmpty" style="display:none;font-size:12px;color:var(--accent);">软件里还没有预设，先在「预设」页创建一个再上传吧。</div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">提交后需管理员审核通过才会公开（个人中心 → 我的预设 里看状态）。</div>
  </div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalCommunityPresetUpload')">取消</button><button class="primary" onclick="CommunityChat.doPredUpload()">上传</button></div></div>
</div>`,

    modalCommunityPresetDetail: `<div class="modal-overlay" id="modalCommunityPresetDetail">
  <div class="modal"><div class="modal-header"><h3>预设详情</h3><button class="icon-btn" onclick="UIManager.closeModal('modalCommunityPresetDetail')">✕</button></div>
  <div class="modal-body" id="predDetailBody">
    <!-- 详情由 JS 填充 -->
  </div>
  <div class="modal-footer" style="justify-content:space-between;">
    <button class="small danger" id="predDeleteBtn" style="display:none;background:var(--accent);color:#fff;border:none;" onclick="CommunityChat.deletePred()">删除</button>
    <span style="flex:1;"></span>
    <button onclick="UIManager.closeModal('modalCommunityPresetDetail')">关闭</button>
    <button class="primary" onclick="CommunityChat.downloadPred()">⬇ 导入到我的预设</button>
  </div></div>
</div>`,

    modalCommunityWbCrop: `<div class="modal-overlay" id="modalCommunityWbCrop">
  <div class="modal"><div class="modal-header"><h3>裁剪封面</h3><button class="icon-btn" onclick="CommunityChat.closeCrop()">✕</button></div>
  <div class="modal-body" style="display:flex;flex-direction:column;align-items:center;gap:10px;overflow:hidden;">
    <div id="cropStage" style="position:relative;width:min(280px,100%);aspect-ratio:2/3;overflow:hidden;border-radius:10px;background:#000;touch-action:none;user-select:none;">
      <div id="cropPreview" style="position:absolute;left:0;top:0;width:100%;height:100%;background-repeat:no-repeat;background-position:center;background-size:cover;"></div>
      <div id="cropBox" style="position:absolute;border:2px solid #fff;box-shadow:0 0 0 9999px rgba(0,0,0,0.55);cursor:move;touch-action:none;">
        <div class="crop-handle" id="cropHandleNW" style="left:-8px;top:-8px;cursor:nwse-resize;"></div>
        <div class="crop-handle" id="cropHandleNE" style="right:-8px;top:-8px;cursor:nesw-resize;"></div>
        <div class="crop-handle" id="cropHandleSW" style="left:-8px;bottom:-8px;cursor:nesw-resize;"></div>
        <div class="crop-handle" id="cropHandleSE" style="right:-8px;bottom:-8px;cursor:nwse-resize;"></div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--text-muted);text-align:center;">拖动矩形框移动位置，拖四个角调整大小（高:宽=1.5:1），框内为封面区域</div>
  </div>
  <div class="modal-footer"><button onclick="CommunityChat.closeCrop()">取消</button><button class="primary" onclick="CommunityChat.confirmCrop()">确认裁剪</button></div></div>
</div>`,

    modalCommunityWbDetail: `<div class="modal-overlay" id="modalCommunityWbDetail">
  <div class="modal"><div class="modal-header"><h3>世界书详情</h3><button class="icon-btn" onclick="UIManager.closeModal('modalCommunityWbDetail')">✕</button></div>
  <div class="modal-body" id="wbDetailBody">
    <!-- 详情由 JS 填充 -->
  </div>
  <div class="modal-footer" style="justify-content:space-between;">
    <button class="small danger" id="wbDeleteBtn" style="display:none;background:var(--accent);color:#fff;border:none;" onclick="CommunityChat.deleteWb()">删除</button>
    <span style="flex:1;"></span>
    <button onclick="UIManager.closeModal('modalCommunityWbDetail')">关闭</button>
    <button class="primary" onclick="CommunityChat.downloadWb()">⬇ 导入到我的世界书</button>
  </div></div>
</div>`,

    modalCommunityRename: `<div class="modal-overlay" id="modalCommunityRename">
  <div class="modal"><div class="modal-header"><h3>修改昵称</h3><button class="icon-btn" onclick="UIManager.closeModal('modalCommunityRename')">✕</button></div>
  <div class="modal-body">
    <div class="form-group"><label>新昵称</label><input type="text" id="communityRenameNickname" placeholder="2-20 位中英文/数字/_" maxlength="20"></div>
    <div style="font-size:12px;color:var(--text-muted);">昵称只用于展示，不影响登录；历史消息仍显示发送时的昵称。</div>
  </div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalCommunityRename')">取消</button><button class="primary" onclick="CommunityChat.doRename()">保存</button></div></div>
</div>`,

    modalCharCardImport: `<div class="modal-overlay" id="modalCharCardImport">
  <div class="modal" style="max-width:550px;"><div class="modal-header"><h3>导入PNG角色卡</h3><button class="icon-btn" onclick="UIManager.closeModal('modalCharCardImport')">✕</button></div>
  <div class="modal-body">
    <div id="charCardPreview" style="max-height:300px;overflow-y:auto;margin-bottom:12px;"></div>
    <div id="charCardStatus" style="font-size:12px;color:var(--text-muted);"></div>
  </div>
  <div class="modal-footer">
    <button onclick="UIManager.closeModal('modalCharCardImport')">取消</button>
    <button class="primary" id="btnCharCardConfirm" onclick="App.processCharCards()">导入并创建条目</button>
  </div></div>
</div>`,

    modalDBRecord: `<div class="modal-overlay" id="modalDBRecord">
  <div class="modal"><div class="modal-header"><h3 id="dbRecordModalTitle">编辑记录</h3><button class="icon-btn" onclick="UIManager.closeModal('modalDBRecord')">✕</button></div>
  <div class="modal-body" id="dbRecordFields">
    <input type="hidden" id="dbRecordTableId">
    <input type="hidden" id="dbRecordId">
  </div>
  <div class="modal-footer"><button onclick="UIManager.closeModal('modalDBRecord')">取消</button><button class="primary" onclick="UIManager.saveDBRecordFromModal()">保存</button></div></div>
</div>`,

    modalAppUpdate: `<div class="modal-overlay" id="modalAppUpdate">
  <div class="modal"><div class="modal-header"><h3>发现新版本</h3><button class="icon-btn" onclick="UpdateManager.close()">✕</button></div>
  <div class="modal-body">
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;" id="updVersion"></div>
    <div style="font-size:13px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap;max-height:22vh;overflow-y:auto;margin-bottom:12px;" id="updNote"></div>
    <div id="updDownloading" style="display:none;height:14px;background:var(--bg-tertiary);border-radius:7px;overflow:hidden;">
      <div id="updBar" style="height:100%;width:0%;background:var(--primary);border-radius:7px;transition:width .2s;"></div>
    </div>
    <div style="font-size:11px;color:var(--text-muted);text-align:right;margin-top:4px;" id="updPct"></div>
  </div>
  <div class="modal-footer">
    <button onclick="UpdateManager.close()">稍后再说</button>
    <button class="primary" id="updBtn" onclick="UpdateManager.startUpdate()">立即更新</button>
  </div></div>
</div>`,

    modalWbAddSheet: `<div class="modal-overlay" id="modalWbAddSheet">
  <div class="modal" style="max-width:420px;">
    <div class="modal-header"><h3>添加世界书</h3><button class="icon-btn" onclick="UIManager.closeModal('modalWbAddSheet')">✕</button></div>
    <div class="modal-body" style="padding:10px 12px 12px;">
      <div class="as-list">
        <button class="as-btn" onclick="UIManager.closeModal('modalWbAddSheet');UIManager.showWBBookModal()">
          <span style="flex:1;min-width:0;"><div>新建世界书</div><div class="as-sub">从零开始创建一本空白世界书</div></span>
        </button>
        <button class="as-btn" onclick="UIManager.closeModal('modalWbAddSheet');App.importWorldBook()">
          <span style="flex:1;min-width:0;"><div>导入 JSON</div><div class="as-sub">导入之前导出的世界书备份</div></span>
        </button>
        <button class="as-btn" onclick="UIManager.closeModal('modalWbAddSheet');App.importCharacterCard()">
          <span style="flex:1;min-width:0;"><div>导入酒馆角色卡</div><div class="as-sub">解析 PNG 角色卡并自动建书</div></span>
        </button>
      </div>
      <button class="as-cancel" onclick="UIManager.closeModal('modalWbAddSheet')">取消</button>
    </div>
  </div>
</div>`,

    modalWbBookSheet: `<div class="modal-overlay" id="modalWbBookSheet">
  <div class="modal" style="max-width:420px;">
    <div class="modal-header"><h3 id="wbSheetBookName">世界书</h3><button class="icon-btn" onclick="UIManager.closeModal('modalWbBookSheet')">✕</button></div>
    <div class="modal-body" style="padding:10px 12px 12px;">
      <div class="as-list">
        <button class="as-btn" onclick="UIManager.wbSheetAction('cover')">
          <span style="flex:1;min-width:0;"><div>编辑封面</div><div class="as-sub">选一张图裁剪成 2:3 封面</div></span>
        </button>
        <button class="as-btn" onclick="UIManager.wbSheetAction('rename')">
          <span style="flex:1;min-width:0;"><div>编辑书名</div><div class="as-sub">修改这本世界书的名称</div></span>
        </button>
        <button class="as-btn" onclick="UIManager.wbSheetAction('export')">
          <span style="flex:1;min-width:0;"><div>导出 JSON</div><div class="as-sub">导出整本书的条目与封面</div></span>
        </button>
        <button class="as-btn danger" onclick="UIManager.wbSheetAction('delete')">
          <span style="flex:1;min-width:0;"><div>删除世界书</div><div class="as-sub">整本书及其条目将被移除</div></span>
        </button>
      </div>
      <button class="as-cancel" onclick="UIManager.closeModal('modalWbBookSheet')">取消</button>
    </div>
  </div>
</div>`,

    modalAdminAuth: `<div class="modal-overlay" id="modalAdminAuth">
  <div class="modal" style="max-width:360px;">
    <div class="modal-header"><h3>管理员模式</h3><button class="icon-btn" onclick="UIManager.closeAdminAuth()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label>管理员口令</label>
        <input type="password" id="adminPwInput" autocomplete="off" placeholder="请输入口令" onkeydown="if(event.key==='Enter'){UIManager.submitAdminAuth();}"></div>
      <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">开启后模型只可见最近 1 万字，更早的正文只能靠记忆回读；再连点 10 下「检查更新」退出。</div>
    </div>
    <div class="modal-footer"><button onclick="UIManager.closeAdminAuth()">取消</button><button class="primary" onclick="UIManager.submitAdminAuth()">确定</button></div></div>
</div>`
  },

  init(): void {
    const container = document.createElement('div');
    container.id = 'modalContainer';
    Object.values(this._modals).forEach(html => {
      container.innerHTML += html;
    });
    document.body!.appendChild(container);
  }
};

(globalThis as unknown as { Modals: typeof Modals }).Modals = Modals;
export default Modals;