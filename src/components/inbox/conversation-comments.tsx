'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StickyNote, Send, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { readResponseJson } from '@/lib/http/response-json';
import { mentionLabel, type MentionableMember } from '@/lib/inbox/mentions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export interface ConversationComment {
  id: string;
  conversation_id: string;
  author_id: string;
  body: string;
  mentions: string[];
  created_at: string;
}

/** Comments of one conversation (migration 173), kept live over realtime. */
export function useConversationComments(conversationId: string | undefined) {
  const [state, setState] = useState<{ for: string; comments: ConversationComment[] } | null>(null);

  const add = useCallback(
    (row: ConversationComment) =>
      setState((prev) =>
        prev?.for !== row.conversation_id
          ? { for: row.conversation_id, comments: [row] }
          : prev.comments.some((c) => c.id === row.id)
            ? prev
            : { for: row.conversation_id, comments: [...prev.comments, row] },
      ),
    [],
  );

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from('conversation_comments')
      .select('id, conversation_id, author_id, body, mentions, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at')
      .then(({ data, error }) => {
        if (cancelled) return;
        // Table missing (code ahead of migration 173) → just no comments.
        if (error) console.error('Failed to fetch comments:', error);
        setState((prev) => {
          const live = prev?.for === conversationId ? prev.comments : [];
          const loaded = (data ?? []) as ConversationComment[];
          return { for: conversationId, comments: [...loaded, ...live.filter((c) => !loaded.some((l) => l.id === c.id))] };
        });
      });
    const channel = supabase
      .channel(`comments:${conversationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'conversation_comments', filter: `conversation_id=eq.${conversationId}` },
        (payload) => add(payload.new as ConversationComment),
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [conversationId, add]);

  return { comments: state && state.for === conversationId ? state.comments : [], add };
}

export function CommentBubble({ comment, authorName }: { comment: ConversationComment; authorName: string }) {
  const time = new Date(comment.created_at).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="flex justify-end">
      <div className="text-foreground max-w-[85%] rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
        <div className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-amber-500">
          <StickyNote className="h-3 w-3" />
          Nota interna · {authorName}
        </div>
        <p className="break-words whitespace-pre-wrap">{comment.body}</p>
        <div className="mt-0.5 text-right text-[10px] text-amber-500/80">{time}</div>
      </div>
    </div>
  );
}

/** Note box with a lightweight `@` picker. Only the server decides who
 *  was mentioned (resolveMentions), the picker just types the handle. */
export function CommentComposer({
  conversationId,
  members,
  onPosted,
}: {
  conversationId: string;
  members: MentionableMember[];
  onPosted?: (comment: ConversationComment) => void;
}) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const query = text.match(/@([\p{L}\p{N}_. -]{0,30})$/u)?.[1]?.toLowerCase() ?? null;
  const suggestions = useMemo(
    () =>
      query === null
        ? []
        : members.filter((m) => mentionLabel(m) && mentionLabel(m).toLowerCase().startsWith(query.trimStart())).slice(0, 6),
    [members, query],
  );

  const pick = (m: MentionableMember) => {
    setText((t) => t.replace(/@[^@]*$/u, `@${mentionLabel(m)} `));
    ref.current?.focus();
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      const json = await readResponseJson<{ comment?: ConversationComment; error?: string }>(res);
      if (!res.ok || !json.comment) throw new Error(json.error ?? 'No se pudo guardar la nota');
      setText('');
      onPosted?.(json.comment);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar la nota');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative border-t bg-amber-500/5 p-3">
      {suggestions.length > 0 ? (
        <div className="bg-popover absolute bottom-full left-3 mb-1 w-64 overflow-hidden rounded-md border shadow-md">
          {suggestions.map((m) => (
            <button
              key={m.user_id}
              type="button"
              className="hover:bg-muted block w-full px-3 py-1.5 text-left text-sm"
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
            >
              @{mentionLabel(m)}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <Textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (suggestions.length > 0) pick(suggestions[0]);
              else void submit();
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder="Nota interna para el equipo. El cliente no la ve. Escribe @ para mencionar."
          className="min-h-[44px] resize-none border-amber-500/40"
        />
        <Button size="icon" onClick={() => void submit()} disabled={saving || !text.trim()} aria-label="Guardar nota">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
