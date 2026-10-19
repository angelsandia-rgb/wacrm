'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { UserRoundCheck, CalendarPlus } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { readResponseJson } from '@/lib/http/response-json'
import { ConvertToPatientButton } from './convert-to-patient-button'

interface Agg {
  last_visit_date: string | null
  next_appointment_at: string | null
  visit_count: number
}

/**
 * Discreet patient context inside the inbox conversation panel (spec
 * §13). Only for `clinica` accounts and only when the contact already
 * has a patient profile; otherwise it offers "Convertir en paciente".
 * Deliberately shows just last visit / next appointment — no clinical
 * history in the inbox.
 */
export function InboxPatientCard({ contactId }: { contactId: string }) {
  const t = useTranslations('Clinic.inbox')
  const { account } = useAuth()
  const tz = account?.timezone || undefined
  const isClinic = (account?.industry_vertical ?? 'generic') === 'clinica'

  // Tagged with the contact it answers, so switching contacts reads as
  // "not checked yet" until that contact's lookup lands.
  const [result, setResult] = useState<{
    contactId: string
    patientId: string | null
    agg: Agg | null
  } | null>(null)

  useEffect(() => {
    if (!isClinic || !contactId) return
    let on = true
    void (async () => {
      let patientId: string | null = null
      let agg: Agg | null = null
      try {
        const res = await fetch(`/api/patients?contact_id=${encodeURIComponent(contactId)}`)
        const b = await readResponseJson<{ patient: { id: string } | null }>(res)
        if (!on) return
        patientId = b?.patient?.id ?? null
        if (patientId) {
          const pr = await fetch(`/api/patients/${patientId}`)
          const p = await readResponseJson<{ aggregate: Agg }>(pr)
          agg = p?.aggregate ?? null
        }
      } catch {
        /* leave empty */
      } finally {
        if (on) setResult({ contactId, patientId, agg })
      }
    })()
    return () => {
      on = false
    }
  }, [isClinic, contactId])

  const checked = result?.contactId === contactId
  const patientId = checked ? result.patientId : null
  const agg = checked ? result.agg : null

  if (!isClinic || !checked) return null

  const dateFmt = new Intl.DateTimeFormat('es-GT', { day: '2-digit', month: 'short', timeZone: tz })
  const dtFmt = new Intl.DateTimeFormat('es-GT', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  })

  if (!patientId) {
    return (
      <div className="border-border mt-3 flex justify-center rounded-lg border border-dashed p-2">
        <ConvertToPatientButton contactId={contactId} />
      </div>
    )
  }

  return (
    <div className="border-border bg-muted/40 mt-3 space-y-1.5 rounded-lg border p-3 text-left text-xs">
      <div className="text-foreground flex items-center gap-1.5 font-medium">
        <UserRoundCheck className="size-3.5" />
        {t('patient')}
      </div>
      <div className="text-muted-foreground flex justify-between">
        <span>{t('lastVisit')}</span>
        <span className="text-foreground">
          {agg?.last_visit_date ? dateFmt.format(new Date(`${agg.last_visit_date}T12:00:00`)) : '—'}
        </span>
      </div>
      <div className="text-muted-foreground flex justify-between">
        <span>{t('nextAppt')}</span>
        <span className="text-foreground">
          {agg?.next_appointment_at ? dtFmt.format(new Date(agg.next_appointment_at)) : '—'}
        </span>
      </div>
      <div className="flex gap-2 pt-1">
        <Link
          href={`/patients/${patientId}`}
          className="border-border text-foreground hover:bg-muted inline-flex h-6 flex-1 items-center justify-center gap-1 rounded border text-[11px] font-medium"
        >
          {t('viewPatient')}
        </Link>
        <Link
          href={`/appointments?patient=${patientId}`}
          className="border-border text-foreground hover:bg-muted inline-flex h-6 flex-1 items-center justify-center gap-1 rounded border text-[11px] font-medium"
        >
          <CalendarPlus className="size-3" />
          {t('newAppt')}
        </Link>
      </div>
    </div>
  )
}
