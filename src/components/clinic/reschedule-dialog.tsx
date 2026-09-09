'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { readResponseJson } from '@/lib/http/response-json'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { localMidnightUTC } from '@/lib/clinic/time-range'

export interface RescheduleTarget {
  id: string
  doctor_id: string
  service_id: string | null
  scheduled_at: string
  ends_at: string
}

export function RescheduleDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: RescheduleTarget | null
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const t = useTranslations('Clinic.appt')
  const { account } = useAuth()
  const tz = account?.timezone || 'UTC'

  const [date, setDate] = useState('')
  const [slots, setSlots] = useState<{ start: string; end: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [slot, setSlot] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDate('')
    setSlots([])
    setSlot('')
    setReason('')
  }, [target])

  useEffect(() => {
    if (!target || !date) {
      setSlots([])
      return
    }
    let alive = true
    setLoading(true)
    setSlot('')
    const [y, m, d] = date.split('-').map(Number)
    const from = localMidnightUTC(y, m, d, tz).toISOString()
    const to = localMidnightUTC(y, m, d + 1, tz).toISOString()
    const durMin = Math.round(
      (new Date(target.ends_at).getTime() - new Date(target.scheduled_at).getTime()) / 60_000,
    )
    const params = new URLSearchParams({ doctor_id: target.doctor_id, from, to, duration: String(durMin) })
    if (target.service_id) params.set('service_id', target.service_id)
    fetch(`/api/appointments/slots?${params.toString()}`)
      .then((r) => readResponseJson<{ slots: { start: string; end: string }[] }>(r))
      .then((b) => alive && setSlots(b.slots ?? []))
      .catch(() => alive && setSlots([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [target, date, tz])

  const fmt = useMemo(
    () => new Intl.DateTimeFormat('es-GT', { hour: '2-digit', minute: '2-digit', timeZone: tz }),
    [tz],
  )
  const currentFmt = useMemo(
    () =>
      new Intl.DateTimeFormat('es-GT', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: tz,
      }),
    [tz],
  )

  const submit = async () => {
    if (!target || !slot) return
    setSaving(true)
    try {
      const res = await fetch(`/api/appointments/${target.id}/reschedule`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scheduled_at: slot, reason: reason.trim() || null }),
      })
      const body = await readResponseJson<{ error?: string }>(res)
      if (!res.ok) throw new Error(body.error)
      toast.success(t('rescheduled'))
      onOpenChange(false)
      onDone()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('rescheduleError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('rescheduleTitle')}</DialogTitle>
        </DialogHeader>
        {target && (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">
              {t('current')}: {currentFmt.format(new Date(target.scheduled_at))}
            </p>
            <div>
              <span className="text-muted-foreground mb-1 block text-xs">{t('newDate')}</span>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            {date && (
              <div>
                <span className="text-muted-foreground mb-1 block text-xs">{t('slot')}</span>
                {loading ? (
                  <div className="bg-muted/40 h-10 animate-pulse rounded" />
                ) : slots.length === 0 ? (
                  <p className="text-muted-foreground text-xs">{t('noSlots')}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {slots.map((s) => (
                      <button
                        key={s.start}
                        type="button"
                        onClick={() => setSlot(s.start)}
                        className={cn(
                          'rounded-md border px-2 py-1 text-xs',
                          slot === s.start
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border text-foreground hover:bg-muted',
                        )}
                      >
                        {fmt.format(new Date(s.start))}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <label className="block">
              <span className="text-muted-foreground mb-1 block text-xs">{t('reason')}</span>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('reasonOptional')} />
            </label>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={!slot || saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('rescheduleConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
