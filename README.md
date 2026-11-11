# payload-plugin-sponsors

Sponsors for [Payload](https://payloadcms.com): a public sponsor list with optional tiers,
private contacts, and **sponsor updates written and sent from the admin**.

- **Sponsors**: name, logo, website, attribution line, summary, since, tier, and a
  “Show on the public page” switch. Ordered by drag and drop in the admin; new sponsors are
  placed alphabetically, so the default order is A–Z. **Contacts** (one or more emails per sponsor) are visible
  to managers only, never in the public API.
- **Tiers** (optional): Founding, Gold… with color, description and perks, ordered by drag and drop.
- **Sponsor updates**: subject and rich-text body in the admin’s own editor; send to all
  current sponsors, chosen sponsors and/or whole tiers. "All current sponsors" means every
  sponsor that isn't archived, listed on the public page or not. The admin shows who it will
  reach and asks to confirm. Every contact gets their own email with a signed **opt-out link**;
  opted-out contacts and archived sponsors are skipped. Each update keeps a report (counts per
  sponsor, never addresses) and can’t be sent twice: if two sends start at once, only one goes
  out and the other is refused.
- **When a send doesn't finish**: if a delivery fails, or something breaks partway, the update is
  marked **Partly sent** (or **Failed** if nobody got it) and the report says so. Sending it again
  reaches only the contacts who haven't had it; nobody gets it twice. The update remembers who
  had it as keyed hashes, not addresses. If the server itself stops mid-send, the update stays
  **Sending**; that case has no automatic way out yet.
- **Archive first**: archiving hides a sponsor from the public page and from updates while
  keeping their history; restore any time. Deleting stays available for mistakes.
- **Overview** at `/admin/sponsors`: logos by tier, add, archive/restore, email sponsors.
- **For membership plugins**: `upsertListing()` / `retireListing()` list members as sponsors
  (for example, a paid tier with a sponsor-wall perk) and remove them when they leave.

## Install

```bash
npm install @captiveorigins/payload-plugin-sponsors
```

```ts
import { sponsorsPlugin } from '@captiveorigins/payload-plugin-sponsors'

export default buildConfig({
  editor: lexicalEditor(),
  plugins: [
    sponsorsPlugin({
      canManage: ({ req }) => req.user?.role === 'admin',
      replyTo: 'partners@example.org',
      // Optional: your email layout around the update.
      renderEmail: ({ html, text }) => ({ html: myLayout(html), text }),
    }),
  ],
})
```

Show them on your site:

```ts
import { getSponsors } from '@captiveorigins/payload-plugin-sponsors'

const groups = await getSponsors(payload) // [{ tier: { name, … } | null, sponsors: [...] }]
```

## Options

| Option | Default | |
|---|---|---|
| `slugs` | `sponsors`, `sponsor-tiers`, `sponsor-updates` | `tiers: false` turns tiers off |
| `uploads` | `media` | Collection for logos |
| `canManage` | signed-in users | Who manages sponsors, sees contacts and sends updates |
| `canSend` | always | E.g. off in development |
| `sendEmail` | `payload.sendEmail` | Deliver one email |
| `renderEmail` | | Wrap the update in your layout |
| `replyTo` | | Reply-To on updates |
| `publicURL` | `serverURL` | Origin for opt-out links |
| `overrides` | | Adjust the generated collections (e.g. multi-tenant fields) |
| `adminView` | `true` | The `/admin/sponsors` overview and nav link |
| `scopeField` | | Field separating owners (e.g. `tenant`): new sponsors are placed A–Z among their own |

## Upgrading from 0.1

Version 0.2.0 was briefly named `@captiveorigins/payload-plugin-sponsor` (singular). If you used
that name, install `@captiveorigins/payload-plugin-sponsors` instead; the exports are unchanged,
so only the import path changes.


0.2 replaces the numeric `order` fields with drag-and-drop ordering (Payload `orderable`, field
`_order`). Give existing sponsors and tiers an `_order` once (e.g. with `generateNKeysBetween` from
`payload/shared`, sponsors A–Z, tiers in their old order).

## License

MIT
