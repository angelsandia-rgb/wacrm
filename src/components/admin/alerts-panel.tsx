'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Siren } from 'lucide-react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { readResponseJson } from '@/lib/http/response-json';

type Severity = 'info' | 'warning' | 'critical';

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
              el sistema — el mismo sink que alimenta Telegram.
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Severidad</TableHead>
              <TableHead>Fuente</TableHead>
              <TableHead>Título</TableHead>
              <TableHead>Empresa</TableHead>
              <TableHead>Ocurrencias</TableHead>
              <TableHead>Última vez</TableHead>
              <TableHead className="text-right">Acción</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {alerts.map((alert) => (
              <TableRow key={alert.id}>
                <TableCell>
                  <Badge className={SEVERITY_BADGE[alert.severity]}>
                    {alert.severity === 'critical' ? (
                      <AlertTriangle className="size-3" />
                    ) : null}
                    {SEVERITY_LABEL[alert.severity]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {alert.source}
                </TableCell>
                <TableCell
                  className="max-w-72 truncate"
                  title={
                    Object.keys(alert.detail ?? {}).length
                      ? JSON.stringify(alert.detail, null, 2)
                      : alert.title
                  }
                >
                  {alert.title}
                </TableCell>
                <TableCell>{accountName(alert) ?? '—'}</TableCell>
                <TableCell>{alert.occurrences}</TableCell>
                <TableCell>{formatDateTime(alert.last_seen_at)}</TableCell>
                <TableCell className="text-right">
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
                </TableCell>
              </TableRow>
            ))}
            {!loading && alerts.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-muted-foreground py-8 text-center"
                >
                  {showResolved
                    ? 'No hay alertas registradas.'
                    : 'No hay alertas abiertas.'}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
