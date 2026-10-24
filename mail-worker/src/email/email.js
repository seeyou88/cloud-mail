import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';
import aiService from '../service/ai-service';
import webhookService from '../service/webhook-service';

// 直接解析MIME字节流，避免重复转码及分块截断中文；无附件邮件仅在Webhook成功时跳过入库。
export async function email(message, env, ctx) {

	try {

		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			webhookStatus,
			webhookUrl,
			webhookRetry,
			webhookSecret,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient,
			blackSubject,
			blackContent,
			blackFrom,
			aiCode,
			aiCodeFilter
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			message.setReject('Service suspended');
			return;
		}

		const email = await PostalMime.parse(message.raw);


		const blockFlag = checkBlock(blackSubject, blackContent, blackFrom, email);

		if (blockFlag) {
			message.setReject('Message rejected');
			return;
		}

		let account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

		if (!account) {
			const baseEmail = emailUtils.getBaseEmail(message.to);
			if (baseEmail && baseEmail !== message.to) {
				account = await accountService.selectByEmailIncludeDel({ env: env }, baseEmail);
			}
		}

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			message.setReject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			 userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {

			let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				message.setReject('The recipient is not authorized to use this domain.');
				return;
			}

			if(roleService.isBanEmail(banEmail, email.from.address)) {
				message.setReject('The recipient is disabled from receiving emails.');
				return;
			}

		}


		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';
		const code = await aiService.extractCode({ env }, email, { aiCode, aiCodeFilter });

		const params = {
			toEmail: message.to,
			toName: toName,
			sendEmail: email.from.address,
			name: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject,
			code,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		const webhookEnabled = webhookStatus === settingConst.webhookStatus.OPEN && !!webhookUrl;
		const matchesForwardRule = ruleType !== settingConst.ruleType.RULE || ruleEmail.split(',').includes(message.to);
		const preferWebhook = attachments.length === 0 && webhookEnabled && matchesForwardRule;
		let webhookDelivered = false;
		let emailRow;

		if (preferWebhook) {
			// 先确认无附件邮件已推送成功，再决定是否跳过入库。
			emailRow = {
				...params,
				emailId: null,
				content: params.content || '',
				createTime: new Date().toISOString().slice(0, 19).replace('T', ' ')
			};
			webhookDelivered = await webhookService.sendEmail({ env }, emailRow, webhookUrl, webhookRetry, webhookSecret);
			if (webhookDelivered) {
				console.info('Webhook 推送成功，邮件未入库');
			}
		}

		if (!webhookDelivered) {
			emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

			attachments.forEach(attachment => {
				attachment.emailId = emailRow.emailId;
				attachment.userId = emailRow.userId;
				attachment.accountId = emailRow.accountId;
			});

			try {
				if (attachments.length > 0) {
					await attService.addAtt({ env }, attachments);
				}
			} catch (e) {
				console.error(e);
			}

			emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);
			if (preferWebhook) {
				console.warn(`Webhook 推送失败，邮件已回退入库 emailId: ${emailRow.emailId}`);
			}
		}

		if (!matchesForwardRule) {
			return;
		}

		//转发到TG
		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			try {
				await telegramService.sendEmailToBot({ env }, emailRow)
			} catch (e) {
				console.error('转发 Telegram 异常: ', e);
			}
		}

		//转发到其他邮箱
		if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

			const emails = forwardEmail.split(',');

			await Promise.all(emails.map(async email => {

				try {
					await message.forward(email);
				} catch (e) {
					console.error(`转发邮箱 ${email} 失败：`, e);
				}

			}));

		}

		//转发到 Webhook
		if (webhookEnabled && !preferWebhook) {
			await webhookService.sendEmail({ env }, emailRow, webhookUrl, webhookRetry, webhookSecret);
		}

	} catch (e) {
		console.error(`邮件接收异常: ${e.message}`, e.stack);
		throw e
	}
}

function checkBlock(blackSubjectStr, blackContentStr, blackFromStr, email) {

	const blackFromList = blackFromStr ? blackFromStr.split(',') : []
	const blackContentList = blackContentStr ? blackContentStr.split(',') : []
	const blackSubjectList = blackSubjectStr ? blackSubjectStr.split(',') : []

	for (const blackSubject of blackSubjectList) {
		if (email.subject?.includes(blackSubject)) {
			return true
		}
	}

	for (const blackContent of blackContentList) {
		if (email.html?.includes(blackContent) || email.text?.includes(blackContent)) {
			return true
		}
	}

	for (const blackFrom of blackFromList) {
		if (email.from.address === blackFrom || emailUtils.getDomain(email.from.address) === blackFrom) {
			return true
		}
	}

	return false

}
