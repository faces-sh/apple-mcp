# Roadmap / deferred work

This is Faces' fork of apple-mcp. It ships exactly the five Apple apps Faced supports today:
**Contacts, Messages, Notes, Reminders, Calendar** — each rewritten on JXA (`@jxa/run`) for real
structured returns, honest permission errors, and no script injection, and each independently
gateable via `APPLE_MCP_ENABLED_APPS`.

## Deferred (intentionally removed from the shipped surface)

- **Apple Mail** — *want to add back, pending research.* The upstream `utils/mail.ts` was mostly
  stubs (`getUnreadMails`/`searchMails` always returned `[]`) and fake data (`getMailboxes`/
  `getAccounts` returned hardcoded values), plus an injection-prone inline AppleScript handler in
  `index.ts`. For Gmail accounts the dedicated Google/Gmail integration is strictly better; Apple
  Mail's unique value is **non-Gmail accounts** (iCloud, Exchange, IMAP) configured in Mail.app.
  When we add it: research the best approach (proper JXA read/search/send, or a better existing MCP),
  then reinstate with the same JXA + honest-error + per-app-toggle discipline as the other five.

- **Apple Maps** — *may add back, pending research.* Removed because Apple Maps exposes almost no
  scriptable data — the upstream `utils/maps.ts` could only open the Maps UI and ask the user to
  finish manually (null coordinates, "see Maps for details"), and shipped leftover test code. Before
  reinstating, research whether a better Maps MCP / data source exists; if we only want an
  "open in Maps" actuator (search/directions), that can come back as a small, honest JXA module.

- **Reminders is slow and JXA cannot fix it.** Notes, Contacts and Calendar were all made fast by
  asking a COLLECTION for a property in one Apple Event instead of asking each item n times (see
  `utils/notes.ts`). Reminders does not answer to that. Measured on this Mac: `Reminders.lists.name()`
  for 50 lists took **18.7s**, ONE reminder's `name()` took **31.0s**, and the bulk
  `lists[0].reminders.name()` for 15 reminders took **32.1s**. Bulk and single cost the same because
  the cost is the app waking its store, not the round trip, and there is no shape of JXA call that
  avoids it. Making the reminders tools usable needs a native EventKit path, which is its own piece of
  work and not a refactor of this file.

- **Web search** — dropped permanently. The upstream `utils/web-search.ts` puppeteered Safari to
  scrape Google (brittle, intrusive, CAPTCHA-prone) and was already dead code. Faced uses a dedicated
  web-fetch / websearch capability instead.
