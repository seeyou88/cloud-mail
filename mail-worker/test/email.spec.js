import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { email } from '../src/email/email';
import emailService from '../src/service/email-service';
import accountService from '../src/service/account-service';
import settingService from '../src/service/setting-service';
import attService from '../src/service/att-service';
import userService from '../src/service/user-service';
import aiService from '../src/service/ai-service';
import jwtUtils from '../src/utils/jwt-utils';
import { settingConst } from '../src/const/entity-const';

// 隔离数据库服务；邮件解析、Webhook 请求和 Telegram 请求使用真实实现。
vi.mock('../src/service/email-service', () => ({ default: { receive: vi.fn(), completeReceive: vi.fn() } }));
vi.mock('../src/service/account-service', () => ({ default: { selectByEmailIncludeDel: vi.fn() } }));
vi.mock('../src/service/setting-service', () => ({ default: { query: vi.fn() } }));
vi.mock('../src/service/att-service', () => ({ default: { addAtt: vi.fn() } }));
vi.mock('../src/service/user-service', () => ({ default: { selectByIdIncludeDel: vi.fn() } }));
vi.mock('../src/service/role-service', () => ({ default: {} }));
vi.mock('../src/service/ai-service', () => ({ default: { extractCode: vi.fn() } }));

const env = { admin: 'admin@example.com' };
let settings;
let storedEmail;
let fetchMock;

// 构造真实 MIME 邮件，覆盖普通附件和正文内嵌图片。
function createMessage(disposition) {
	const headers = [
		'From: Sender <sender@example.net>',
		'To: Admin <admin@example.com>',
		'Subject: Verification code',
		'MIME-Version: 1.0'
	];
	const body = disposition ? [
		'Content-Type: multipart/mixed; boundary="test-boundary"',
		'',
		'--test-boundary',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Your code is 123456',
		'--test-boundary',
		'Content-Type: image/png; name="pixel.png"',
		`Content-Disposition: ${disposition}; filename="pixel.png"`,
		'Content-ID: <pixel>',
		'Content-Transfer-Encoding: base64',
		'',
		'aGVsbG8=',
		'--test-boundary--'
	] : ['Content-Type: text/plain; charset=utf-8', '', 'Your code is 123456'];
	return {
		to: 'admin@example.com',
		raw: new Blob([[...headers, ...body].join('\r\n')]).stream(),
		setReject: vi.fn(),
		forward: vi.fn().mockResolvedValue(undefined)
	};
}

// 检查收件流程没有插入、更新邮件或保存附件。
function expectNoStorage() {
	expect(emailService.receive).not.toHaveBeenCalled();
	expect(emailService.completeReceive).not.toHaveBeenCalled();
	expect(attService.addAtt).not.toHaveBeenCalled();
}

// 为每个场景重置配置、数据库模拟和网络请求，禁止发出真实推送。
beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-10-23T08:00:00Z'));
	settings = {
		receive: settingConst.receive.OPEN,
		webhookStatus: settingConst.webhookStatus.OPEN,
		webhookUrl: 'https://hooks.example.com/mail',
		webhookRetry: 2,
		webhookSecret: 'test-secret',
		ruleType: settingConst.ruleType.ALL,
		ruleEmail: '',
		tgBotStatus: settingConst.tgBotStatus.CLOSE,
		forwardStatus: settingConst.forwardStatus.CLOSE
	};
	settingService.query.mockResolvedValue(settings);
	accountService.selectByEmailIncludeDel.mockResolvedValue({ userId: 1, accountId: 2 });
	userService.selectByIdIncludeDel.mockResolvedValue({ email: env.admin });
	aiService.extractCode.mockResolvedValue('123456');
	// 模拟插入后数据库返回的 ID、时间以及收件完成状态。
	emailService.receive.mockImplementation(async (c, params) => {
		storedEmail = { ...params, emailId: 42, createTime: '2026-10-23 08:00:00' };
		return storedEmail;
	});
	emailService.completeReceive.mockImplementation(async (c, status) => ({ ...storedEmail, status, isDel: 0 }));
	fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
	vi.stubGlobal('fetch', fetchMock);
	vi.spyOn(jwtUtils, 'generateToken').mockResolvedValue('test-view-token');
});

// 恢复时间、网络和方法，避免影响其他测试。
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// 验证无附件直推、保留入库的边界条件，以及其他转发行为。
describe('邮件入库与 Webhook 推送', () => {
	// 检查真实 JSON 请求体仍包含正文、验证码和接收时间。
	it('无附件且开启 Webhook 时直接推送，不执行邮件入库', async () => {
		await email(createMessage(), env, {});
		expectNoStorage();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, request] = fetchMock.mock.calls[0];
		expect(url).toBe(settings.webhookUrl);
		expect(request.method).toBe('POST');
		expect(request.headers.Authorization).toBe('test-secret');
		expect(JSON.parse(request.body)).toEqual({
			emailId: null,
			sendEmail: 'sender@example.net',
			sendName: 'Sender',
			toEmail: 'admin@example.com',
			toName: 'Admin',
			subject: 'Verification code',
			text: 'Your code is 123456\n',
			content: '',
			code: '123456',
			createTime: '2026-10-23 08:00:00'
		});
	});

	// Webhook 不可用时继续保留本地邮件。
	it.each([
		['关闭 Webhook', { webhookStatus: settingConst.webhookStatus.CLOSE }],
		['未配置地址', { webhookUrl: '' }],
		['未命中转发规则', { ruleType: settingConst.ruleType.RULE, ruleEmail: 'other@example.com' }]
	])('%s 时无附件邮件仍入库', async (name, overrides) => {
		Object.assign(settings, overrides);
		await email(createMessage(), env, {});
		expect(emailService.receive).toHaveBeenCalledTimes(1);
		expect(emailService.completeReceive).toHaveBeenCalledWith({ env }, 0, 42);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// 任意附件均保留原来的邮件和附件入库流程。
	it.each(['attachment', 'inline'])('包含 %s 附件时先入库再推送', async (disposition) => {
		await email(createMessage(disposition), env, {});
		expect(emailService.receive).toHaveBeenCalledTimes(1);
		expect(emailService.completeReceive).toHaveBeenCalledWith({ env }, 0, 42);
		expect(attService.addAtt).toHaveBeenCalledWith({ env }, [expect.objectContaining({
			emailId: 42, userId: 1, accountId: 2, filename: 'pixel.png'
		})]);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).emailId).toBe(42);
	});

	// 命中指定邮箱规则的无附件邮件同样跳过入库。
	it('命中转发规则时直接推送', async () => {
		Object.assign(settings, { ruleType: settingConst.ruleType.RULE, ruleEmail: 'other@example.com,admin@example.com' });
		await email(createMessage(), env, {});
		expectNoStorage();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	// 原有拒收策略在直推分支之前生效。
	it('黑名单邮件仍拒收，不入库也不推送', async () => {
		settings.blackFrom = 'sender@example.net';
		const message = createMessage();
		await email(message, env, {});
		expect(message.setReject).toHaveBeenCalledWith('Message rejected');
		expectNoStorage();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// 未入库邮件仍可转发，但 Telegram 不应携带无效的原文链接。
	it.each([undefined, 'attachment'])('其他转发继续工作，Telegram 查看链接按入库情况生成（附件：%s）', async (disposition) => {
		Object.assign(settings, {
			tgBotStatus: settingConst.tgBotStatus.OPEN,
			tgChatId: '123', tgBotToken: 'test-token', customDomain: 'https://mail.example.com',
			forwardStatus: settingConst.forwardStatus.OPEN, forwardEmail: 'archive@example.net'
		});
		const message = createMessage(disposition);
		await email(message, env, {});
		expect(message.forward).toHaveBeenCalledWith('archive@example.net');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const telegramBody = JSON.parse(fetchMock.mock.calls[0][1].body);
		const buttons = telegramBody.reply_markup.inline_keyboard.flat();
		expect(buttons.some(button => button.text === 'View')).toBe(!!disposition);
		expect(buttons).toContainEqual({ text: '123456', copy_text: { text: '123456' } });
		if (!disposition) {
			expectNoStorage();
			expect(jwtUtils.generateToken).not.toHaveBeenCalled();
		}
	});

	// 推送失败只执行既有重试，不回退写入数据库。
	it('无附件邮件推送失败仍不入库，并执行配置的重试次数', async () => {
		fetchMock.mockImplementation(async () => new Response('unavailable', { status: 503 }));
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		await email(createMessage(), env, {});
		expectNoStorage();
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('Webhook 推送失败'));
	});
});
