import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import orm from '../src/entity/orm';
import emailService from '../src/service/email-service';

// 隔离 D1，检查收件服务实际提交的入库内容。
vi.mock('../src/entity/orm', () => ({ default: vi.fn() }));

// 图片处理路径一旦尝试解析 HTML 就立即报错，防止退回完整 DOM 处理。
vi.mock('linkedom', async () => {
	const actual = await vi.importActual('linkedom');
	return {
		...actual,
		// 禁止本测试覆盖的收件入库流程构建 DOM。
		parseHTML: vi.fn(() => { throw new Error('收件图片处理不应解析 HTML'); })
	};
});

let insertValues;

// 模拟 D1 插入返回值，同时保留参数，验证 HTML 和其他邮件字段都被完整保存。
beforeEach(() => {
	vi.clearAllMocks();
	// 模拟 Drizzle 插入链，不连接本地或线上数据库。
	insertValues = vi.fn(params => ({ returning: () => ({ get: async () => ({ ...params, emailId: 42 }) }) }));
	orm.mockReturnValue({ insert: vi.fn(() => ({ values: insertValues })) });
});

// 覆盖三类图片及混合正文，验证入库内容保真且不依赖 HTML 解析。
describe('邮件原始 HTML 入库', () => {
	// 三类图片单独或共同出现时都应保存原文，附件引用及类型保持原状。
	it.each([
		'<img src="https://external.example/logo.png">',
		'<img src="cid:logo">',
		'<img src="https://assets.example/attachments/logo.png">',
		'<p>行程信息</p><img src="cid:logo"><img src="https://assets.example/a.png"><img src="https://external.example/a.png">'
	])('原样保存图片正文：%s', async content => {
		const attachments = [{ filename: 'logo.png', contentId: '<logo>', key: 'attachments/logo.png', type: 0 }];
		const params = { subject: 'Travel itinerary', content, text: '行程信息', userId: 1, accountId: 2 };
		const result = await emailService.receive({}, params, attachments, 'https://assets.example');
		expect(insertValues).toHaveBeenCalledWith(params);
		expect(result).toEqual({ ...params, emailId: 42 });
		expect(result.content).toBe(content);
		expect(attachments[0].type).toBe(0);
		expect(parseHTML).not.toHaveBeenCalled();
	});

	// 纯文本邮件没有 HTML 正文时仍沿用空字符串入库，避免引入空值变化。
	it('没有 HTML 时仍保存纯文本邮件', async () => {
		const result = await emailService.receive({}, { subject: 'Notice', text: '正文' }, [], null);
		expect(result.content).toBe('');
		expect(result.text).toBe('正文');
		expect(parseHTML).not.toHaveBeenCalled();
	});
});
