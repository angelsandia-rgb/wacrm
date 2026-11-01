'use client';

// Self-contained Spanish strings, like csat-config.tsx.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, MessageSquareOff, X } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { readResponseJson } from '@/lib/http/response-json';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

interface CloseState {
  insights_enabled: boolean;
  categories: string[];
  auto_close_after_days: number | null;
}

export function CloseConfig() {
  const { canEditSettings } = useAuth();
  const [state, setState] = useState<CloseState>({ insights_enabled: false, categories: [], auto_close_after_days: null });
  const [newCategory, setNewCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await readResponseJson(await fetch('/api/conversations/close-config')).catch(() => null);
        if (!cancelled && cfg && typeof cfg === 'object') {
          setState({
            insights_enabled: !!cfg.insights_enabled,
            categories: Array.isArray(cfg.categories) ? cfg.categories : [],
            auto_close_after_days: typeof cfg.auto_close_after_days === 'number' ? cfg.auto_close_after_days : null,
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = (p: Partial<CloseState>) => setState((s) => ({ ...s, ...p }));

  const addCategory = () => {
    const name = newCategory.trim();
    if (!name || state.categories.some((c) => c.toLowerCase() === name.toLowerCase())) return;
    patch({ categories: [...state.categories, name] });
    setNewCategory('');
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/conversations/close-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      const data = await readResponseJson(res).catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || 'No se pudo guardar la configuración.');
        return;
      }
      toast.success('Configuración de cierre guardada.');
    } catch {
      toast.error('No se pudo guardar la configuración.');
    } finally {
      setSaving(false);
    }
  }, [state]);

  const disabled = !canEditSettings || loading || saving;

  return (
    <section className="animate-in fade-in-50 max-w-2xl duration-200">
      <SettingsPanelHead
        title="Cierre de conversaciones"
        description="Al cerrar una conversación, la IA elige una categoría, escribe un resumen y marca cómo se sintió el cliente. También puedes cerrar automáticamente las conversaciones inactivas."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquareOff className="text-primary h-4 w-4" /> Resumen con IA al cerrar
          </CardTitle>
          <CardDescription>
            Usa la clave de IA de la cuenta (Configuración → IA). Se analiza unos minutos después del cierre.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
            <div>
              <p className="text-foreground text-sm font-medium">Activar el resumen con IA</p>
              <p className="text-muted-foreground text-xs">Categoría, resumen y sentimiento (positivo, neutral o negativo).</p>
            </div>
            <Switch
              checked={state.insights_enabled}
              onCheckedChange={(v) => patch({ insights_enabled: v })}
              disabled={disabled}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Categorías</Label>
            <div className="flex flex-wrap gap-1.5">
              {state.categories.map((c) => (
                <span key={c} className="bg-muted text-foreground inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs">
                  {c}
                  {canEditSettings && (
                    <button
                      type="button"
                      aria-label={`Quitar ${c}`}
                      onClick={() => patch({ categories: state.categories.filter((x) => x !== c) })}
                      disabled={disabled}
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {canEditSettings && (
              <div className="flex gap-2">
                <Input
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCategory();
                    }
                  }}
                  placeholder="Nueva categoría"
                  maxLength={60}
                  disabled={disabled}
                />
                <Button type="button" variant="outline" onClick={addCategory} disabled={disabled}>
                  Agregar
                </Button>
              </div>
            )}
            <p className="text-muted-foreground text-xs">Si la IA no encuentra una que encaje, usa la última de la lista.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="auto-close-days">Cerrar automáticamente después de</Label>
            <div className="flex items-center gap-2 text-sm">
              <Input
                id="auto-close-days"
                type="number"
                min={1}
                max={90}
                value={state.auto_close_after_days ?? ''}
                onChange={(e) =>
                  patch({
                    auto_close_after_days: e.target.value === '' ? null : Math.min(90, Math.max(1, Math.floor(Number(e.target.value) || 1))),
                  })
                }
                disabled={disabled}
                className="w-20"
              />
              <span className="text-muted-foreground">días sin mensajes</span>
            </div>
            <p className="text-muted-foreground text-xs">Vacío = nunca. Si el cliente vuelve a escribir, la conversación se reabre sola.</p>
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
    </section>
  );
}
