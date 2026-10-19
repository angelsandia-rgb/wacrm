'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { Task, TaskStatus } from '@/lib/tasks/types';

interface CreateInput {
  title: string;
  due_at?: string | null;
  notes?: string | null;
  contact_id?: string | null;
  deal_id?: string | null;
  assigned_to?: string | null;
}

/**
 * Tasks for one contact, backed by `/api/tasks`. The server enforces
 * tenancy + the `agent` write gate; this hook keeps a local copy in
 * sync and toasts on failure.
 */
const NO_TASKS: Task[] = [];

/** The contact's tasks, or null when the request fails (non-blocking —
 *  the rest of the panel still works). */
async function fetchTasks(contactId: string): Promise<Task[] | null> {
  try {
    const res = await fetch(`/api/tasks?contact_id=${contactId}`);
    if (!res.ok) throw new Error(String(res.status));
    const json = (await res.json()) as { tasks: Task[] };
    return json.tasks ?? [];
  } catch {
    return null;
  }
}

export function useTasks(contactId: string | null) {
  const [taskState, setTasks] = useState<Task[]>([]);
  const [reloading, setReloading] = useState(false);
  // Which contact the stored tasks belong to — another contact's list is
  // never shown while this one's loads.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const current = !!contactId && loadedFor === contactId;
  const tasks = current ? taskState : NO_TASKS;
  const loading = !!contactId && (!current || reloading);

  const applyTasks = useCallback((forContact: string, loaded: Task[] | null) => {
    if (loaded) setTasks(loaded);
    setLoadedFor(forContact);
    setReloading(false);
  }, []);

  const refresh = useCallback(async () => {
    if (!contactId) return;
    setReloading(true);
    applyTasks(contactId, await fetchTasks(contactId));
  }, [contactId, applyTasks]);

  useEffect(() => {
    if (!contactId) return;
    let cancelled = false;
    void fetchTasks(contactId).then((loaded) => {
      // A failed first load shows an empty list, never another contact's.
      if (!cancelled) applyTasks(contactId, loaded ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [contactId, applyTasks]);

  const create = useCallback(
    async (input: CreateInput): Promise<Task | null> => {
      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contact_id: contactId, ...input }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error ?? String(res.status));
        setTasks((t) => [json.task as Task, ...t]);
        return json.task as Task;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'No se pudo crear la tarea');
        return null;
      }
    },
    [contactId],
  );

  const patch = useCallback(
    async (id: string, body: Partial<Pick<Task, 'title' | 'notes' | 'due_at' | 'status' | 'assigned_to'>>) => {
      // Optimistic for the common toggle.
      setTasks((t) => t.map((x) => (x.id === id ? { ...x, ...body } : x)));
      try {
        const res = await fetch(`/api/tasks/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error ?? String(res.status));
        setTasks((t) => t.map((x) => (x.id === id ? (json.task as Task) : x)));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'No se pudo actualizar la tarea');
        void refresh();
      }
    },
    [refresh],
  );

  const toggleDone = useCallback(
    (task: Task) => patch(task.id, { status: (task.status === 'done' ? 'open' : 'done') as TaskStatus }),
    [patch],
  );

  const remove = useCallback(async (id: string) => {
    setTasks((t) => t.filter((x) => x.id !== id));
    try {
      const res = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      toast.error('No se pudo eliminar la tarea');
      void refresh();
    }
  }, [refresh]);

  return { tasks, loading, refresh, create, patch, toggleDone, remove };
}
