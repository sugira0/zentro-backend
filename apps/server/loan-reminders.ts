// @ts-nocheck
import { sendEmail } from './email.ts'

const money = (n: any) => Math.round(Number(n) || 0).toLocaleString()
const REMINDER_COOLDOWN_DAYS = 7
const OVERDUE_THRESHOLD_DAYS = 30

export async function initializeLoanReminders(db: any): Promise<void> {
  // Columns already present in schema.sql (borrower_email, last_reminder_sent_at)
}

function emailBody(business: any, loan: any, daysOverdue: number, balance: number) {
  const subject = `Payment reminder: your ${business.name} account is ${daysOverdue} days overdue`
  const text = `Hello ${loan.borrower_name},\n\nOur records show your account with ${business.name} has an outstanding balance of RWF ${money(balance)}, which was due on ${loan.due_date} — ${daysOverdue} days ago.\n\nPlease arrange payment as soon as possible. If you have already paid, kindly disregard this message.\n\nThank you,\n${business.name}`
  const html = `<p>Hello ${loan.borrower_name},</p><p>Our records show your account with <b>${business.name}</b> has an outstanding balance of <b>RWF ${money(balance)}</b>, which was due on <b>${loan.due_date}</b> — <b>${daysOverdue} days ago</b>.</p><p>Please arrange payment as soon as possible. If you have already paid, kindly disregard this message.</p><p>Thank you,<br/>${business.name}</p>`
  return { subject, text, html }
}

export async function sendOverdueLoanReminders(db: any): Promise<number> {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - OVERDUE_THRESHOLD_DAYS)
  const resend = new Date(); resend.setDate(resend.getDate() - REMINDER_COOLDOWN_DAYS)
  const due = await db.prepare(`
    SELECT l.*,b.name AS business_name FROM loans l JOIN businesses b ON b.id=l.business_id
    WHERE l.borrower_type='CUSTOMER' AND l.amount_paid<l.principal
      AND l.due_date<$1 AND l.borrower_email IS NOT NULL AND l.borrower_email<>''
      AND (l.last_reminder_sent_at IS NULL OR l.last_reminder_sent_at<$2)
  `).all(cutoff.toISOString().slice(0, 10), resend.toISOString())
  let sent = 0
  for (const loan of due) {
    const daysOverdue = Math.floor((Date.now() - new Date(loan.due_date).getTime()) / 86400000)
    const balance = loan.principal - loan.amount_paid
    const { subject, text, html } = emailBody({ name: loan.business_name }, loan, daysOverdue, balance)
    const result = await sendEmail({ to: loan.borrower_email, subject, text, html })
    if (result.sent) { await db.prepare('UPDATE loans SET last_reminder_sent_at=NOW() WHERE id=?').run(loan.id); sent++ }
  }
  return sent
}

let reminderScheduler = false
export function startLoanReminderScheduler(db: any): void {
  if (reminderScheduler) return
  reminderScheduler = true
  const run = () => sendOverdueLoanReminders(db).catch(err => console.error('Loan reminder sweep failed', err))
  run()
  setInterval(run, 6 * 60 * 60000)
}
