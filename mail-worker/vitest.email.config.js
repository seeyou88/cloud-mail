import { defineConfig } from 'vitest/config';

// 收件流程使用 Node 环境和模拟服务测试，不依赖远程资源或 Worker 示例测试。
export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/email.spec.js']
	}
});
