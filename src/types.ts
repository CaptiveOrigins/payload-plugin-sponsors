import type { CollectionConfig, Payload, PayloadRequest } from 'payload'

/** Who may manage sponsors and send updates (default: any signed-in user). */
export type CanManage = (args: { req: PayloadRequest }) => boolean | Promise<boolean>

/** One email to one sponsor contact. Default: `payload.sendEmail`. */
export type SendEmail = (args: { payload: Payload; to: string; subject: string; html: string; text: string; replyTo?: string }) => Promise<void>

export type SponsorsPluginOptions = {
  /** Slugs. Defaults: `sponsors`, `sponsor-tiers` (false: no tiers), `sponsor-updates`. */
  slugs?: { sponsors?: string; tiers?: string | false; updates?: string }
  /** Upload collection for logos. Default `media`. */
  uploads?: string
  /** Who manages sponsors, sees contacts and sends updates. */
  canManage?: CanManage
  /** May updates be sent from this environment right now? (e.g. off in development). Default: always. */
  canSend?: (args: { payload: Payload }) => boolean | Promise<boolean>
  /** Delivery. Default `payload.sendEmail`. */
  sendEmail?: SendEmail
  /** Wraps an update's body in your email layout (branding, footer). The opt-out link is already in `html`. */
  renderEmail?: (args: { subject: string; html: string; text: string; sponsorName: string }) => { html: string; text: string }
  /** Reply-To for updates (e.g. your partnerships address). */
  replyTo?: string
  /** Public origin for opt-out links. Default: `serverURL` of the Payload config. */
  publicURL?: string
  /** Change the generated collections (e.g. add fields, admin groups) before they are added. */
  overrides?: { sponsors?: (c: CollectionConfig) => CollectionConfig; tiers?: (c: CollectionConfig) => CollectionConfig; updates?: (c: CollectionConfig) => CollectionConfig }
  /** Add the Sponsors overview in the admin (/admin/sponsors). Default true. */
  adminView?: boolean
  /** A field that separates owners (e.g. `tenant` with multi-tenancy): new sponsors are placed alphabetically among their own. */
  scopeField?: string
}

export type ResolvedSponsors = {
  sponsors: string
  tiers: string | false
  updates: string
  uploads: string
  canManage: CanManage
  canSend?: SponsorsPluginOptions['canSend']
  sendEmail?: SendEmail
  renderEmail?: SponsorsPluginOptions['renderEmail']
  replyTo?: string
  publicURL?: string
  adminView: boolean
  scopeField?: string
}

/** A listing created by another plugin (e.g. memberships): identified by `source` + `externalRef`. */
export type ExternalListing = {
  source: string
  externalRef: string
  name: string
  tier?: string | null
  website?: string | null
  attribution?: string | null
  summary?: string | null
  contacts?: { name?: string | null; email: string }[]
  /** Extra data for the host's own fields (e.g. `tenant`). */
  data?: Record<string, unknown>
}
