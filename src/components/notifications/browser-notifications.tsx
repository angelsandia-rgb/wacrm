"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Notification } from "@/types";
import { notificationPushPayload } from "@/lib/push/notification-payload";

/**
 * BrowserNotifications — headless, mounted once in the dashboard shell
 * (same pattern as `PresenceHeartbeat`). Shows a native Chrome/OS
 * notification for conversation assignments and pending AI handoffs
 * to the signed-in agent. Assignment triggers and direct AI handoff
 * inserts both publish through the notifications table.
 *
 * Relies on the same realtime channel + RLS scoping as
 * `useUnreadNotifications` — every row this tab receives already belongs
 * to the signed-in user.
 */
export function BrowserNotifications() {
  const { accountId } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!accountId) return;
    if (typeof window === "undefined" || !("Notification" in window)) return;

    // Permission is requested by the explicit Settings action.

    const supabase = createClient();
    const channel = supabase
      .channel("notifications-browser-alert")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications" },
        (payload) => {
          if (Notification.permission !== "granted") return;
          const row = payload.new as Notification;

          const push = notificationPushPayload(row);
          let n: globalThis.Notification;
          try {
            n = new Notification(push.title, { body: push.body, tag: row.id });
          } catch {
            // Mobile browsers require the service-worker notification API.
            void navigator.serviceWorker?.ready.then((reg) => reg.showNotification(push.title, {
              body: push.body, tag: row.id, data: { url: push.url },
            })).catch(() => {});
            return;
          }
          n.onclick = () => {
            window.focus();
            if (row.conversation_id) {
              router.push(`/inbox?c=${row.conversation_id}`);
            }
            n.close();
          };
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [accountId, router]);

  return null;
}
