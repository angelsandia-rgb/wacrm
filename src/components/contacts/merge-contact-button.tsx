'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { GitMerge, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { readResponseJson } from '@/lib/http/response-json';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type Candidate = {
  id: string;
  name: string | null;
  phone: string | null;
  instagram_username: string | null;
  facebook_username: string | null;
};

const label = (c: Candidate) =>
  [c.name, c.phone, c.instagram_username && `@${c.instagram_username}`, c.facebook_username]
    .filter(Boolean)
    .join(' · ') || '—';

/** Contactos → "Unir duplicado": folds another contact into this one
 *  (the same person on WhatsApp and Instagram, a mistyped phone…). Admin+. */
export function MergeContactButton({ contactId, onMerged }: { contactId: string; onMerged: () => void }) {
  const canMerge = useCan('edit-settings');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = query.trim().replace(/[%,()]/g, '');
    if (!open || q.length < 2) return;
    let alive = true;
    const timer = setTimeout(() => {
      createClient()
        .from('contacts')
        .select('id, name, phone, instagram_username, facebook_username')
        .neq('id', contactId)
        .or(`name.ilike.%${q}%,phone.ilike.%${q}%,instagram_username.ilike.%${q}%,facebook_username.ilike.%${q}%`)
        .limit(8)
        .then(({ data }) => {
          if (alive) setResults((data ?? []) as Candidate[]);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, query, contactId]);

  if (!canMerge) return null;

  const merge = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/contacts/${contactId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duplicateId: picked.id }),
      });
      const body = await readResponseJson<{ error?: string }>(res);
      if (!res.ok) throw new Error(body.error ?? 'No se pudieron unir los contactos');
      toast.success('Contactos unidos');
      setOpen(false);
      setPicked(null);
      setQuery('');
      onMerged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudieron unir los contactos');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <GitMerge className="size-4" />
        Unir duplicado
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unir un contacto duplicado</DialogTitle>
            <DialogDescription>
              Sus chats, negocios, etiquetas, notas y tareas pasan a este contacto y el duplicado se elimina. No se
              puede deshacer.
            </DialogDescription>
          </DialogHeader>
          {picked ? (
            <div className="bg-muted rounded-md px-3 py-2 text-sm">
              Duplicado: <strong>{label(picked)}</strong>{' '}
              <button type="button" className="text-primary ml-1 text-xs underline" onClick={() => setPicked(null)}>
                cambiar
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar por nombre, teléfono o usuario"
              />
              <div className="max-h-60 divide-y overflow-y-auto rounded-md border empty:hidden">
                {(query.trim().length < 2 ? [] : results).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="hover:bg-muted block w-full px-3 py-2 text-left text-sm"
                    onClick={() => setPicked(c)}
                  >
                    {label(c)}
                  </button>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void merge()} disabled={!picked || busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />}
              Unir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
