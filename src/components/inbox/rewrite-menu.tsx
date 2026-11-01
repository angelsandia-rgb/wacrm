'use client';

// Self-contained Spanish labels, like csat-config.tsx.

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Wand2 } from 'lucide-react';

import { readResponseJson } from '@/lib/http/response-json';
import type { RewriteAction } from '@/lib/ai/rewrite';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const OPTIONS: { action: RewriteAction; label: string }[] = [
  { action: 'professional', label: 'Más profesional' },
  { action: 'friendly', label: 'Más amable' },
  { action: 'fix', label: 'Corregir ortografía' },
  { action: 'simplify', label: 'Simplificar' },
];
const TRANSLATE: { action: RewriteAction; label: string }[] = [
  { action: 'translate_en', label: 'Traducir al inglés' },
  { action: 'translate_es', label: 'Traducir al español' },
];

/** AI rewrite of the agent's own draft (tone, grammar, translate). */
export function RewriteMenu({
  text,
  disabled,
  onRewrite,
}: {
  text: string;
  disabled?: boolean;
  onRewrite: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!text.trim()) return null;

  async function run(action: RewriteAction) {
    setBusy(true);
    try {
      const res = await fetch('/api/ai/rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, action }),
      });
      const data = await readResponseJson(res).catch(() => ({}));
      if (!res.ok || typeof data.text !== 'string') {
        toast.error(
          data.code === 'ai_not_configured'
            ? 'La IA no está configurada — actívala en Configuración → IA.'
            : data.error ?? 'No se pudo reescribir el mensaje.',
        );
        return;
      }
      onRewrite(data.text);
    } catch {
      toast.error('No se pudo conectar con la IA.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled || busy}
        title="Mejorar con IA"
        aria-label="Mejorar con IA"
        className="text-muted-foreground hover:text-primary inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top">
        {OPTIONS.map((o) => (
          <DropdownMenuItem key={o.action} onClick={() => void run(o.action)}>
            {o.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {TRANSLATE.map((o) => (
          <DropdownMenuItem key={o.action} onClick={() => void run(o.action)}>
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
