'use client';

import { Sparkles } from 'lucide-react';

const SENTIMENT: Record<'positive' | 'neutral' | 'negative', { label: string; className: string }> = {
  positive: { label: '🙂 Positivo', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  neutral: { label: '😐 Neutral', className: 'bg-muted text-muted-foreground' },
  negative: { label: '🙁 Negativo', className: 'bg-red-500/15 text-red-700 dark:text-red-400' },
};

/** AI close insights of a closed conversation (migration 169). */
export function CloseInsightsCard({
  category,
  summary,
  sentiment,
  sentimentReason,
}: {
  category: string | null;
  summary: string;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  sentimentReason: string | null;
}) {
  const s = sentiment ? SENTIMENT[sentiment] : null;
  return (
    <div className="border-border bg-muted/40 mx-3 mb-2 rounded-md border px-3 py-2 text-xs">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <Sparkles className="text-primary size-3.5" />
        <span className="text-foreground font-medium">Resumen del cierre</span>
        {category && <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5">{category}</span>}
        {s && (
          <span className={`rounded px-1.5 py-0.5 ${s.className}`} title={sentimentReason ?? undefined}>
            {s.label}
          </span>
        )}
      </div>
      <p className="text-muted-foreground">{summary}</p>
    </div>
  );
}
