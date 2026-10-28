import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwtUtils from '../src/utils/jwt-utils';
import userService from '../src/service/user-service';
import permService from '../src/service/perm-service';
import constant from '../src/const/constant';
import KvConst from '../src/const/kv-const';

// 隔离数据库与签名服务，实际执行 Hono 鉴权中间件和错误响应流程。
vi.mock('../src/utils/jwt-utils', () => ({ default: { verifyToken: vi.fn() } }));
vi.mock('../src/service/user-service', () => ({ default: { updateUserInfo: vi.fn() } }));
vi.mock('../src/service/perm-service', () => ({ default: { userPermKeys: vi.fn() } }));
vi.mock('../src/i18n/i18n', () => ({ t: key => key }));

let app;
let env;
let authInfo;

// 请求受保护的读取接口，检查已验证用户是否能到达业务处理函数。
async function readInbox(path = '/my/loginUserInfo') {
	const response = await app.request(path, { headers: { Authorization: 'signed-token' } }, env);
	return response.json();
}

// 重建中间件实例与持久化会话，保证每日写额度退避不会串扰其他测试。
beforeEach(async () => {
	vi.resetAllMocks();
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'log').mockImplementation(() => {});
	authInfo = {
		user: { userId: 7, email: 'reader@example.com' },
		tokens: ['session-token'],
		refreshTime: '2026-10-26T12:00:00Z'
	};
	env = { admin: 'admin@example.com', kv: { get: vi.fn(), put: vi.fn() } };
	jwtUtils.verifyToken.mockResolvedValue({ userId: 7, token: 'session-token' });
	userService.updateUserInfo.mockResolvedValue(undefined);
	permService.userPermKeys.mockResolvedValue([]);
	// 每次读取均返回独立副本，准确模拟 KV 序列化后的会话数据。
	env.kv.get.mockImplementation(async () => structuredClone(authInfo));
	// 成功续期后更新持久化会话，后续读取不应再次写 KV。
	env.kv.put.mockImplementation(async (key, value) => { authInfo = JSON.parse(value); });
	app = (await import('../src/hono/hono')).default;
	await import('../src/security/security');
	// 使用当前中间件登记测试路由，成功时返回已经校验的用户。
	app.get('/my/loginUserInfo', c => c.json({ code: 200, userId: c.get('user').userId }));
	// 使用需要权限的真实路径验证额度耗尽时仍执行权限检查。
	app.get('/email/delete', c => c.json({ code: 200 }));
});

// 恢复全局时间和日志，避免影响其他测试文件。
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// KV 写额度耗尽只能影响可选续期，不能放宽已有的身份与权限检查。
describe('KV 写额度与会话续期', () => {
	// 当天会话已经续期时，普通读取完全不写 KV。
	it('当天已续期的会话无需写入 KV', async () => {
		authInfo.refreshTime = new Date().toISOString();
		expect(await readInbox()).toEqual({ code: 200, userId: 7 });
		expect(env.kv.put).not.toHaveBeenCalled();
		expect(userService.updateUserInfo).not.toHaveBeenCalled();
	});

	// 正常情况下仍按既有规则每天续期一次并保留令牌列表。
	it('跨日会话正常续期，并保留原有过期时间设置', async () => {
		expect(await readInbox()).toEqual({ code: 200, userId: 7 });
		expect(await readInbox()).toEqual({ code: 200, userId: 7 });
		expect(env.kv.put).toHaveBeenCalledTimes(1);
		expect(env.kv.put).toHaveBeenCalledWith(KvConst.AUTH_INFO + 7, JSON.stringify(authInfo), {
			expirationTtl: constant.TOKEN_EXPIRE
		});
		expect(authInfo.tokens).toEqual(['session-token']);
	});

	// 复现线上每日额度报错，验证已有会话仍可读取，且当前实例暂缓重复续期。
	it('当天写额度耗尽时读取仍成功，后续请求不重复尝试续期', async () => {
		env.kv.put.mockRejectedValue(new Error('KV put() limit exceeded for the day.'));
		expect(await readInbox()).toEqual({ code: 200, userId: 7 });
		expect(await readInbox()).toEqual({ code: 200, userId: 7 });
		expect(jwtUtils.verifyToken).toHaveBeenCalledTimes(2);
		expect(env.kv.get).toHaveBeenCalledTimes(2);
		expect(env.kv.put).toHaveBeenCalledTimes(1);
		expect(userService.updateUserInfo).toHaveBeenCalledTimes(1);
		expect(console.warn).toHaveBeenCalledTimes(1);
	});

	// 额度在 UTC 午夜重置，新的 UTC 日允许再次尝试续期。
	it('UTC 午夜过后重新尝试会话续期', async () => {
		env.kv.put.mockRejectedValueOnce(new Error('KV put() limit exceeded for the day.'));
		await readInbox();
		vi.setSystemTime(new Date('2026-10-28T23:59:59Z'));
		await readInbox();
		expect(env.kv.put).toHaveBeenCalledTimes(1);
		vi.setSystemTime(new Date('2026-10-29T00:00:01Z'));
		expect(await readInbox()).toEqual({ code: 200, userId: 7 });
		expect(env.kv.put).toHaveBeenCalledTimes(2);
	});

	// 无效签名仍拒绝访问，不能因额度问题绕过身份验证。
	it('无效 JWT 仍返回未授权', async () => {
		jwtUtils.verifyToken.mockResolvedValue(null);
		expect((await readInbox()).code).toBe(401);
		expect(env.kv.get).not.toHaveBeenCalled();
		expect(env.kv.put).not.toHaveBeenCalled();
	});

	// 已撤销的会话令牌仍无法访问受保护接口。
	it('已撤销的会话仍返回未授权', async () => {
		authInfo.tokens = [];
		expect((await readInbox()).code).toBe(401);
		expect(env.kv.put).not.toHaveBeenCalled();
	});

	// KV 中不存在的会话不能被当作登录成功。
	it('会话记录不存在时仍返回未授权', async () => {
		env.kv.get.mockResolvedValue(null);
		expect((await readInbox()).code).toBe(401);
		expect(env.kv.put).not.toHaveBeenCalled();
	});

	// 用户权限检查始终发生在可选续期之前。
	it('缺少业务权限时仍返回禁止访问', async () => {
		env.kv.put.mockRejectedValue(new Error('KV put() limit exceeded for the day.'));
		expect((await readInbox('/email/delete')).code).toBe(403);
		expect(env.kv.put).not.toHaveBeenCalled();
	});

	// KV 读取失败时不能跳过会话核验。
	it('KV 读取错误仍返回失败', async () => {
		env.kv.get.mockRejectedValue(new Error('KV get() limit exceeded for the day.'));
		expect((await readInbox()).message).toBe('KV get() limit exceeded for the day.');
		expect(env.kv.put).not.toHaveBeenCalled();
	});

	// 只处理明确的每日写额度错误，其他续期故障仍正常上报。
	it('其他 KV 写入错误不会被吞掉', async () => {
		env.kv.put.mockRejectedValue(new Error('KV network unavailable'));
		expect((await readInbox()).message).toBe('KV network unavailable');
	});
});
