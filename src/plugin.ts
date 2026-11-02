import type { Config, Plugin } from 'payload'

import { sponsorsCollection, tiersCollection, updatesCollection } from './collections.js'
import { archiveEndpoint, optOutEndpoint, recipientsEndpoint, sendEndpoint } from './endpoints.js'
import type { ResolvedSponsors, SponsorsPluginOptions } from './types.js'

/**
 * Sponsors: a public sponsor list (optional tiers), private contacts, and
 * sponsor updates written in the admin's rich-text editor and sent to chosen
 * sponsors or tiers, each contact with an opt-out link. Archive-first removal.
 * Other plugins (e.g. memberships) can list their members through
 * `upsertListing` / `retireListing`.
 */
export const sponsorsPlugin =
  (options: SponsorsPluginOptions = {}): Plugin =>
  (config: Config): Config => {
    const o: ResolvedSponsors = {
      sponsors: options.slugs?.sponsors ?? 'sponsors',
      tiers: options.slugs?.tiers === false ? false : (options.slugs?.tiers ?? 'sponsor-tiers'),
      updates: options.slugs?.updates ?? 'sponsor-updates',
      uploads: options.uploads ?? 'media',
      canManage: options.canManage ?? (({ req }) => Boolean(req.user)),
      canSend: options.canSend,
      sendEmail: options.sendEmail,
      renderEmail: options.renderEmail,
      replyTo: options.replyTo,
      publicURL: options.publicURL,
      adminView: options.adminView ?? true,
      scopeField: options.scopeField,
    }
    const userSlug = config.admin?.user ?? 'users'
    const sponsors = { ...sponsorsCollection(o), endpoints: [optOutEndpoint, archiveEndpoint] }
    const updates = { ...updatesCollection(o, userSlug), endpoints: [recipientsEndpoint, sendEndpoint] }
    const added = [
      options.overrides?.sponsors ? options.overrides.sponsors(sponsors) : sponsors,
      ...(o.tiers ? [options.overrides?.tiers ? options.overrides.tiers(tiersCollection({ ...o, tiers: o.tiers })) : tiersCollection({ ...o, tiers: o.tiers })] : []),
      options.overrides?.updates ? options.overrides.updates(updates) : updates,
    ]
    const components = config.admin?.components ?? {}
    return {
      ...config,
      custom: { ...config.custom, sponsors: o },
      collections: [...(config.collections ?? []).filter((c) => !added.some((a) => a.slug === c.slug)), ...added],
      admin: o.adminView
        ? {
            ...config.admin,
            components: {
              ...components,
              afterNavLinks: [...(components.afterNavLinks ?? []), '@captiveorigins/payload-plugin-sponsor/rsc#SponsorsNavLink'],
              views: { ...components.views, sponsors: { Component: '@captiveorigins/payload-plugin-sponsor/rsc#SponsorsView', path: '/sponsors' } },
            },
          }
        : config.admin,
    }
  }
