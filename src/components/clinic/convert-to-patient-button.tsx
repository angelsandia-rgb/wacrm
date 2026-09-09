'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Loader2, UserRoundPlus, UserRoundCheck } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { readResponseJson } from '@/lib/http/response-json'
import { Button } from '@/components/ui/button'

/**
 * Contactos → "Convertir en paciente". Only rendered for `clinica`
 * accounts. Shows a "Paciente" state + a link to the profile once the
 * contact already has a `patient_profiles` row.
 */
export function ConvertToPatientButton({ contactId }: { contactId: string }) {
  const t = useTranslations('Clinic.convert')
  const { account } = useAuth()
  const isClinic = (account?.industry_vertical ?? 'generic') === 'clinica'

  const [patientId, setPatientId] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isClinic || !contactId) return
    let alive = true
    fetch(`/api/patients?contact_id=${encodeURIComponent(contactId)}`)
      .then((res) => readResponseJson<{ patient: { id: string } | null }>(res))
      .then((body) => {
        if (alive) setPatientId(body?.patient?.id ?? null)
      })
      .catch(() => {})
      .finally(() => alive && setChecked(true))
    return () => {
      alive = false
    }
  }, [isClinic, contactId])

  if (!isClinic) return null

  if (patientId) {
    return (
      <Link
        href={`/patients/${patientId}`}
        className="border-border text-foreground hover:bg-muted inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[0.8rem] font-medium"
      >
        <UserRoundCheck className="size-3.5" />
        {t('view')}
      </Link>
    )
  }

  const convert = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/patients', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId }),
      })
      const body = await readResponseJson<{ patient: { id: string } }>(res)
      if (!res.ok || !body?.patient) throw new Error()
      setPatientId(body.patient.id)
      toast.success(t('done'))
    } catch {
      toast.error(t('error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={convert} disabled={busy || !checked}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <UserRoundPlus className="size-3.5" />}
      {t('button')}
    </Button>
  )
}
