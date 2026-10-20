'use client';

// Deliberately hardcoded Spanish — same call as google-sheets-config.tsx:
// keeps this self-contained rather than threading a Settings block
// through en/ko/es.json.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bell, BellOff, Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  getPushState,
  subscribeToPush,
  unsubscribeFromPush,
  type PushState,
} from '@/lib/push/client';
import { readResponseJson } from '@/lib/http/response-json';

export function PushNotificationsCard() {
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const refresh = useCallback(async () => {
    setState(await getPushState());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getPushState().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const enabled = state === 'on';
  const unavailable = state === 'unsupported' || state === 'unconfigured';

  const onToggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) {
        // Permission MUST be requested from a user gesture — this click is one.
        const perm =
          Notification.permission === 'granted'
            ? 'granted'
            : await Notification.requestPermission();
        if (perm !== 'granted') {
          toast.error(
            perm === 'denied'
              ? 'Bloqueaste las notificaciones para este sitio. Habilitalas en los ajustes del navegador.'
              : 'Permiso de notificaciones no concedido.',
          );
          await refresh();
          return;
        }
        const ok = await subscribeToPush();
        if (!ok) {
          toast.error('No se pudo activar. Probá recargar la página.');
        } else {
          toast.success('Notificaciones push activadas en este dispositivo.');
        }
      } else {
        await unsubscribeFromPush();
        toast.success('Notificaciones push desactivadas en este dispositivo.');
      }
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/push/test', { method: 'POST' });
      if (res.ok) {
        toast.success('El servicio push aceptó la prueba. Comprobá que aparezca en tu dispositivo.');
      } else {
        const data = await readResponseJson<{ error?: string }>(res);
        toast.error(data?.error ?? 'No se pudo enviar la prueba.');
      }
    } catch {
      toast.error('No se pudo enviar la prueba.');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {enabled ? <Bell className="size-4" /> : <BellOff className="size-4" />}
          Notificaciones push
        </CardTitle>
        <CardDescription>
          Recibí avisos de conversaciones asignadas y consultas que la IA deja
          pendientes para el equipo, aunque tengas la app cerrada. Se configura por dispositivo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm">
            <p className="font-medium text-foreground">
              {enabled ? 'Activadas en este dispositivo' : 'Desactivadas'}
            </p>
            {state === 'denied' && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                El navegador tiene las notificaciones bloqueadas para este sitio.
                Cambialo en los ajustes del sitio y volvé a intentar.
              </p>
            )}
            {state === 'unsupported' && (
              <p className="mt-0.5 text-xs text-muted-foreground">Este navegador no permite push. Abrí Chat Sandía en un navegador o una instalación de la app que permita notificaciones.</p>
            )}
            {state === 'unconfigured' && (
              <p className="mt-0.5 text-xs text-muted-foreground">El servidor aún no tiene configurado el envío push. Contactá al administrador.</p>
            )}
            {state === 'error' && (
              <p className="mt-0.5 text-xs text-muted-foreground">No se pudo verificar el registro de este dispositivo. Revisá la conexión y volvé a activar las notificaciones.</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {(busy || state === 'loading') && (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            )}
            <Switch
              checked={enabled}
              disabled={busy || state === 'loading' || state === 'denied' || unavailable}
              onCheckedChange={onToggle}
              aria-label="Activar notificaciones push"
            />
          </div>
        </div>

        {enabled && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={sendTest}
            disabled={testing}
          >
            {testing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Enviar prueba
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
