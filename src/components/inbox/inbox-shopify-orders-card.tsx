'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, Plus, ShoppingBag, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { useCan } from '@/hooks/use-can'
import { readResponseJson } from '@/lib/http/response-json'
import { formatCurrency } from '@/lib/currency'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface OrderStatus {
  name: string
  cancelledAt: string | null
  displayFinancialStatus: string | null
  displayFulfillmentStatus: string
  fulfillments: { displayStatus: string | null; trackingInfo: { company: string | null; number: string | null; url: string | null }[] }[]
}
interface ContactOrder {
  shopifyId: string
  title: string
  total: number
  awaitingPayment: boolean
  status: OrderStatus | null
}
interface ProductOption { name: string; price: number }

const selectClass = 'border-input bg-background h-8 w-full rounded-lg border px-2 text-sm'

/**
 * The contact's Shopify orders (payment, preparation, Dropi tracking) and a
 * "Crear pedido" form — the same order path the AI uses, so the customer gets
 * the WhatsApp confirmation with their order number either way. Renders only
 * when the account has a Shopify store connected.
 */
export function InboxShopifyOrdersCard({
  conversationId, contactName, contactPhone,
}: { conversationId: string | null; contactName: string; contactPhone: string | null }) {
  const t = useTranslations('ShopifyOrders')
  const { defaultCurrency } = useAuth()
  const canAct = useCan('send-messages')
  const [result, setResult] = useState<{ conversationId: string; connected: boolean; orders: ContactOrder[] } | null>(null)
  const [open, setOpen] = useState(false)
  const [products, setProducts] = useState<ProductOption[]>([])
  const [lines, setLines] = useState<{ name: string; qty: number }[]>([{ name: '', qty: 1 }])
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [departamento, setDepartamento] = useState('Guatemala')
  const [payment, setPayment] = useState<'cod' | 'card'>('cod')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (id: string) => {
    let next = { conversationId: id, connected: false, orders: [] as ContactOrder[] }
    try {
      const res = await fetch(`/api/shopify/orders?conversation_id=${encodeURIComponent(id)}`)
      const body = await readResponseJson<{ connected?: boolean; orders?: ContactOrder[] }>(res)
      if (res.ok) next = { conversationId: id, connected: Boolean(body?.connected), orders: body?.orders ?? [] }
    } catch {
      // Card stays hidden when the lookup fails.
    }
    // Tagged with its conversation: a late answer for a thread the agent left
    // never shows, because `checked` below compares against the current one.
    setResult(next)
  }, [])

  useEffect(() => {
    if (conversationId) void load(conversationId)
  }, [conversationId, load])

  async function openForm() {
    setFullName(contactName)
    setPhone(contactPhone ?? '')
    setLines([{ name: '', qty: 1 }])
    setOpen(true)
    if (!products.length) {
      const { data } = await createClient()
        .from('products').select('name, price')
        .eq('is_active', true).not('shopify_variant_id', 'is', null).order('name')
      setProducts((data ?? []).map((p) => ({ name: p.name as string, price: Number(p.price) || 0 })))
    }
  }

  async function submit() {
    if (!conversationId) return
    setSaving(true)
    try {
      const res = await fetch('/api/shopify/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId, items: lines.filter((l) => l.name), full_name: fullName,
          phone, address, departamento, payment,
        }),
      })
      const body = await readResponseJson<{ error?: string; order?: { name: string; draft: boolean } }>(res)
      if (!res.ok || !body?.order) {
        toast.error(body?.error || t('createFailed'))
        return
      }
      toast.success(body.order.draft ? t('createdAwaitingPayment') : t('created', { name: body.order.name }))
      setOpen(false)
      void load(conversationId)
    } finally {
      setSaving(false)
    }
  }

  const checked = !!conversationId && result?.conversationId === conversationId
  if (!checked || !result.connected) return null

  const total = lines.reduce((s, l) => s + (products.find((p) => p.name === l.name)?.price ?? 0) * l.qty, 0)
  const ready = lines.some((l) => l.name) && fullName.trim() && phone.trim() && address.trim() && departamento.trim()

  return (
    <div className="border-border bg-muted/40 mt-3 space-y-2 rounded-lg border p-3 text-left text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="text-foreground flex items-center gap-1.5 font-medium">
          <ShoppingBag className="size-3.5" />
          {t('title')}
        </div>
        <Button size="sm" variant="outline" className="h-6 text-[11px]" disabled={!canAct} onClick={openForm}>
          <Plus className="size-3" />
          {t('create')}
        </Button>
      </div>
      {result.orders.length === 0 && <p className="text-muted-foreground">{t('none')}</p>}
      {result.orders.map((o) => {
        const s = o.status
        const tracking = s?.fulfillments.flatMap((f) => f.trackingInfo).find((ti) => ti.number)
        const delivery = s?.fulfillments.map((f) => f.displayStatus).filter(Boolean).join(', ')
        return (
          <div key={o.shopifyId} className="bg-card border-border space-y-0.5 rounded-md border px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-foreground font-medium">{s?.name ?? o.title}</span>
              <span className="text-muted-foreground shrink-0">{formatCurrency(o.total, defaultCurrency)}</span>
            </div>
            <div className="text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5">
              {o.awaitingPayment && <span>{t('awaitingPayment')}</span>}
              {s?.cancelledAt && <span className="text-red-400">{t('cancelled')}</span>}
              {s && <span>{t('payment', { status: s.displayFinancialStatus ?? '—' })}</span>}
              {s && <span>{t('preparation', { status: s.displayFulfillmentStatus })}</span>}
              {delivery && <span>{t('delivery', { status: delivery })}</span>}
            </div>
            {tracking && (
              <div className="text-muted-foreground">
                {t('tracking')}{' '}
                {tracking.url ? (
                  <a href={tracking.url} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                    {tracking.number}
                  </a>
                ) : tracking.number}
                {tracking.company ? ` · ${tracking.company}` : ''}
              </div>
            )}
          </div>
        )
      })}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('formTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="space-y-1.5">
              <Label>{t('products')}</Label>
              {lines.map((l, i) => (
                <div key={i} className="flex gap-1.5">
                  <select
                    aria-label={t('products')}
                    value={l.name}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    className={selectClass}
                  >
                    <option value="">{t('pickProduct')}</option>
                    {products.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name} · {formatCurrency(p.price, defaultCurrency)}
                      </option>
                    ))}
                  </select>
                  <Input
                    type="number" min={1} max={50} value={l.qty} aria-label={t('qty')} className="h-8 w-16"
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x)))}
                  />
                  {lines.length > 1 && (
                    <Button size="icon" variant="ghost" className="size-8" aria-label={t('removeLine')}
                      onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setLines([...lines, { name: '', qty: 1 }])}>
                <Plus className="size-3" />
                {t('addLine')}
              </Button>
            </div>
            <div className="space-y-1">
              <Label htmlFor="so-name">{t('fullName')}</Label>
              <Input id="so-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="so-phone">{t('phone')}</Label>
              <Input id="so-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="so-address">{t('address')}</Label>
              <Input id="so-address" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="so-depto">{t('departamento')}</Label>
              <Input id="so-depto" value={departamento} onChange={(e) => setDepartamento(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="so-pay">{t('paymentMethod')}</Label>
              <select id="so-pay" value={payment} onChange={(e) => setPayment(e.target.value === 'card' ? 'card' : 'cod')} className={selectClass}>
                <option value="cod">{t('cod')}</option>
                <option value="card">{t('card')}</option>
              </select>
            </div>
            <p className="text-muted-foreground text-xs">{t('totalHint', { total: formatCurrency(total, defaultCurrency) })}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>{t('cancel')}</Button>
            <Button onClick={submit} disabled={!ready || saving}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {t('submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
