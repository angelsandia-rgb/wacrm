'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { IconArrowLeft, IconBrandWhatsapp } from '@tabler/icons-react'
import { useAuth } from '@/hooks/use-auth'
import { useCan } from '@/hooks/use-can'
import { readResponseJson } from '@/lib/http/response-json'
import { formatCurrency } from '@/lib/currency'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  APPOINTMENT_STATUS_LABEL_ES,
  APPOINTMENT_STATUS_TONE,
  type StatusTone,
} from '@/lib/clinic/appointment-status'
import { PATIENT_SOURCES } from '@/lib/clinic/types'
import { VisitDialog, type VisitDraft } from '@/components/clinic/visit-dialog'
import { ClinicFiles } from '@/components/clinic/clinic-files'

interface ProfileResponse {
  patient: {
    id: string
    source: string | null
    created_at: string
    contacts: {
      id: string
      name: string | null
      phone: string | null
      email: string | null
      created_at: string
    } | null
  }
  aggregate: {
    last_visit_date: string | null
    next_appointment_at: string | null
    visit_count: number
    total_value: number
    follow_up_due: boolean
  }
  visits: Array<{
    id: string
    visit_date: string
    amount: number | string | null
    notes: string | null
    observations: string | null
    follow_up_date: string | null
    doctor_id: string | null
    service_id: string | null
    created_at: string
  }>
  appointments: Array<{
    id: string
    scheduled_at: string
    ends_at: string
    status: keyof typeof APPOINTMENT_STATUS_LABEL_ES
    amount: number | string | null
  }>
}

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'border-border text-muted-foreground',
  positive: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  negative: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  info: 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400',
}

export default function PatientProfilePage() {
  const t = useTranslations('Clinic.profile')
  const params = useParams<{ id: string }>()
  const id = params?.id
  const { account } = useAuth()
  const canWrite = useCan('send-messages')
  const currency = account?.default_currency || 'GTQ'
  const tz = account?.timezone || undefined

  const [data, setData] = useState<ProfileResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [visitDraft, setVisitDraft] = useState<VisitDraft | null>(null)

  const load = useCallback(async (patientId: string, alive: () => boolean) => {
    setLoading(true)
    setNotFound(false)
    try {
      const res = await fetch(`/api/patients/${patientId}`)
      const body = await readResponseJson<ProfileResponse>(res)
      if (!alive()) return
      if (res.ok) setData(body)
      else setNotFound(true)
    } catch {
      if (alive()) setNotFound(true)
    } finally {
      if (alive()) setLoading(false)
    }
  }, [])

  const reload = useCallback(() => {
    if (id) void load(id, () => true)
  }, [id, load])

  useEffect(() => {
    if (!id) return
    let on = true
    void load(id, () => on)
    return () => {
      on = false
    }
  }, [id, load])

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat('es-GT', { day: '2-digit', month: 'long', year: 'numeric', timeZone: tz }),
    [tz],
  )
  const dateTimeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat('es-GT', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: tz,
      }),
    [tz],
  )
  const day = (d: string) => dateFmt.format(new Date(`${d}T12:00:00`))

  if (loading) {
    return <div className="bg-muted/40 h-96 animate-pulse rounded-lg" />
  }
  if (notFound || !data) {
    return (
      <div className="space-y-4">
        <BackLink label={t('back')} />
        <p className="text-muted-foreground text-sm">{t('notFound')}</p>
      </div>
    )
  }

  const c = data.patient.contacts
  const agg = data.aggregate

  return (
    <div className="space-y-5">
      <BackLink label={t('back')} />

      {/* Header */}
      <div className="border-border bg-card rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-foreground text-lg font-semibold">{c?.name || '—'}</h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {c?.phone || '—'}
              {c?.email ? ` · ${c.email}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {c?.id && (
              <Link
                href={`/contacts/${c.id}`}
                className="border-border text-foreground hover:bg-muted inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm"
              >
                <IconBrandWhatsapp className="h-4 w-4" />
                {t('actionWhatsapp')}
              </Link>
            )}
            <Link
              href={`/appointments?patient=${data.patient.id}`}
              className="border-border text-foreground hover:bg-muted inline-flex h-8 items-center rounded-md border px-2.5 text-sm"
            >
              {t('actionNewAppt')}
            </Link>
            {canWrite && (
              <button
                type="button"
                onClick={() => setVisitDraft({ patient_id: data.patient.id })}
                className="border-border text-foreground hover:bg-muted inline-flex h-8 items-center rounded-md border px-2.5 text-sm"
              >
                {t('actionAddVisit')}
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t('lastVisit')} value={agg.last_visit_date ? day(agg.last_visit_date) : '—'} />
          <Stat
            label={t('nextAppt')}
            value={agg.next_appointment_at ? dateTimeFmt.format(new Date(agg.next_appointment_at)) : '—'}
            highlight={agg.follow_up_due}
          />
          <Stat label={t('totalVisits')} value={String(agg.visit_count)} />
          <Stat
            label={t('lifetimeValue')}
            value={agg.total_value > 0 ? formatCurrency(agg.total_value, currency) : '—'}
          />
        </div>
      </div>

      <Tabs defaultValue="summary">
        <TabsList>
          <TabsTrigger value="summary">{t('tabSummary')}</TabsTrigger>
          <TabsTrigger value="appointments">{t('tabAppointments')}</TabsTrigger>
          <TabsTrigger value="visits">{t('tabVisits')}</TabsTrigger>
          <TabsTrigger value="files">{t('tabFiles')}</TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="pt-4">
          <div className="border-border bg-card space-y-2 rounded-lg border p-4 text-sm">
            <h2 className="text-foreground mb-2 font-medium">{t('contactInfo')}</h2>
            <Row label={t('phone')} value={c?.phone || '—'} />
            <Row label={t('email')} value={c?.email || '—'} />
            <Row
              label={t('source')}
              value={
                data.patient.source && (PATIENT_SOURCES as readonly string[]).includes(data.patient.source)
                  ? data.patient.source
                  : '—'
              }
            />
            <Row label={t('patientSince')} value={day(data.patient.created_at.slice(0, 10))} />
          </div>
        </TabsContent>

        <TabsContent value="appointments" className="pt-4">
          {data.appointments.length === 0 ? (
            <EmptyState text={t('noAppts')} />
          ) : (
            <ul className="border-border divide-border divide-y rounded-lg border">
              {data.appointments.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="text-foreground">{dateTimeFmt.format(new Date(a.scheduled_at))}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASS[APPOINTMENT_STATUS_TONE[a.status]]}`}
                  >
                    {APPOINTMENT_STATUS_LABEL_ES[a.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="visits" className="pt-4">
          {data.visits.length === 0 ? (
            <EmptyState text={t('noVisits')} />
          ) : (
            <ol className="space-y-3">
              {data.visits.map((v) => (
                <li key={v.id} className="border-border bg-card rounded-lg border p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-foreground text-sm font-medium">{day(v.visit_date)}</span>
                    <span className="flex items-center gap-3">
                      {v.amount != null && Number(v.amount) > 0 && (
                        <span className="text-muted-foreground text-sm tabular-nums">
                          {t('visitAmount')}: {formatCurrency(Number(v.amount), currency)}
                        </span>
                      )}
                      {canWrite && (
                        <button
                          type="button"
                          onClick={() =>
                            setVisitDraft({
                              id: v.id,
                              patient_id: data.patient.id,
                              doctor_id: v.doctor_id,
                              service_id: v.service_id,
                              visit_date: v.visit_date,
                              amount: v.amount,
                              notes: v.notes,
                              observations: v.observations,
                              follow_up_date: v.follow_up_date,
                            })
                          }
                          className="text-primary text-xs hover:underline"
                        >
                          {t('edit')}
                        </button>
                      )}
                    </span>
                  </div>
                  {v.notes && <p className="text-foreground mt-2 whitespace-pre-wrap text-sm">{v.notes}</p>}
                  {v.observations && (
                    <p className="text-muted-foreground mt-1 whitespace-pre-wrap text-sm">{v.observations}</p>
                  )}
                  {v.follow_up_date && (
                    <p className="text-muted-foreground mt-2 text-xs">
                      {t('visitFollowUp')}: {day(v.follow_up_date)}
                    </p>
                  )}
                  <div className="mt-3">
                    <ClinicFiles visitId={v.id} canEdit={canWrite} />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </TabsContent>

        <TabsContent value="files" className="pt-4">
          <ClinicFiles patientId={data.patient.id} canEdit={canWrite} />
        </TabsContent>
      </Tabs>

      <VisitDialog
        draft={visitDraft}
        onOpenChange={(v) => !v && setVisitDraft(null)}
        onSaved={reload}
      />
    </div>
  )
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      href="/patients"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
    >
      <IconArrowLeft className="h-4 w-4" />
      {label}
    </Link>
  )
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="border-border rounded-md border p-2.5">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold ${highlight ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>
        {value}
      </p>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground text-right">{value}</span>
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="border-border text-muted-foreground rounded-lg border border-dashed py-12 text-center text-sm">
      {text}
    </div>
  )
}
