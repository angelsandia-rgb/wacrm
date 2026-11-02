'use client';

// Self-contained Spanish strings, like close-config.tsx.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { readResponseJson } from '@/lib/http/response-json';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Settings → WhatsApp: the `<script>` snippet for the website chat
 *  button (GET /api/public/widget/[accountId]). */
export function WebsiteWidgetCard() {
  const { accountId } = useAuth();
  const [text, setText] = useState('Hola, quiero más información');
  const [label, setLabel] = useState('Escríbenos');
  const [copied, setCopied] = useState(false);
  // The widget needs the default number's public phone (Zernio
  // connections don't fill it in by themselves).
  const [hasPublicNumber, setHasPublicNumber] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/whatsapp/config')
      .then((res) => readResponseJson<{ configs?: { is_default: boolean; public_phone_number: string | null }[] }>(res))
      .then((body) => {
        const main = body.configs?.find((c) => c.is_default) ?? body.configs?.[0];
        if (alive) setHasPublicNumber(Boolean(main?.public_phone_number?.trim()));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!accountId) return null;

  const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const snippet = `<script src="${process.env.NEXT_PUBLIC_SITE_URL ?? "https://chatsandia.com"}/api/public/widget/${accountId}" data-text="${attr(text)}" data-label="${attr(label)}" async></script>`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('No se pudo copiar');
    }
  };

  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle>Botón de WhatsApp para tu sitio web</CardTitle>
        <CardDescription>
          Pega este código antes de &lt;/body&gt; en tu página: aparece un botón flotante que abre un chat con tu número
          principal y el mensaje llega a esta bandeja.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasPublicNumber === false ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <span>
              Tu número principal no tiene el &quot;número público&quot; configurado, así que el botón no aparecerá. Pulsa
              &quot;Editar&quot; en la conexión de arriba y escríbelo con código de país (ej. 50212345678).
            </span>
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="widget-text">Mensaje inicial</Label>
            <Input id="widget-text" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="widget-label">Texto del botón (opcional)</Label>
            <Input id="widget-label" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
          </div>
        </div>
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap">{snippet}</pre>
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? 'Copiado' : 'Copiar código'}
        </Button>
      </CardContent>
    </Card>
  );
}
