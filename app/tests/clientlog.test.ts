// ClientLog 两级错误上报：
// - sanitize 密钥打码（sk-/user_/Bearer）
// - pending 24h 同签名去重
// - flush 成功记签名 / 失败进冷却（不重试）
// - 每日配额上限
// - notifyError 噪音过滤 + 防抖合并
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type ClientLogLike = typeof import('../src/domain/clientlog').ClientLog;

// 每个用例重置模块（冷却时间戳等模块级状态）+ 清空 localStorage + 重置 fetch mock
let CL: ClientLogLike;
beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../src/domain/clientlog');
  CL = mod.ClientLog;
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function seedErrLog(entries: Array<{ t: number; k: string; m: string }>) {
  localStorage.setItem('__errLog', JSON.stringify(entries));
}
function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
}
async function settle() { await new Promise((r) => setTimeout(r, 10)); }

describe('sanitize 密钥打码', () => {
  it('sk- / user_ / Bearer 形态一律 [KEY]，并截断 300 字', () => {
    const s1 = CL.sanitize('请求失败 key=sk-abcdefgh12345678 请检查');
    expect(s1).toContain('[KEY]');
    expect(s1).not.toContain('sk-abcdefgh12345678');
    const s2 = CL.sanitize('auth error user_AbCdEfGhIjKlMnOpQrStUv');
    expect(s2).toContain('[KEY]');
    expect(s2).not.toContain('user_AbCdEfGhIjKlMnOpQrStUv');
    const s3 = CL.sanitize('Authorization: Bearer abc.def.ghi 被拒');
    expect(s3).toContain('Bearer [KEY]');
    expect(s3).not.toContain('abc.def.ghi');
    expect(CL.sanitize('x'.repeat(500)).length).toBe(300);
  });

  it('普通错误消息原样保留', () => {
    expect(CL.sanitize('CardWriterChat is not defined')).toBe('CardWriterChat is not defined');
  });
});

describe('flush 尽力而为上报', () => {
  it('成功：POST 一次、载荷含打码消息与版本/平台，签名入账后不再重发', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    seedErrLog([
      { t: 111, k: '脚本错误', m: 'boom sk-abcdefgh12345678' },
      { t: 222, k: '写卡发送', m: 'CardWriterChat is not defined' }
    ]);
    CL.flush('test');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.logs).toHaveLength(2);
    expect(body.logs[0].m).toContain('[KEY]');
    expect(body.logs[0].m).not.toContain('sk-abcdefgh12345678');
    expect(typeof body.logs[0].plat).toBe('string');
    // 签名入账：同错误不再 pending
    expect(CL.pending()).toHaveLength(0);
    CL.flush('test');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1); // 没有新条目，不重发
  });

  it('失败：静默进冷却，冷却期内不再发起请求（条目留在本地）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    seedErrLog([{ t: 1, k: '脚本错误', m: 'offline boom' }]);
    CL.flush('test');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(CL.pending()).toHaveLength(1); // 上报失败，条目留在本地
    CL.flush('test'); // 冷却期内
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1); // 不重试
  });

  it('每日配额：达到上限后不再发请求', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    localStorage.setItem('__clDay', JSON.stringify({ day, n: 20 }));
    seedErrLog([{ t: 1, k: '脚本错误', m: 'capped' }]);
    CL.flush('test');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('24h 去重：同签名已上报的条目不进 pending', () => {
    seedErrLog([{ t: 1, k: '脚本错误', m: 'same old error' }]);
    const sig = '脚本错误|same old error';
    localStorage.setItem('__clSigs', JSON.stringify({ [sig]: Date.now() - 3600 * 1000 })); // 1h 前报过
    expect(CL.pending()).toHaveLength(0);
    localStorage.setItem('__clSigs', JSON.stringify({ [sig]: Date.now() - 25 * 3600 * 1000 })); // 25h 前报过
    expect(CL.pending()).toHaveLength(1);
  });
});

describe('notifyError 节流直发', () => {
  it('资源加载失败类噪音不触发上报', () => {
    vi.useFakeTimers();
    CL.notifyError('资源加载失败', 'favicon.ico');
    vi.advanceTimersByTime(10000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('连续错误防抖合并为一次上报', async () => {
    vi.useFakeTimers();
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    seedErrLog([ // index.html record() 先写 __errLog 再调 notifyError（此处模拟该顺序）
      { t: 1, k: '脚本错误', m: 'a' },
      { t: 2, k: '脚本错误', m: 'b' },
      { t: 3, k: '异步错误', m: 'c' }
    ]);
    CL.notifyError('脚本错误', 'a');
    CL.notifyError('脚本错误', 'b');
    CL.notifyError('异步错误', 'c');
    expect(fetchMock).not.toHaveBeenCalled(); // 8 秒窗口内不逐条发
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 防抖到期合并为一次
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.logs.length).toBeGreaterThanOrEqual(3); // __errLog 里的条目一并带走
  });
});
