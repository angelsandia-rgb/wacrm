-- Read-only aggregate inspection. No client names, messages, or secrets.
SELECT json_build_object(
  'observed_at', now(),
  'database_bytes', pg_database_size(current_database()),
  'accounts', (SELECT count(*) FROM public.accounts),
  'hotel_accounts', (SELECT count(*) FROM public.accounts WHERE industry_vertical = 'hotel'),
  'contacts', (SELECT count(*) FROM public.contacts),
  'conversations', (SELECT count(*) FROM public.conversations),
  'messages', (SELECT count(*) FROM public.messages),
  'messages_24h', (SELECT count(*) FROM public.messages WHERE created_at >= now() - interval '24 hours'),
  'messages_7d', (SELECT count(*) FROM public.messages WHERE created_at >= now() - interval '7 days'),
  'reservations', (SELECT count(*) FROM public.reservation_requests),
  'products', (SELECT count(*) FROM public.products),
  'knowledge_chunks', (SELECT count(*) FROM public.ai_knowledge_chunks),
  'tables', (SELECT json_agg(t) FROM (
    SELECT relname, n_live_tup AS estimated_rows,
      pg_total_relation_size(relid) AS bytes
    FROM pg_catalog.pg_stat_user_tables WHERE schemaname = 'public'
    ORDER BY pg_total_relation_size(relid) DESC LIMIT 12
  ) t),
  'cross_tenant_reservations', (SELECT count(*) FROM public.reservation_requests r
    LEFT JOIN public.contacts c ON c.id = r.contact_id
    LEFT JOIN public.conversations v ON v.id = r.conversation_id
    LEFT JOIN public.products p ON p.id = r.product_id
    LEFT JOIN public.quotes q ON q.id = r.quote_id
    WHERE c.account_id <> r.account_id OR v.account_id <> r.account_id
       OR p.account_id <> r.account_id OR q.account_id <> r.account_id)
) AS capacity;
