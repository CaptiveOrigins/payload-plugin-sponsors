import type { Access, CollectionBeforeChangeHook, CollectionConfig, FieldAccess, Where } from 'payload'
import { generateKeyBetween } from 'payload/shared'

import { isManager } from './access.js'
import type { ResolvedSponsors } from './types.js'

const notArchived: Where = { or: [{ archivedAt: { exists: false } }, { archivedAt: { equals: null } }] }
/** Public: listed and not archived. */
export const publicSponsors: Where = { and: [{ listed: { equals: true } }, notArchived] }

/**
 * Sponsors are drag-and-drop ordered (Payload `orderable`); a new one goes between its
 * alphabetical neighbours (within `scopeField`), so the default order is A–Z.
 */
const placeAlphabetically =
  (o: ResolvedSponsors): CollectionBeforeChangeHook =>
  async ({ data, operation, req }) => {
    if (operation !== 'create' || data._order || !data.name) return data
    const scope = o.scopeField ? data[o.scopeField] : undefined
    const scopeId = scope && typeof scope === 'object' ? (scope as { id: unknown }).id : scope
    const { docs } = await req.payload.find({
      collection: o.sponsors as never,
      where: o.scopeField && scopeId ? { [o.scopeField]: { equals: scopeId } } : {},
      sort: '_order',
      depth: 0,
      pagination: false,
      overrideAccess: true,
      select: { name: true, _order: true } as never,
      req,
    })
    const ordered = docs as unknown as { name: string; _order?: string }[]
    const next = ordered.findIndex((d) => String(d.name).localeCompare(String(data.name), 'en', { sensitivity: 'base' }) > 0)
    const before = next === -1 ? (ordered.at(-1)?._order ?? null) : next > 0 ? (ordered[next - 1]!._order ?? null) : null
    const after = next === -1 ? null : (ordered[next]!._order ?? null)
    try {
      data._order = generateKeyBetween(before, after)
    } catch {
      // Neighbours out of order after manual moves: Payload appends it at the end instead.
    }
    return data
  }

export function sponsorsCollection(o: ResolvedSponsors): CollectionConfig {
  // Only an exact `true` from `canManage` makes a manager; a truthy value or a thrown error is a no.
  const manager: Access = ({ req }) => isManager(o, req)
  const managerField: FieldAccess = ({ req }) => isManager(o, req)
  // Everyone reads published, current sponsors (the plugin's own query); managers read everything.
  // The site's answer is never passed through, so a truthy non-`true` can't widen this to all rows.
  const read: Access = async ({ req }) => ((await isManager(o, req)) ? true : publicSponsors)
  return {
    slug: o.sponsors,
    labels: { singular: 'Sponsor', plural: 'Sponsors' },
    admin: {
      useAsTitle: 'name',
      defaultColumns: ['name', ...(o.tiers ? ['tier'] : []), 'attribution', 'listed'],
      description: 'Shown on your sponsors page in this order (A–Z for new sponsors; drag rows to change it). Use the sponsor’s own name, logo and wording. Contacts are private.',
    },
    access: { read, create: manager, update: manager, delete: manager },
    // No drafts: opt-outs, archiving and "last update sent" change sponsors on their own; a switch decides visibility.
    orderable: true,
    defaultSort: '_order',
    hooks: { beforeChange: [placeAlphabetically(o)] },
    fields: [
      { name: 'name', type: 'text', required: true, admin: { description: 'Exactly as the sponsor wants it shown.' } },
      {
        name: 'listed',
        label: 'Show on the public page',
        type: 'checkbox',
        defaultValue: false,
        index: true,
        admin: { position: 'sidebar', description: 'Turn on once the logo and wording are approved.' },
      },
      {
        type: 'row',
        fields: [
          { name: 'logo', type: 'upload', relationTo: o.uploads as never, admin: { width: '50%', description: 'Their logo, with permission.' } },
          { name: 'website', type: 'text', admin: { width: '50%', description: 'https://…' } },
        ],
      },
      ...(o.tiers ? [{ name: 'tier', type: 'relationship' as const, relationTo: o.tiers as never, admin: { position: 'sidebar' as const } }] : []),
      { name: 'attribution', type: 'text', admin: { description: 'Short line, e.g. “Founding sponsor”.' } },
      { name: 'summary', type: 'textarea', admin: { description: 'Who they are and what they support, in a few sentences.' } },
      { name: 'since', type: 'date', admin: { date: { pickerAppearance: 'monthOnly', displayFormat: 'MMMM yyyy' } } },
      {
        name: 'contacts',
        type: 'array',
        access: { read: managerField, create: managerField, update: managerField },
        admin: { description: 'Who receives sponsor updates. Never shown publicly.', initCollapsed: false },
        fields: [
          {
            type: 'row',
            fields: [
              { name: 'name', type: 'text', admin: { width: '35%' } },
              { name: 'email', type: 'email', required: true, admin: { width: '45%' } },
              { name: 'optedOut', label: 'Opted out', type: 'checkbox', admin: { width: '20%', description: 'No more updates (set by their opt-out link).' } },
            ],
          },
          { name: 'optedOutAt', type: 'date', admin: { readOnly: true, condition: (_, s) => Boolean(s?.optedOut) } },
        ],
      },
      {
        name: 'archivedAt',
        type: 'date',
        index: true,
        admin: { position: 'sidebar', readOnly: true, description: 'Archived sponsors are hidden from the public page; their history stays.' },
      },
      // Listings managed by another plugin (e.g. memberships) carry where they came from.
      { name: 'source', type: 'text', defaultValue: 'manual', index: true, admin: { position: 'sidebar', readOnly: true } },
      { name: 'externalRef', type: 'text', index: true, admin: { position: 'sidebar', readOnly: true, condition: (d) => Boolean(d?.externalRef) } },
      { name: 'lastUpdateAt', label: 'Last update sent', type: 'date', admin: { position: 'sidebar', readOnly: true } },
    ],
    timestamps: true,
  }
}

export function tiersCollection(o: ResolvedSponsors & { tiers: string }): CollectionConfig {
  const manager: Access = ({ req }) => isManager(o, req)
  return {
    slug: o.tiers,
    labels: { singular: 'Sponsor tier', plural: 'Sponsor tiers' },
    admin: { useAsTitle: 'name', defaultColumns: ['name', 'color'], description: 'Optional levels (e.g. Founding, Gold), shown in this order: drag rows to change it.' },
    access: { read: () => true, create: manager, update: manager, delete: manager },
    orderable: true,
    defaultSort: '_order',
    fields: [
      {
        type: 'row',
        fields: [
          { name: 'name', type: 'text', required: true, admin: { width: '60%' } },
          { name: 'color', type: 'text', admin: { width: '40%', description: 'Badge color, e.g. #cf8137.' } },
        ],
      },
      { name: 'description', type: 'textarea', admin: { description: 'Shown above the tier on the public page.' } },
      { name: 'perks', type: 'array', admin: { description: 'What this tier includes (for your records and pages).' }, fields: [{ name: 'perk', type: 'text', required: true }] },
    ],
    timestamps: true,
  }
}

export function updatesCollection(o: ResolvedSponsors, userSlug: string): CollectionConfig {
  const manager: Access = ({ req }) => isManager(o, req)
  return {
    slug: o.updates,
    labels: { singular: 'Sponsor update', plural: 'Sponsor updates' },
    // Not "SponsorUpdate": that clashes with the Sponsors collection's own update mutation input.
    graphQL: { singularName: 'SponsorMailing', pluralName: 'SponsorMailings' },
    admin: {
      useAsTitle: 'subject',
      defaultColumns: ['subject', 'status', 'sentAt'],
      description: 'Write an update and send it to some or all sponsors. Each contact gets their own email with an opt-out link.',
    },
    access: { read: manager, create: manager, update: manager, delete: manager },
    fields: [
      { name: 'subject', type: 'text', required: true },
      { name: 'body', type: 'richText', required: true },
      {
        name: 'recipients',
        type: 'group',
        fields: [
          { name: 'all', label: 'All current sponsors', type: 'checkbox', defaultValue: false },
          {
            name: 'sponsors',
            type: 'relationship',
            relationTo: o.sponsors as never,
            hasMany: true,
            admin: { condition: (_, s) => !s?.all, description: 'Choose sponsors…' },
          },
          ...(o.tiers
            ? [{ name: 'tiers', type: 'relationship' as const, relationTo: o.tiers as never, hasMany: true, admin: { condition: (_: unknown, s: { all?: boolean }) => !s?.all, description: '…and/or whole tiers.' } }]
            : []),
        ],
      },
      {
        name: 'send',
        type: 'ui',
        admin: { position: 'sidebar', components: { Field: '@extantape/payload-plugin-sponsors/client#SendUpdateButton' } },
      },
      {
        type: 'row',
        admin: { position: 'sidebar' },
        fields: [
          {
            name: 'status',
            type: 'select',
            defaultValue: 'draft',
            options: [
              { label: 'Draft', value: 'draft' },
              { label: 'Sending', value: 'sending' },
              { label: 'Sent', value: 'sent' },
              // A send that didn't reach everyone: sending again reaches only those it missed.
              { label: 'Partly sent', value: 'partial' },
              { label: 'Failed', value: 'failed' },
            ],
            admin: { readOnly: true },
          },
          { name: 'sentAt', type: 'date', admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } } },
        ],
      },
      // The send's lease: set when a send claims the update and refreshed before each email. If it
      // goes stale while "sending", the server stopped mid-send and a manager can recover it.
      {
        name: 'sendingSince',
        label: 'Last sending progress',
        type: 'date',
        admin: { position: 'sidebar', readOnly: true, date: { pickerAppearance: 'dayAndTime' }, condition: (d) => d?.status === 'sending' },
      },
      { name: 'claimId', type: 'text', admin: { hidden: true, readOnly: true } },
      { name: 'sentBy', type: 'relationship', relationTo: userSlug as never, admin: { position: 'sidebar', readOnly: true } },
      { name: 'report', type: 'json', admin: { position: 'sidebar', readOnly: true, description: 'Sponsors and counts (no addresses).' } },
      // Keyed hashes of the contacts already reached (no addresses), so a resend never emails anyone twice.
      { name: 'delivered', type: 'json', admin: { hidden: true, readOnly: true } },
    ],
    timestamps: true,
  }
}
