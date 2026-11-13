# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md` "Test self-audits". Newest first.

## 2026-11-11: only an exact `true` passes, everywhere

Suite: 19 tests before, 23 after (`npx vitest run`, real Payload, in-memory MongoDB, fake mailer). Closes the "for the lead" item in the entry below: every access decision now fails closed.

- **The change.** One helper, `src/access.ts`: `exactlyTrue` (only `true` passes; a throw or rejection is `false`), `isManager` (signed in, and `canManage` answered exactly `true`) and `sendingAllowed` (no `canSend`, or exactly `true`). Every check uses them: sponsors create, update and delete; sponsors read (managers `true`, everyone else the plugin's own `publicSponsors` query, so a site's object answer is never handed to Payload as a query); the contacts field; tiers writes; sponsor updates' access; the `recipients`, `send`, `archive` and `recover` endpoints (one guard, 401 or 403, never a 500); `canSend` in `sendUpdate`; the `/admin/sponsors` view and its nav link. The tiers collection now gets the same options object as the others, not a copy, so it asks the same `canManage` that `sponsorsOf` returns.
- **Tests.** "only an exact yes from canManage or canSend": each entry point gets `1`, `'yes'`, `{}`, a query-shaped object (`{ listed: { equals: false } }`), a thrown error and a rejected promise, then `true`. "refuses collection and field access…" (public rows only, no contacts, no unlisted sponsor, sponsor/tier/update writes refused and nothing changed; with `true`, everything). "answers send, recipients, archive and recover with 403…" (no email, nothing changed; with `true`, each goes through). "sends nothing unless canSend answers exactly true…" (400 "turned off", never a 500). "shows the admin overview and its nav link only for an exact true" (also: not signed in is a no even when `canManage` says `true`).
- **Mutation checks.** 13 mutations, each a Python string replace on the file, restored byte for byte (checked by SHA-256). All 13 fail the suite: truthy passing in `exactlyTrue`; errors rethrown; `isManager` without its sign-in check; truthy `canSend` passing; the old truthy check put back at each of sponsors writes, contacts field, sponsors read, tiers writes, updates access, the endpoint guard, `sendUpdate`'s `canSend`, the admin view and the nav link.
- **Skipped.** The admin view is checked through its returned element tree, with Payload's admin shell (`@payloadcms/next/templates`) and `@payloadcms/ui` stubbed; it hasn't been rendered in a real admin. The opt-out endpoint has no access check by design (its link is signed per contact) and is already covered. Access set by a host through `overrides` is the host's own rule and isn't tested here.

## 2026-11-11: recovering a send the server stopped

Suite: 12 tests before, 19 after (`npx vitest run`, real Payload, in-memory MongoDB, fake mailer: no email leaves the machine). Closes the "not covered" item from the entry below.

- **The lease.** A claim now stores `claimId` (hidden) and `sendingSince`. Before each email the send makes one conditional write (id, `sending`, its own `claimId`) that refreshes `sendingSince` and records who has it so far. If that write matches nothing, the send was recovered: it stops and emails no one else. Its final write is conditional the same way, so it can't overwrite a recovery or a later send. An update in `sending` with no progress for `staleSendMinutes` (default 30, must be positive) is stuck; one claimed by 0.3.1 has no `sendingSince` and counts from `updatedAt`.
- **Recovery.** `recoverSend(payload, id)` and `POST /:id/recover` (managers only, `canManage` must return exactly `true`; a truthy value or an error is 403). It refuses an update that isn't sending or isn't stale (409), then takes it over in one conditional write on the same `claimId` and `sendingSince` it found stale (and `updatedAt` for 0.3.1 claims). It moves to `partial`, or `failed` if nothing was recorded, with a report of counts per sponsor (`recovered: true`). The recipients endpoint returns `stuck`, and the send button shows "Sending stopped: recover it to finish" with a Recover button; no background job.
- **Tests.** "recovers a stale send to partly sent…" (a delivery hangs to play a stopped server; fresh: 409, not stuck, send refused; backdated 31 minutes: stuck, recovered, resent to the other two, the old send wakes and emails no one; each contact emailed once). "lets an old send that wakes after its last email overwrite nothing". "recovers a send claimed before the lease existed…" (0.3.1 state, ends `failed`, resent). "gives one winner when two recoveries start together". "loses to a send that moves on…" (progress, a new claim, or a 0.3.1 write lands between the stale check and the takeover: refused, still `sending`). "refuses recovery to anonymous visitors, non-managers and anything but an exact yes…" (401, 403, and 403 for `1`, `'yes'`, `{}` and a thrown error). "refuses a stale-send time that is not a positive number".
- **Mutation checks.** 19 mutations, each made with a Python string replace on a backup and restored exactly (checked with `diff`). 18 fail the suite: the renew write's claim condition, its recorded deliveries, its result being checked, the final write's condition, the stale check in recovery, the stale threshold, each of the three takeover conditions, a takeover on the id only, always `partial`, recovering a non-sending update, the exact-`true` check, the sign-in check, a `canManage` error counting as yes, the `stuck` flag, the "recover it" refusal, and the option check. One survives: the claim not setting `sendingSince`. That's equivalent in behavior, because the claim also stamps `updatedAt` (the fallback) and the send renews before its first email.
- **Not covered.** If the server stops after an email goes out but before the next write records it, that one contact can get it twice on resend; the README says so. The Recover button (`src/client`) was type-checked only, not run in a browser. The exact-`true` rule applies to the new recovery endpoint only; the older endpoints and collection access still accept any truthy `canManage`. For the lead: decide whether to tighten those too.

## 2026-11-10: the lead's fixes after the first audit

Suite: 10 tests before, 12 after (`npx vitest run`, real Payload, in-memory MongoDB, fake mailer).

- **Double send.** `sendUpdate` now claims the update with one conditional write (`payload.db.updateOne` with the id and `status in [draft, partial, failed]` in `where`). Only one send can win; the other gets "This update is already sending." Test: "sends once when two sends start together…" (two sends with `Promise.allSettled`, deliveries held until the loser is refused: one send, one refusal, each contact emailed once). The existing "already sending" check now expects that wording.
- **Stuck in "sending".** Anything that throws after the claim (for example `renderEmail`) now records who got it and moves the update to **Partly sent** (`partial`), or **Failed** (`failed`) if nobody did, with `stoppedEarly` in the report, then throws a plain message. A failed delivery also leaves it partly sent instead of sent, so staff can see it. Who got it is kept as keyed hashes in a hidden `delivered` field, never addresses. Sending again reaches only the rest; the report counts them as `alreadySent`. The recipients preview counts only those still to reach, and the send button says "Send to the rest". Tests: "a send that stops partway…" (partial, then failed-before-anyone, each resent with nobody emailed twice) and the updated "counts a failed delivery…" (now partial, then resent to the one that bounced).
- **README upgrade note.** The git history (commit `01dfb4d`, then `3c22afe`) shows 0.2.0 was named `@extantape/payload-plugin-sponsor`, singular. The note now says so. It no longer says "now deprecated": the npm registry returns 404 for that name, so that couldn't be confirmed.
- **"All" includes unlisted sponsors.** Left as it is; the README now says "All current sponsors" means every sponsor that isn't archived, listed or not.
- **Mutation checks.** Each was made in `src/api.ts` and restored exactly. An unconditional claim (`where` on the id only) fails the two-sends test. Dropping the record-on-stop fails the partway test. Not skipping contacts already reached fails the partway and failed-delivery tests. Marking a send with a failed delivery as `sent` fails the failed-delivery test.
- **Not covered.** The server process dying mid-send still leaves the update in "sending" with no way out but editing it. That needs a stale-claim timeout; it's on the lead's list. The send button changes (`src/client`) are presentation and were type-checked only, not run in a browser.

## 2026-11-10: first audit

Suite before: 5 tests. After: 10 tests (`npx vitest run`, all in `test/sponsors.test.ts`, on a real Payload with an in-memory MongoDB and a fake mailer: no email leaves the machine). No `docs/decisions.md` yet, so the promises come from the README and code comments.

The plugin takes no payments itself. Money reaches it only through `upsertListing()` from a membership plugin (a paid tier's sponsor-wall perk); what it must get right there is who is listed and who is emailed.

### Promises and the tests that prove them

| Promise | Test |
| --- | --- |
| The public sees only listed, non-archived sponsors, by tier, never contacts (API and `getSponsors`) | sponsors › shows only listed, current sponsors publicly…; refusals › shows a signed-in non-manager only the public list… |
| Contacts are visible to managers only; a signed-in non-manager gets the public list without them | sponsors › shows only listed…; refusals › shows a signed-in non-manager only the public list… |
| Only managers create, update or delete sponsors and tiers, and read or write updates; anonymous visitors can't read updates | refusals › shows a signed-in non-manager only the public list…, and lets them change nothing |
| Send, recipients and archive endpoints: 401 without a user, 403 for non-managers, nothing sent or changed | refusals › refuses send, recipients and archive… |
| The recipients preview gives counts only, never addresses | refusals › refuses send, recipients and archive… (manager part) |
| One email per contact; opted-out contacts and archived sponsors skipped; each with its own opt-out link on `publicURL`/`serverURL`; `renderEmail` wraps it | sponsors › sends an update to a tier… |
| An update can't be sent twice, or while it is sending | sponsors › sends an update… (sent); refusals › sends nothing… (sending) |
| `canSend` off refuses and sends nothing; no recipients refuses; the update stays a draft | refusals › sends nothing where sending is off… |
| A failed delivery is counted, the rest still go, and the report holds counts, never addresses | sponsors › sends an update… (report); refusals › counts a failed delivery… |
| The sponsor's name is escaped in the email footer | refusals › counts a failed delivery… |
| Opt-out links are signed per sponsor and contact; case doesn't matter; only that contact is opted out | sponsors › stops updates for a contact through their signed link |
| Malformed, forged (other secret), tampered or gone-sponsor links change nothing; the opt-out page says 400 | refusals › rejects opt-out links… |
| Archive first: archiving hides a sponsor from the public page and from updates, history kept | sponsors › sends an update… (archived part); refusals › shows a signed-in non-manager… (archived sponsor hidden) |
| `upsertListing` creates once and updates by `source` + `externalRef`; `retireListing` archives | sponsors › lists members from another plugin… |
| New sponsors are placed A–Z, each with its own key | the default order › places each new sponsor… |

### Gaps added (with their tests)

- Signed-in non-managers: public view only, no contacts, no writes, no updates: "shows a signed-in non-manager only the public list…".
- Endpoint refusals (401 and 403) for send, recipients and archive, with nothing sent or changed, and the preview's counts-only answer: "refuses send, recipients and archive…".
- `canSend` off, no recipients, already sending: "sends nothing where sending is off…".
- Failed delivery, addresses kept out of the report, the name escaped: "counts a failed delivery…".
- Opt-out link refusals and the endpoint's 400: "rejects opt-out links…".

### Gaps skipped (with why)

- The admin overview and the send button (`src/rsc`, `src/client`): presentation. Their decisions come from the endpoints tested above.
- `slugs`, `uploads`, `overrides`, `adminView`, `replyTo`: plain config plumbing with no access or data rule; a wrong value fails at once in a host's own tests.
- Lexical-to-HTML conversion: framework internals (`@payloadcms/richtext-lexical`).
- `scopeField` ordering: ordering only, no access rule. Listed for the lead below.

### For the lead

- **Double send race.** `sendUpdate` reads the status, then sets `sending` in a separate write (`src/api.ts` lines 180 and 183). Two sends started at once can both pass the check and email everyone twice. Needs an atomic claim (a conditional update), then a concurrency test. Not a test-only fix.
- **Unlisted sponsors get "all current sponsors" updates.** `recipientsOf` skips archived sponsors only, not unlisted ones (`listed: false`, e.g. "Not yet" in the test). Decide whether that's intended and write it down; then test it either way.
- **A send that fails mid-way stays `sending`.** If something other than delivery throws (for example `renderEmail`), the update is stuck and can't be resent. That fails closed (no double email), but there's no way out short of editing the status. Decide the recovery path.
- **The README's "Upgrading from 0.1"** says the package was briefly named `@extantape/payload-plugin-sponsors`, which is its current name; it presumably means `payload-plugin-sponsor`. A doc fix.
- `scopeField`: a test that A–Z placement stays within one owner on a multi-tenant setup.
