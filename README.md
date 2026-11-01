# payload-plugin-sponsors

Sponsors for [Payload](https://payloadcms.com): a public sponsor list with optional tiers,
private contacts, and **sponsor updates written and sent from the admin**.

- **Sponsors**: name, logo, website, attribution line, summary, since, order, tier, and a
  “Show on the public page” switch. **Contacts** (one or more emails per sponsor) are visible
  to managers only, never in the public API.
- **Tiers** (optional): Founding, Gold… with order, color, description and perks.
- **Sponsor updates**: subject and rich-text body in the admin’s own editor; send to all
  current sponsors, chosen sponsors and/or whole tiers. The admin shows who it will reach and
  asks to confirm. Every contact gets their own email with a signed **opt-out link**; opted-out
  contacts and archived sponsors are skipped. Each update keeps a report (counts per sponsor,
  never addresses) and can’t be sent twice.
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

## License

MIT
