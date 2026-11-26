'use client';

// Self-contained Spanish strings, like close-config.tsx.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Timer } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { readResponseJson } from '@/lib/http/response-json';
import { SLA_DEFAULTS, type SlaSettings } from '@/lib/sla/config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

/** Response-time target ("plazo de respuesta") — migration 189. */
export function SlaConfig() {
  const { canEditSettings } = useAuth();
  const [state, setState] = useState<SlaSettings>(SLA_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await readResponseJson(await fetch('/api/sla/config')).catch(() => null);
        if (!cancelled && cfg && typeof cfg === 'object') setState({ ...SLA_DEFAULTS, ...cfg });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = (p: Partial<SlaSettings>) => setState((s) => ({ ...s, ...p }));

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/sla/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      const data = await readResponseJson(res).catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || 'No se pudo guardar la configuración.');
        return;
      }
      toast.success('Plazo de respuesta guardado.');
    } catch {
      toast.error('No se pudo guardar la configuración.');
    } finally {
      setSaving(false);
    }
  }, [state]);

  const disabled = !canEditSettings || loading || saving;
  const off = disabled || !state.enabled;
  const minutes = (key: 'alert_minutes' | 'escalate_minutes', label: string) => (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <Input
          type="number" min={1} max={1440} className="w-20" value={state[key]} disabled={off}
          onChange={(e) => patch({ [key]: Math.max(1, Math.floor(Number(e.target.value) || 1)) } as Partial<SlaSettings>)}
        />
        min
      </span>
    </div>
  );

  return (
    <Card className="mt-6 max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Timer className="text-primary h-4 w-4" /> Plazo de respuesta
        </CardTitle>
        <CardDescription>
          Si un cliente escribe y nadie le contesta, SANDÍA avisa al asesor, reparte la conversación entre el equipo en
          línea y, al final, el bot le manda un solo acuse sin precios ni promesas.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
          <p className="text-foreground text-sm font-medium">Activar el plazo de respuesta</p>
          <Switch checked={state.enabled} onCheckedChange={(v) => patch({ enabled: v })} disabled={disabled} />
        </div>

        {minutes('alert_minutes', 'Avisar al asesor a los')}
        {minutes('escalate_minutes', 'Pasarla a otro asesor en línea a los')}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>El bot manda un acuse a los</span>
            <span className="flex items-center gap-2">
              <Input
                type="number" min={1} max={1440} className="w-20" disabled={off}
                value={state.ai_ack_minutes ?? ''} placeholder="no"
                onChange={(e) => patch({ ai_ack_minutes: e.target.value === '' ? null : Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              />
              min
            </span>
          </div>
          <Input
            aria-label="Texto del acuse" value={state.ack_text} maxLength={500} disabled={off || state.ai_ack_minutes == null}
            onChange={(e) => patch({ ack_text: e.target.value })}
          />
          <p className="text-muted-foreground text-xs">
            Déjalo vacío para que el bot nunca lo envíe. Respeta las etiquetas que silencian a la IA y solo sale dentro de
            la ventana de 24 h de WhatsApp.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Horario en que corre el reloj (hora de la empresa)</Label>
          <div className="flex items-center gap-2 text-sm">
            <Input
              type="number" min={0} max={24} className="w-16" value={state.window_start_hour} disabled={off}
              onChange={(e) => patch({ window_start_hour: Math.min(24, Math.max(0, Math.floor(Number(e.target.value) || 0))) })}
            />
            a
            <Input
              type="number" min={0} max={24} className="w-16" value={state.window_end_hour} disabled={off}
              onChange={(e) => patch({ window_end_hour: Math.min(24, Math.max(0, Math.floor(Number(e.target.value) || 0))) })}
            />
            h
          </div>
          <p className="text-muted-foreground text-xs">
            Fuera de ese horario no hay avisos. Un mensaje de la noche empieza a contar al abrir.
          </p>
        </div>

        {canEditSettings ? (
          <Button onClick={handleSave} disabled={disabled}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Guardar
          </Button>
        ) : (
          <p className="text-muted-foreground text-xs">Solo los administradores pueden cambiar esta configuración.</p>
        )}
      </CardContent>
    </Card>
  );
}
