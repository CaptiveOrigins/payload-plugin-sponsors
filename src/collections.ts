import type { Access, CollectionConfig, FieldAccess, Where } from 'payload'

import type { ResolvedSponsors } from './types.js'

const notArchived: Where = { or: [{ archivedAt: { exists: false } }, { archivedAt: { equals: null } }] }
/** Public: listed and not archived. */
export const publicSponsors: Where = { and: [{ listed: { equals: true } }, notArchived] }

export function sponsorsCollection(o: ResolvedSponsors): CollectionConfig {
  const manager: Access = async ({ req }) => Boolean(req.user) && (await o.canManage({ req }))
  const managerField: FieldAccess = async ({ req }) => Boolean(req.user) && (await o.canManage({ req }))
  // Everyone reads published, current sponsors; managers read everything.
  const read: Access = async ({ req }) => {
    if (req.user && (await o.canManage({ req }))) return true
    return publicSponsors
  }
  return {
    slug: o.sponsors,
    labels: { singular: 'Sponsor', plural: 'Sponsors' },
    admin: {
      useAsTitle: 'name',
      defaultColumns: ['name', ...(o.tiers ? ['tier'] : []), 'attribution', 'order', 'listed'],
      description: 'Shown on your sponsors page, in order. Use the sponsor’s own name, logo and wording. Contacts are private.',
    },
    access: { read, create: manager, update: manager, delete: manager },
    // No drafts: opt-outs, archiving and "last update sent" change sponsors on their own; a switch decides visibility.
    defaultSort: 'order',
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
      {
        type: 'row',
        fields: [
          { name: 'since', type: 'date', admin: { width: '50%', date: { pickerAppearance: 'monthOnly', displayFormat: 'MMMM yyyy' } } },
          { name: 'order', type: 'number', defaultValue: 100, admin: { width: '50%', description: 'Lower comes first.' } },
        ],
      },
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
  const manager: Access = async ({ req }) => Boolean(req.user) && (await o.canManage({ req }))
  return {
    slug: o.tiers,
    labels: { singular: 'Sponsor tier', plural: 'Sponsor tiers' },
    admin: { useAsTitle: 'name', defaultColumns: ['name', 'order'], description: 'Optional levels (e.g. Founding, Gold). Lower order is shown first.' },
    access: { read: () => true, create: manager, update: manager, delete: manager },
    defaultSort: 'order',
    fields: [
      {
        type: 'row',
        fields: [
          { name: 'name', type: 'text', required: true, admin: { width: '50%' } },
          { name: 'order', type: 'number', defaultValue: 100, admin: { width: '25%' } },
          { name: 'color', type: 'text', admin: { width: '25%', description: 'Badge color, e.g. #cf8137.' } },
        ],
      },
      { name: 'description', type: 'textarea', admin: { description: 'Shown above the tier on the public page.' } },
      { name: 'perks', type: 'array', admin: { description: 'What this tier includes (for your records and pages).' }, fields: [{ name: 'perk', type: 'text', required: true }] },
    ],
    timestamps: true,
  }
}

export function updatesCollection(o: ResolvedSponsors, userSlug: string): CollectionConfig {
  const manager: Access = async ({ req }) => Boolean(req.user) && (await o.canManage({ req }))
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
        admin: { position: 'sidebar', components: { Field: '@captiveorigins/payload-plugin-sponsors/client#SendUpdateButton' } },
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
            ],
            admin: { readOnly: true },
          },
          { name: 'sentAt', type: 'date', admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } } },
        ],
      },
      { name: 'sentBy', type: 'relationship', relationTo: userSlug as never, admin: { position: 'sidebar', readOnly: true } },
      { name: 'report', type: 'json', admin: { position: 'sidebar', readOnly: true, description: 'Sponsors and counts (no addresses).' } },
    ],
    timestamps: true,
  }
}
