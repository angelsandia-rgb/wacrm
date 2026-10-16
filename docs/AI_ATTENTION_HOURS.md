# Automatic attention hours

The per-account `ai_attention_hours_8_20` feature flag restricts automatic replies, bot attachments and follow-ups to 08:00 inclusive through 20:00 exclusive, every day, in `accounts.timezone`. An empty timezone uses `America/Guatemala`; invalid timezones fail closed. Accounts without this flag keep their existing schedule.

The platform administrator can toggle the flag in the existing company feature controls. No database migration is needed (uses `accounts.feature_flags`, migration 156).

The dispatcher checks before calling the provider and again after generation. Bot transports check before sending, so a generation or retry that crosses closing time cannot send text or images. Manual staff replies and manual AI drafts remain available outside these hours. Recovery skips closed hours before consuming attempts, and automatic follow-ups also respect this window.

This does not schedule an automatic next-morning reply to all overnight messages. Existing recovery age limits and staff ownership still apply. Outside-hours silence is intentional and does not permanently pause a conversation or create an error alert.
