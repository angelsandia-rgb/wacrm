'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, RefreshCw, ShoppingBag, XCircle } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { readResponseJson } from '@/lib/http/response-json';

// Hardcoded Spanish, same choice as google-sheets-config.tsx.

interface ConfigPayload {
  connected?: boolean;
  shop_domain?: string;
  has_webhook_secret?: boolean;
  has_recurrente_key?: boolean;
  orders_live?: boolean;
  confirmation_template_name?: string | null;
  confirmation_template_language?: string | null;
  last_sync_at?: string | null;
}

export function ShopifyConfig() {
  const { accountId } = useAuth();
  const [cfg, setCfg] = useState<ConfigPayload | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [shop, setShop] = useState('');
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [recurrenteKey, setRecurrenteKey] = useState('');
  const [ordersLive, setOrdersLive] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateLang, setTemplateLang] = useState('es');

  const fetchConfig = useCallback(async (): Promise<ConfigPayload> => {
    const res = await fetch('/api/shopify/config');
    return readResponseJson<ConfigPayload>(res).catch((): ConfigPayload => ({ connected: false }));
  }, []);

  const apply = useCallback((data: ConfigPayload) => {
    setCfg(data);
    setShop(data.shop_domain ?? '');
    setOrdersLive(Boolean(data.orders_live));
    setTemplateName(data.confirmation_template_name ?? '');
    setTemplateLang(data.confirmation_template_language ?? 'es');
  }, []);

  useEffect(() => {
    if (accountId) void fetchConfig().then(apply);
  }, [accountId, fetchConfig, apply]);

  const load = async () => apply(await fetchConfig());

  async function handleSave() {
    if (ordersLive && !cfg?.orders_live &&
      !confirm('Con pedidos reales activados, cada pedido que confirme la IA se crea en Shopify y puede enviarse a Dropi. ¿Continuar?')) return;
    setSaving(true);
    try {
      const res = await fetch('/api/shopify/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop_domain: shop,
          access_token: token || undefined,
          webhook_secret: secret || undefined,
          recurrente_secret_key: recurrenteKey || undefined,
          orders_live: ordersLive,
          confirmation_template_name: templateName,
          confirmation_template_language: templateLang,
        }),
      });
      const data = await readResponseJson<{ error?: string; shop_name?: string }>(res).catch(
        (): { error?: string; shop_name?: string } => ({}),
      );
      if (!res.ok) {
        toast.error(data.error || 'No se pudo guardar');
        return;
      }
      toast.success(data.shop_name ? `Conectado a ${data.shop_name}` : 'Guardado');
      setToken('');
      setSecret('');
      setRecurrenteKey('');
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch('/api/shopify/sync', { method: 'POST' });
      type SyncResult = { error?: string; synced?: number; active?: number; deactivated?: number };
      const data = await readResponseJson<SyncResult>(res).catch((): SyncResult => ({}));
      if (!res.ok) {
        toast.error(data.error || 'No se pudo sincronizar');
        return;
      }
      toast.success(`${data.synced} productos sincronizados (${data.active} activos, ${data.deactivated} desactivados)`);
      await load();
    } finally {
      setSyncing(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm('¿Desconectar Shopify? Los productos sincronizados se conservan.')) return;
    const res = await fetch('/api/shopify/config', { method: 'DELETE' });
    if (!res.ok) {
      toast.error('No se pudo desconectar');
      return;
    }
    toast.success('Shopify desconectado');
    setCfg({ connected: false });
  }

  if (!cfg) {
    return (
      <section>
        <SettingsPanelHead title="Shopify" />
        <div className="flex justify-center py-12"><Loader2 className="text-primary size-6 animate-spin" /></div>
      </section>
    );
  }

  const connected = Boolean(cfg.connected);
  const webhookUrl = typeof window !== 'undefined' ? `${window.location.origin}/api/shopify/webhook` : '/api/shopify/webhook';

  return (
    <section className="animate-in fade-in-50 duration-200 space-y-6">
      <SettingsPanelHead
        title="Shopify"
        description="La IA vende los productos de tu tienda por WhatsApp y convierte el chat en un pedido de Shopify."
      />

      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-foreground flex items-center gap-2">
            <ShoppingBag className="text-primary size-4" /> Conexión
          </CardTitle>
          <CardDescription>
            {connected ? (
              <span className="flex items-center gap-1.5 text-emerald-400">
                <CheckCircle2 className="size-3.5" /> Conectado a {cfg.shop_domain}
              </span>
            ) : (
              <span className="text-muted-foreground flex items-center gap-1.5">
                <XCircle className="size-3.5" /> No conectado
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sh-domain">Dominio de la tienda</Label>
            <Input id="sh-domain" value={shop} onChange={(e) => setShop(e.target.value)} placeholder="tu-tienda.myshopify.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sh-token">Token de Admin API (app personalizada)</Label>
            <Input
              id="sh-token" type="password" autoComplete="off" value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={connected ? 'Guardado — escribe uno nuevo solo para reemplazarlo' : 'shpat_…'}
            />
            <p className="text-muted-foreground text-xs">
              Permisos: read_products, read_inventory, write_orders, write_draft_orders. Se guarda cifrado.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sh-secret">Clave de firma del webhook (opcional)</Label>
            <Input
              id="sh-secret" type="password" autoComplete="off" value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={cfg.has_webhook_secret ? 'Guardada — escribe una nueva solo para reemplazarla' : ''}
            />
            <p className="text-muted-foreground text-xs">
              Para confirmar por WhatsApp los pedidos de la tienda web: en Shopify → Configuración → Notificaciones →
              Webhooks, crea &quot;Creación de pedido&quot; (JSON) hacia <code>{webhookUrl}</code> y pega aquí la clave que muestra Shopify.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sh-recurrente">Llave secreta de Recurrente (pagos con tarjeta)</Label>
            <Input
              id="sh-recurrente" type="password" autoComplete="off" value={recurrenteKey}
              onChange={(e) => setRecurrenteKey(e.target.value)}
              placeholder={cfg.has_recurrente_key ? 'Guardada — escribe una nueva solo para reemplazarla' : 'sk_live_…'}
            />
            <p className="text-muted-foreground text-xs">
              Recurrente → Desarrolladores. Con la llave, la IA envía el link de pago por el total exacto; sin ella, avisa que un asesor lo enviará.
              Los pedidos con tarjeta quedan como borrador etiquetado &quot;pago-tarjeta&quot; hasta que confirmes el pago.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sh-tpl">Plantilla de confirmación</Label>
              <Input id="sh-tpl" value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="confirmacion_pedido" />
              <p className="text-muted-foreground text-xs">Variables: {'{{1}}'} nombre, {'{{2}}'} pedido, {'{{3}}'} total.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sh-lang">Idioma de la plantilla</Label>
              <Input id="sh-lang" value={templateLang} onChange={(e) => setTemplateLang(e.target.value)} placeholder="es" />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={ordersLive} onCheckedChange={(v) => setOrdersLive(v === true)} className="mt-0.5" />
            <span>
              Crear pedidos reales
              <span className="text-muted-foreground block text-xs">
                Apagado: la IA crea borradores de pedido (no llegan a Dropi hasta que los completes en Shopify).
                Encendido: los pedidos contra entrega se crean reales y la tienda los envía a Dropi (los de tarjeta siempre
                quedan como borrador hasta confirmar el pago).
              </span>
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />} Guardar
            </Button>
            {connected && (
              <Button variant="outline" onClick={handleDisconnect}>Desconectar</Button>
            )}
          </div>
        </CardContent>
      </Card>

      {connected && (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-foreground text-base">Productos</CardTitle>
            <CardDescription>
              Trae los productos activos de Shopify al catálogo que usa la IA. Los borradores y los agotados quedan inactivos.
              {cfg.last_sync_at ? ` Última sincronización: ${new Date(cfg.last_sync_at).toLocaleString()}.` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={handleSync} disabled={syncing}>
              {syncing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
              Sincronizar con Shopify
            </Button>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
