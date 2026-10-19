# Confirmed child, breakfast, extra-bed and season policies

Owner authorization 2026-10-18: children include breakfast, children under six do not pay, and extra beds are limited to the Junior Suite. The high-season banner publishes Q200 for ages 6-12 and Q400 for an extra bed. Extra-bed charging frequency and interaction with the five-adult tier remain subject to hotel confirmation; do not double charge or promise it is always included.

Interpret a complete week as Monday-Sunday. Active calendar horizon:

- Christmas 2026: December 21-27; New Year 2027: December 28-January 3. Combined rate interval: 2026-12-21 through 2027-01-03 inclusive.
- Holy Week 2027: March 22-28, including Easter Sunday March 28.
- Christmas 2027: December 20-26; New Year 2028: December 27-January 2. Combined interval: 2027-12-20 through 2028-01-02 inclusive.

Ranges apply to occupied nights; checkout remains exclusive in stay totals. Calendar references: https://www.timeanddate.com/holidays/guatemala/2026 and https://www.timeanddate.com/holidays/guatemala/2027 . The calendar-week boundaries implement the owner's full-week instruction, rather than claiming those whole weeks are statutory holidays.

Premium high-season rows match the source (Q450 individual/Q870 couple). Master Deluxe, Classic, Classic Double and Junior high-season adult occupancy/price pairings remain unapproved because the banner is inconsistent. Preserve stored amounts for audit, mark the product description pending, hide seasonal amounts from AI catalog context and return missing pricing instead of falling back to an ordinary rate. Ordinary rates remain usable. Do not alter prior guest/staff agreements.

The scoped scripts/hotel/update-confirmed-season-policies.ts plans by default. With --apply it writes a local backup, updates dates without changing adult amounts, adds Classic Double child tiers (existing normal policy Q175 Sunday-Thursday/Q200 Friday-Saturday; high season Q200), updates the account prompt and two knowledge documents and reindexes them. It preserves unrelated product and account settings. No guest messages are sent.

Hotel descriptions now retain up to 1200 characters in AI catalog context so restrictions and the pending status remain visible; other industries retain the previous 80-character limit.
