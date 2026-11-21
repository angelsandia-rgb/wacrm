import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/email/send'
import { dispatchSystemAlert } from '@/lib/observability/alerts'

/** A store exception notice still unread this long goes out by email too. */
export const EMAIL_AFTER_MS = 30 * 60_000
/** Older notices are not chased by email any more (the backlog alert covers them). */
const EMAIL_WINDOW_MS = 24 * 3600_000
const APP_URL = 'https://chatsandia.com/notifications'

interface StaffJob {
  account_id: string
  event_key: string
  created_at: string
  payload: { staff?: { userIds: string[]; ids?: string[]; title: string; body: string } }
}

/** Pure: staff notices old enough to chase, and not too old. */
export function noticesToChase(jobs: StaffJob[], now: Date): StaffJob[] {
  return jobs.filter((j) => {
    const age = now.getTime() - Date.parse(j.created_at)
    return Boolean(j.payload.staff?.ids?.length) && age >= EMAIL_AFTER_MS && age <= EMAIL_WINDOW_MS && !j.event_key.endsWith(':email')
  })
}

/**
 * Store exceptions (a payment held, Dropi rejected an order, a customer
 * cancelled, a request expired…) reach the owner as in-app notices and push.
 * A notice nobody read in 30 min is emailed once to each person it was for,
 * so an owner without push on their phone is still reached. A notice read in
 * the app is never emailed. Delivery problems are alerted, never silent.
 */
export async function runNoticeEscalation(db: SupabaseClient, now: Date = new Date()): Promise<{ emailed: number; failed: number }> {
  const res = { emailed: 0, failed: 0 }
  const { data: jobs, error } = await db.from('shopify_notification_jobs').select('account_id, event_key, created_at, payload')
    .eq('status', 'sent').not('payload->staff', 'is', null)
    .gte('created_at', new Date(now.getTime() - EMAIL_WINDOW_MS).toISOString())
    .lte('created_at', new Date(now.getTime() - EMAIL_AFTER_MS).toISOString())
  if (error) throw new Error(`Cannot read store notices: ${error.message}`)

  for (const job of noticesToChase((jobs ?? []) as StaffJob[], now)) {
    const staff = job.payload.staff!
    const { data: unread, error: unreadError } = await db.from('notifications').select('user_id')
      .in('id', staff.ids!).is('read_at', null)
    if (unreadError) throw new Error(`Cannot read notices: ${unreadError.message}`)
    if (!unread?.length) continue

    // Claim before sending: one email per notice, however many cron ticks
    // or workers see it. The claim row is never sent by the job sweep.
    const { data: claimed, error: claimError } = await db.from('shopify_notification_jobs').upsert({
      account_id: job.account_id, event_key: `${job.event_key}:email`, status: 'sent',
      payload: { conversationId: '', text: '', template: null, emailOf: job.event_key },
    }, { onConflict: 'account_id,event_key', ignoreDuplicates: true }).select('event_key')
    if (claimError) throw new Error(`Cannot claim notice email: ${claimError.message}`)
    if (!claimed?.length) continue

    const { data: account } = await db.from('accounts').select('name').eq('id', job.account_id).maybeSingle()
    const store = (account?.name as string | undefined) ?? 'su tienda'
    try {
      for (const { user_id: userId } of unread) {
        const { data: user, error: userError } = await db.auth.admin.getUserById(userId as string)
        if (userError) throw userError
        if (!user.user?.email) continue
        await sendEmail({
          account: 'support', to: user.user.email,
          subject: `${store}: ${staff.title}`,
          text: `${staff.body}\n\nEste aviso lleva más de 30 minutos sin leerse en Chat Sandía. Ábralo aquí: ${APP_URL}\n\n` +
            'Para recibir estos avisos al instante en su teléfono, active las notificaciones en Chat Sandía desde ese teléfono.',
        })
        res.emailed++
      }
    } catch (err) {
      res.failed++
      const message = err instanceof Error ? err.message : String(err)
      await db.from('shopify_notification_jobs').update({ status: 'skipped', last_error: `Email failed: ${message}`.slice(0, 500) })
        .eq('account_id', job.account_id).eq('event_key', `${job.event_key}:email`)
      await dispatchSystemAlert({
        severity: 'warning', source: 'store_notice_email', accountId: job.account_id,
        dedupKey: `store_notice_email:${job.account_id}`, throttleMinutes: 6 * 60,
        title: 'No se pudo enviar por correo un aviso de la tienda que nadie ha leído',
        detail: { notice: staff.title, event_key: job.event_key, error: message },
      })
    }
  }
  return res
}
