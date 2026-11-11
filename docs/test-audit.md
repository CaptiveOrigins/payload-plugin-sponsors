# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md` "Test self-audits". Newest first.

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
- **The README's "Upgrading from 0.1"** says the package was briefly named `@captiveorigins/payload-plugin-sponsors`, which is its current name; it presumably means `payload-plugin-sponsor`. A doc fix.
- `scopeField`: a test that A–Z placement stays within one owner on a multi-tenant setup.
