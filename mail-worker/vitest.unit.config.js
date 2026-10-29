import { defineConfig } from 'vitest/config';

// 在 Node 环境验证收件和登录鉴权流程，不连接线上 Cloudflare 资源。
export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/email.spec.js', 'test/security.spec.js', 'test/email-content.spec.js']
	}
});
