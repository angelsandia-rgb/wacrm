'use client';

// Self-contained Spanish strings, like csat-config.tsx.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, ListChecks } from 'lucide-react';

import { readResponseJson } from '@/lib/http/response-json';
import { AI_SKILLS, type AiSkillKey, type AiSkillsConfig } from '@/lib/ai/skills';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Per-skill on/off + "when should it do this?" rule for the auto-reply
 *  bot (ai_configs.skills, migration 171). Saves on its own button. */
export function AiSkillsCard({ canEdit }: { canEdit: boolean }) {
  const [skills, setSkills] = useState<AiSkillsConfig>({});
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await readResponseJson(await fetch('/api/ai/skills')).catch(() => null);
        if (!cancelled && data && typeof data === 'object') {
          setSkills((data.skills as AiSkillsConfig) ?? {});
          setConfigured(data.configured !== false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = (key: AiSkillKey, p: { enabled?: boolean; when?: string }) =>
    setSkills((s) => ({ ...s, [key]: { ...s[key], ...p } }));

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/ai/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skills }),
      });
      const data = await readResponseJson(res).catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || 'No se pudieron guardar las habilidades.');
        return;
      }
      setSkills((data.skills as AiSkillsConfig) ?? skills);
      toast.success('Habilidades de la IA guardadas.');
    } catch {
      toast.error('No se pudieron guardar las habilidades.');
    } finally {
      setSaving(false);
    }
  }

  const disabled = !canEdit || loading || saving || !configured;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks className="text-primary h-4 w-4" /> Habilidades de la IA
        </CardTitle>
        <CardDescription>
          Decide qué acciones puede tomar la IA sola y escribe cuándo debe hacerlo. Si una acción está apagada, la IA
          no la ejecuta aunque lo intente. Vacío = comportamiento normal.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!configured && (
          <p className="text-xs text-amber-600 dark:text-amber-500">Guarda primero la configuración de IA de arriba.</p>
        )}
        {AI_SKILLS.map((meta) => {
          const s = skills[meta.key];
          const enabled = s?.enabled !== false;
          return (
            <div key={meta.key} className="border-border space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between gap-4">
                <p className="text-foreground text-sm font-medium">{meta.label}</p>
                {meta.canDisable ? (
                  <Switch
                    checked={enabled}
                    onCheckedChange={(v) => patch(meta.key, { enabled: v })}
                    disabled={disabled}
                    aria-label={meta.label}
                  />
                ) : (
                  <span className="text-muted-foreground text-xs">Siempre activa</span>
                )}
              </div>
              {enabled && (
                <Textarea
                  value={s?.when ?? ''}
                  onChange={(e) => patch(meta.key, { when: e.target.value })}
                  placeholder="¿Cuándo debe hacerlo? Ej.: el cliente pide hablar con alguien o pregunta por descuentos"
                  rows={2}
                  maxLength={600}
                  disabled={disabled}
                  className="bg-muted text-foreground text-sm"
                />
              )}
            </div>
          );
        })}
        {canEdit && (
          <Button onClick={save} disabled={disabled}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Guardar habilidades
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
