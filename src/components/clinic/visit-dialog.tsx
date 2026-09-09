'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { readResponseJson } from '@/lib/http/response-json'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Doctor {
  id: string
  display_name: string
  is_active: boolean
}
interface Service {
  id: string
  name: string
  price: number
  is_active: boolean
}
interface NoteTemplate {
  id: string
  name: string
  body: string
}

export interface VisitDraft {
  id?: string
  patient_id: string
  appointment_id?: string | null
  doctor_id?: string | null
  service_id?: string | null
  visit_date?: string
  amount?: number | string | null
  notes?: string | null
  observations?: string | null
  follow_up_date?: string | null
}

export function VisitDialog({
  draft,
  onOpenChange,
  onSaved,
}: {
  /** null = closed. An object with an `id` = edit; without = create. */
  draft: VisitDraft | null
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const t = useTranslations('Clinic.visit')
  const { account } = useAuth()
  const tz = account?.timezone || undefined
  const isEdit = Boolean(draft?.id)

  const [doctors, setDoctors] = useState<Doctor[]>([])
  const [services, setServices] = useState<Service[]>([])
  const [templates, setTemplates] = useState<NoteTemplate[]>([])

  const [doctorId, setDoctorId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [date, setDate] = useState('')
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [observations, setObservations] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [saving, setSaving] = useState(false)

  const todayLocal = useMemo(() => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    } catch {
      return new Date().toISOString().slice(0, 10)
    }
  }, [tz])

  useEffect(() => {
    if (!draft) return
    setDoctorId(draft.doctor_id ?? '')
    setServiceId(draft.service_id ?? '')
    setDate(draft.visit_date ?? todayLocal)
    setAmount(draft.amount != null ? String(draft.amount) : '')
    setNotes(draft.notes ?? '')
    setObservations(draft.observations ?? '')
    setFollowUp(draft.follow_up_date ?? '')
    Promise.all([
      fetch('/api/doctors').then((r) => readResponseJson<{ doctors: Doctor[] }>(r)),
      fetch('/api/products').then((r) => readResponseJson<{ products: Service[] }>(r)),
      fetch('/api/note-templates').then((r) => readResponseJson<{ templates: NoteTemplate[] }>(r)),
    ])
      .then(([d, p, tpl]) => {
        setDoctors((d.doctors ?? []).filter((x) => x.is_active))
        setServices((p.products ?? []).filter((x) => x.is_active))
        setTemplates(tpl.templates ?? [])
      })
      .catch(() => {})
  }, [draft, todayLocal])

  // prefill amount from the picked service on create
  useEffect(() => {
    if (isEdit || !serviceId) return
    const svc = services.find((s) => s.id === serviceId)
    if (svc && amount.trim() === '') setAmount(String(svc.price ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, services])

  const insertTemplate = (id: string) => {
    const tpl = templates.find((x) => x.id === id)
    if (!tpl) return
    setNotes((cur) => (cur.trim() ? `${cur}\n\n${tpl.body}` : tpl.body))
  }

  const submit = async () => {
    if (!draft || !date) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        doctor_id: doctorId || null,
        service_id: serviceId || null,
        visit_date: date,
        amount: amount.trim() === '' ? null : Number(amount),
        notes: notes.trim() || null,
        observations: observations.trim() || null,
        follow_up_date: followUp || null,
      }
      let res: Response
      if (isEdit) {
        res = await fetch(`/api/visits/${draft.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        res = await fetch('/api/visits', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, patient_id: draft.patient_id, appointment_id: draft.appointment_id ?? null }),
        })
      }
      const data = await readResponseJson<{ error?: string }>(res)
      if (!res.ok) throw new Error(data.error)
      toast.success(isEdit ? t('saved') : t('created'))
      onOpenChange(false)
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={!!draft} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? t('editTitle') : t('newTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-muted-foreground mb-1 block text-xs">{t('doctor')}</span>
              <select
                value={doctorId}
                onChange={(e) => setDoctorId(e.target.value)}
                className="border-border bg-background h-8 w-full rounded-md border px-2 text-sm"
              >
                <option value="">—</option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-muted-foreground mb-1 block text-xs">{t('service')}</span>
              <select
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
                className="border-border bg-background h-8 w-full rounded-md border px-2 text-sm"
              >
                <option value="">—</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-muted-foreground text-xs">{t('date')}</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label className="text-muted-foreground text-xs">{t('amount')}</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>

          <label className="block">
            <span className="text-muted-foreground mb-1 flex items-center justify-between text-xs">
              {t('notes')}
              {templates.length > 0 && (
                <select
                  onChange={(e) => {
                    if (e.target.value) insertTemplate(e.target.value)
                    e.target.value = ''
                  }}
                  className="border-border bg-background h-6 rounded border px-1 text-[11px]"
                  defaultValue=""
                >
                  <option value="">{t('insertTemplate')}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </select>
              )}
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={5}
              className="border-border bg-background w-full rounded-md border px-2 py-1 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-muted-foreground mb-1 block text-xs">{t('observations')}</span>
            <textarea
              value={observations}
              onChange={(e) => setObservations(e.target.value)}
              rows={2}
              className="border-border bg-background w-full rounded-md border px-2 py-1 text-sm"
            />
          </label>

          <div>
            <Label className="text-muted-foreground text-xs">{t('followUp')}</Label>
            <Input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} className="mt-1 max-w-[200px]" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={saving || !date}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
