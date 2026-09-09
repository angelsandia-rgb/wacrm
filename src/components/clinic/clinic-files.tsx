'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Loader2, Upload, FileText, Download, Trash2 } from 'lucide-react'
import { readResponseJson } from '@/lib/http/response-json'
import { uploadAccountMedia, deleteAccountMedia } from '@/lib/storage/upload-media'
import { Button } from '@/components/ui/button'

interface ClinicFile {
  id: string
  filename: string
  mime_type: string | null
  size_bytes: number | null
  created_at: string
}

const MAX_BYTES = 15 * 1024 * 1024
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx'

function humanSize(n: number | null): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Patient / visit file attachments. Private bucket — downloads use a
 *  short-lived signed URL from the server. */
export function ClinicFiles({
  patientId,
  visitId,
  canEdit,
}: {
  patientId?: string
  visitId?: string
  canEdit: boolean
}) {
  const t = useTranslations('Clinic.files')
  const [files, setFiles] = useState<ClinicFile[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (visitId) params.set('visit_id', visitId)
      else if (patientId) params.set('patient_id', patientId)
      const res = await fetch(`/api/clinic-files?${params.toString()}`)
      const body = await readResponseJson<{ files: ClinicFile[] }>(res)
      setFiles(res.ok ? body.files ?? [] : [])
    } catch {
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [patientId, visitId])

  useEffect(() => {
    void load()
  }, [load])

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > MAX_BYTES) {
      toast.error(t('tooBig'))
      return
    }
    setUploading(true)
    let path = ''
    try {
      const up = await uploadAccountMedia('clinic-files', file)
      path = up.path
      const res = await fetch('/api/clinic-files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          patient_id: patientId ?? null,
          visit_id: visitId ?? null,
          storage_path: path,
          filename: file.name,
          mime_type: file.type || null,
          size_bytes: file.size,
        }),
      })
      const body = await readResponseJson<{ error?: string }>(res)
      if (!res.ok) throw new Error(body.error)
      await load()
    } catch (err) {
      if (path) void deleteAccountMedia('clinic-files', path).catch(() => {})
      toast.error(err instanceof Error && err.message ? err.message : t('uploadError'))
    } finally {
      setUploading(false)
    }
  }

  const download = async (id: string) => {
    try {
      const res = await fetch(`/api/clinic-files/${id}/download`)
      const body = await readResponseJson<{ url?: string; error?: string }>(res)
      if (!res.ok || !body.url) throw new Error(body.error)
      window.open(body.url, '_blank', 'noopener,noreferrer')
    } catch {
      toast.error(t('downloadError'))
    }
  }

  const remove = async (id: string) => {
    const res = await fetch(`/api/clinic-files/${id}`, { method: 'DELETE' })
    if (res.ok) await load()
    else toast.error(t('deleteError'))
  }

  return (
    <div className="space-y-3">
      {canEdit && (
        <>
          <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" onChange={onPick} />
          <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {t('upload')}
          </Button>
        </>
      )}

      {loading ? (
        <div className="bg-muted/40 h-16 animate-pulse rounded" />
      ) : files.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="border-border divide-border divide-y rounded-lg border">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <FileText className="text-muted-foreground size-4 shrink-0" />
              <span className="text-foreground min-w-0 flex-1 truncate">{f.filename}</span>
              <span className="text-muted-foreground shrink-0 text-xs">{humanSize(f.size_bytes)}</span>
              <button
                type="button"
                onClick={() => download(f.id)}
                className="text-muted-foreground hover:text-foreground shrink-0"
                title={t('download')}
              >
                <Download className="size-4" />
              </button>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => remove(f.id)}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                  title={t('delete')}
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
