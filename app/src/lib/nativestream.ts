// 原生流式取数（B 方案）：Android 插件 NativeStream 的前端门面。
//
// 背景：端点在 WebView 里被 CORS 拦下时，App 原来只有两条路——本地代理（只改写 https；那条是真流式）
// 或 CapacitorHttp 整段缓冲（没流式）。这个模块提供第三条：**原生裸 socket 边收边给**（见
// NativeStreamCore.java / NativeStreamPlugin.java），http/https 端点都行、也不看端点的 CORS 脸色。
//
// 可用性：只有 APK 带这个插件时才可用（老 APK 上 `Capacitor.Plugins.NativeStream` 不存在）→
// available() 为 false，调用方照旧走别的通道。**所以同一个网页包在两类 APK 上都能跑**。
//
// 契约（与插件一一对应）：
//   open() → { id, status }（响应头到手就回；非 2xx 也算成功返回）
//   事件 chunk{id,b64} / done{id} / error{id,message}；close() 取消
// 这里把它包装成"一次请求 → { status, stream }"：2xx 给可读流（解包后的原始字节），
// 非 2xx 把错误体收齐后连状态一起返回（交给调用方按 HTTP 错误处理）。
// 头都没拿到（连不上 / TLS / 头超时）→ 抛错，调用方回退老通道。

export interface NativeStreamOk { status: number; stream: ReadableStream<Uint8Array>; id: string }
export interface NativeStreamHttpError { status: number; bodyText: string; id: string }
export type NativeStreamResult = NativeStreamOk | NativeStreamHttpError;

interface PluginLike {
  open(o: { url: string; headers: Record<string, string>; body: string; connectTimeoutMs?: number; headTimeoutMs?: number }): Promise<{ id?: string; status?: number }>;
  close(o: { id: string }): Promise<unknown>;
  addListener?(ev: string, cb: (d: any) => void): unknown;
}

function getPlugin(): PluginLike | null {
  try {
    const cap: any = (globalThis as unknown as { Capacitor?: any }).Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
    const p = cap.Plugins && cap.Plugins.NativeStream;
    return p && typeof p.open === 'function' && typeof p.close === 'function' ? (p as PluginLike) : null;
  } catch (e) { return null; }
}

/** 这台设备 + 这个 APK 有没有原生流式通道（老 APK 返回 false，调用方无感）。 */
export function nativeStreamAvailable(): boolean { return !!getPlugin(); }

/** base64 → 字节（插件按 base64 传，避免 UTF-8 被逐段切断；拼接后由 TextDecoder({stream:true}) 解码）。 */
export function b64ToBytes(b64: string): Uint8Array {
  try {
    const bin = atob(String(b64 || ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 0xff;
    return u8;
  } catch (e) { return new Uint8Array(0); }
}

function abortErr(): Error {
  try { return new DOMException('The operation was aborted.', 'AbortError'); }
  catch (e) { const err = new Error('aborted'); (err as any).name = 'AbortError'; return err; }
}

/**
 * 发一次原生流式请求。**只有头拿到之后才会 resolve**；失败抛错（调用方回退）。
 * signal 触发 → 调 close 取消原生连接，并把流 error 成 AbortError（与 fetch 的取消语义一致）。
 */
export async function nativeStreamFetch(opts: {
  url: string;
  headers: Record<string, string>;
  body: string;
  connectTimeoutMs?: number;
  headTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<NativeStreamResult> {
  const p = getPlugin();
  if (!p) throw new Error('原生流式通道不可用（APK 没带 NativeStream 插件）');
  if (opts.signal && opts.signal.aborted) throw abortErr();

  let controller: any = null;               // ReadableStream 的 controller（start 回调里赋值；用 any 绕开 TS 的收窄）
  let closed = false;
  let streamDone = false;
  const chunks: Uint8Array[] = [];          // 头拿到之前先到的片（正常不会有，防事件乱序）
  let errBeforeId: string | null = null;
  let id = '';

  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel() { void doClose(); }            // 调用方取消读流 → 也把原生连接关掉
  });

  async function doClose(): Promise<void> {
    if (closed || !id) return;
    closed = true;
    try { await p!.close({ id: id }); } catch (e) { /* 取消失败不影响 */ }
  }

  const onChunk = (d: any) => {
    const gotId = String((d && d.id) || '');
    if (id && gotId && gotId !== id) return;                 // 别的会话的事件，忽略
    const bytes = b64ToBytes(String((d && d.b64) || ''));
    if (!bytes.length) return;
    if (controller && id) {
      try { controller.enqueue(bytes); } catch (e) { /* 流已关 */ }
    } else {
      chunks.push(bytes);                                    // 头/ id 还没到手：先缓冲（正常不会有，防乱序）
    }
  };
  const detach = () => { try { opts.signal && opts.signal.removeEventListener('abort', onAbort); } catch (e) { /* ignore */ } };
  const onDone = (d: any) => {
    const gotId = String((d && d.id) || '');
    if (id && gotId && gotId !== id) return;
    streamDone = true;
    detach();
    try { if (controller) controller.close(); } catch (e) { /* 已关 */ }
  };
  const onError = (d: any) => {
    const gotId = String((d && d.id) || '');
    if (id && gotId && gotId !== id) return;
    const msg = String((d && d.message) || '原生流式中断');
    streamDone = true;
    detach();
    if (!id) { errBeforeId = msg; return; }
    try { controller && controller.error(new Error(msg)); } catch (e) { /* 已关 */ }
  };

  // 监听先挂上，再发请求（避免漏掉第一批片）
  try {
    if (p.addListener) {
      const l1 = p.addListener('chunk', onChunk);
      const l2 = p.addListener('done', onDone);
      const l3 = p.addListener('error', onError);
      await Promise.all([l1, l2, l3].filter((x) => x && typeof (x as Promise<unknown>).then === 'function'));
    }
  } catch (e) { /* 老插件没有 addListener：只能不挂（open 之后到片会被忽略），保守返回失败由调用方回退 */ }

  const onAbort = () => {
    streamDone = true;
    void doClose();
    try { controller && controller.error(abortErr()); } catch (e) { /* 已关 */ }
  };
  try { opts.signal && opts.signal.addEventListener('abort', onAbort); } catch (e) { /* ignore */ }

  let head: { id?: string; status?: number };
  try {
    head = await p.open({
      url: opts.url, headers: opts.headers || {}, body: String(opts.body || ''),
      connectTimeoutMs: opts.connectTimeoutMs, headTimeoutMs: opts.headTimeoutMs
    });
  } catch (e) {
    try { opts.signal && opts.signal.removeEventListener('abort', onAbort); } catch (e2) { /* ignore */ }
    throw new Error('原生流式：' + String((e && (e as Error).message) || e));
  }
  id = String((head && head.id) || '');
  const status = Number((head && head.status) || 0) || 0;
  if (!id) throw new Error('原生流式：插件没有返回会话 id');
  if (errBeforeId) throw new Error('原生流式：' + errBeforeId);
  for (const c of chunks.splice(0)) { try { controller && controller.enqueue(c); } catch (e) { /* ignore */ } }

  if (status >= 200 && status < 300) {
    return { status, stream, id };
  }
  // 非 2xx：把错误体收齐（跟 CapacitorHttp 兜底同一口径：状态 + 文本交给上层报错）
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      if (r.value && r.value.length) parts.push(r.value);
    }
  } catch (e) { /* 读中断：把已收到的当错误体 */ }
  let total = 0;
  for (const part of parts) total += part.length;
  const all = new Uint8Array(total);
  let off = 0;
  for (const part of parts) { all.set(part, off); off += part.length; }
  let bodyText = '';
  try { bodyText = new TextDecoder('utf-8').decode(all); } catch (e) { bodyText = ''; }
  void doClose();
  try { opts.signal && opts.signal.removeEventListener('abort', onAbort); } catch (e) { /* ignore */ }
  return { status, bodyText, id };
}
