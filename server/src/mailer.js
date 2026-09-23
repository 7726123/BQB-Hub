// 邮件发送（nodemailer，配置取自 config.smtp；未配置时抛 SMTP_NOT_CONFIGURED）
const nodemailer = require('nodemailer');
const config = require('./config');

let _mailer = null;
function getMailer() {
  if (!config.smtp.user || !config.smtp.pass) return null;
  if (!_mailer) {
    _mailer = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: !!config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass }
    });
  }
  return _mailer;
}

async function sendMail(to, subject, text) {
  const m = getMailer();
  if (!m) throw new Error('SMTP_NOT_CONFIGURED');
  await m.sendMail({ from: config.smtp.from || config.smtp.user, to, subject, text });
}

module.exports = { sendMail };