'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  Siren,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { readResponseJson } from '@/lib/http/response-json';

type Severity = 'info' | 'warning' | 'critical';
type WatcherStatus = 'pr_opened' | 'diagnosed_only';

interface WatcherRun {
  id: string;
  status: WatcherStatus;
  branch: string | null;
  pr_url: string | null;
  summary: string;
  tests_passed: boolean | null;
  merged_at: string | null;
  created_at: string;
}

interface SystemAlert {
  id: string;
  severity: Severity;
  source: string;
  title: string;
  detail: Record<string, unknown>;
  dedup_key: string;
  account_id: string | null;
  account: { name: string } | { name: string }[] | null;
  first_seen_at: string;
  last_seen_at: string;
  occurrences: number;
  notified_at: string | null;
  resolved_at: string | null;
  watcher_runs: WatcherRun[] | null;
}

function latestWatcherRun(alert: SystemAlert): WatcherRun | null {
  const runs = alert.watcher_runs;
  if (!runs || runs.length === 0) return null;
  return [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Crítica',
  warning: 'Advertencia',
  info: 'Info',
};

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: 'bg-destructive/10 text-destructive',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  info: 'bg-muted text-muted-foreground',
};

function accountName(alert: SystemAlert): string | null {
  const a = alert.account;
  if (!a) return null;
  return Array.isArray(a) ? (a[0]?.name ?? null) : a.name;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-GT', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

export function AlertsPanel() {
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  const load = useCallback(async (includeResolved: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/alerts${includeResolved ? '?resolved=1' : ''}`,
        { cache: 'no-store' },
      );
      const body = await readResponseJson<{
        error?: string;
        alerts: SystemAlert[];
      }>(response);
      if (!response.ok)
        throw new Error(body.error ?? 'No se pudieron cargar las alertas');
      setAlerts(body.alerts);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'No se pudieron cargar las alertas',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(showResolved);
  }, [load, showResolved]);

  // Live updates: a fresh alert (or one bumping its occurrence count)
  // shows up without waiting for a manual refresh. The RLS policy on
  // system_alerts already scopes SELECT to is_platform_admin(), so
  // this channel only ever delivers rows this viewer could read
  // anyway (migration 130 adds the table to the realtime publication).
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('admin-system-alerts')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'system_alerts' },
        () => void load(showResolved),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'system_alert_watcher_runs' },
        () => void load(showResolved),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load, showResolved]);

  const resolve = async (alert: SystemAlert) => {
    setResolvingId(alert.id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/alerts/${alert.id}/resolve`, {
        method: 'POST',
      });
      const body = await readResponseJson<{ error?: string }>(response);
      if (!response.ok)
        throw new Error(body.error ?? 'No se pudo resolver la alerta');
      await load(showResolved);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'No se pudo resolver la alerta',
      );
    } finally {
      setResolvingId(null);
    }
  };

  const acceptFix = async (alert: SystemAlert) => {
    setAcceptingId(alert.id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/alerts/${alert.id}/accept-fix`, {
        method: 'POST',
      });
      const body = await readResponseJson<{ error?: string }>(response);
      if (!response.ok)
        throw new Error(body.error ?? 'No se pudo fusionar el PR');
      await load(showResolved);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'No se pudo fusionar el PR',
      );
    } finally {
      setAcceptingId(null);
    }
  };

  const openCount = alerts.filter((a) => !a.resolved_at).length;

  return (
    <Card id="alerts" className="scroll-mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Siren className="text-primary size-5" />
              Alertas del sistema
              {openCount > 0 ? (
                <span className="bg-destructive text-destructive-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold">
                  {openCount}
                </span>
              ) : null}
            </CardTitle>
            <CardDescription>
              Fallas de cron, credenciales inválidas y anomalías detectadas por
              el sistema. El watcher automático las investiga cada hora — la
              columna &quot;Watcher&quot; muestra su diagnóstico o el PR que
              propuso.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowResolved((v) => !v)}
            >
              {showResolved ? 'Solo abiertas' : 'Ver resueltas también'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load(showResolved)}
              disabled={loading}
            >
              <RefreshCw className={loading ? 'animate-spin' : ''} />
              Actualizar
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="border-destructive/30 bg-destructive/10 text-destructive mb-4 rounded-lg border px-4 py-3 text-sm">
            {error}
          </div>
        ) : null}
        <div className="divide-y">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="flex shrink-0 items-center gap-2 sm:w-36">
                <Badge className={SEVERITY_BADGE[alert.severity]}>
                  {alert.severity === 'critical' ? (
                    <AlertTriangle className="size-3" />
                  ) : null}
                  {SEVERITY_LABEL[alert.severity]}
                </Badge>
                <span className="text-muted-foreground font-mono text-xs">
                  {alert.source}
                </span>
              </div>

              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-sm font-medium"
                  title={
                    Object.keys(alert.detail ?? {}).length
                      ? JSON.stringify(alert.detail, null, 2)
                      : alert.title
                  }
                >
                  {alert.title}
                </p>
                <p className="text-muted-foreground text-xs">
                  {accountName(alert) ?? 'Sin empresa'} · {alert.occurrences}×
                  · {formatDateTime(alert.last_seen_at)}
                </p>
              </div>

              <div className="sm:w-56 sm:shrink-0">
                <WatcherCell
                  run={latestWatcherRun(alert)}
                  accepting={acceptingId === alert.id}
                  onAccept={() => void acceptFix(alert)}
                />
              </div>

              <div className="shrink-0 sm:text-right">
                {alert.resolved_at ? (
                  <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                    <CheckCircle2 className="size-3.5" />
                    Resuelta
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={resolvingId === alert.id}
                    onClick={() => void resolve(alert)}
                  >
                    {resolvingId === alert.id ? 'Guardando…' : 'Resolver'}
                  </Button>
                )}
              </div>
            </div>
          ))}
          {!loading && alerts.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              {showResolved
                ? 'No hay alertas registradas.'
                : 'No hay alertas abiertas.'}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function WatcherCell({
  run,
  accepting,
  onAccept,
}: {
  run: WatcherRun | null;
  accepting: boolean;
  onAccept: () => void;
}) {
  if (!run) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }

  if (run.status === 'diagnosed_only') {
    return (
      <span
        className="text-muted-foreground inline-flex max-w-56 items-center gap-1 truncate text-xs"
        title={run.summary}
      >
        <Bot className="size-3.5 shrink-0" />
        Diagnóstico: {run.summary}
      </span>
    );
  }

  if (run.merged_at) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="size-3.5" />
        Fusionado
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {run.pr_url ? (
        <a
          href={run.pr_url}
          target="_blank"
          rel="noreferrer"
          className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
        >
          <Bot className="size-3.5" />
          Ver PR
          <ExternalLink className="size-3" />
        </a>
      ) : null}
      <Button size="sm" disabled={accepting} onClick={onAccept}>
        {accepting ? 'Fusionando…' : 'Aceptar'}
      </Button>
    </div>
  );
}
