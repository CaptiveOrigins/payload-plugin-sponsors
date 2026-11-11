import crypto from 'node:crypto'

import type { CollectionSlug, Payload, Where } from 'payload'

import { publicSponsors } from './collections.js'
import type { ExternalListing, ResolvedSponsors } from './types.js'

export const sponsorsOf = (payload: Payload) => payload.config.custom?.sponsors as ResolvedSponsors
const idOf = (v: unknown) => (v && typeof v === 'object' ? String((v as { id: unknown }).id) : v ? String(v) : null)
const notArchived: Where = { or: [{ archivedAt: { exists: false } }, { archivedAt: { equals: null } }] }

type Contact = { id?: string; name?: string | null; email: string; optedOut?: boolean | null; optedOutAt?: string | null }
type SponsorDoc = { id: string; name: string; tier?: unknown; archivedAt?: string | null; contacts?: Contact[] | null }

// ---------------------------------------------------------------- opt-out links

const mac = (payload: Payload, body: string) => crypto.createHmac('sha256', payload.secret).update(`sponsors-opt-out:${body}`).digest('base64url')

/** A link that stops updates for one contact of one sponsor (no expiry; signed with the Payload secret). */
export function optOutToken(payload: Payload, sponsorId: string, email: string) {
  const body = Buffer.from(JSON.stringify([sponsorId, email.toLowerCase()])).toString('base64url')
  return `${body}.${mac(payload, body)}`
}

export async function optOut(payload: Payload, token: string): Promise<boolean> {
  const [body, sig] = String(token).split('.')
  if (!body || !sig) return false
  const expected = mac(payload, body)
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false
  const [sponsorId, email] = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as [string, string]
  const o = sponsorsOf(payload)
  const sponsor = (await payload.findByID({ collection: o.sponsors as CollectionSlug, id: sponsorId, depth: 0, overrideAccess: true, disableErrors: true })) as SponsorDoc | null
  if (!sponsor) return false
  const contacts = (sponsor.contacts ?? []).map((c) => (c.email.toLowerCase() === email && !c.optedOut ? { ...c, optedOut: true, optedOutAt: new Date().toISOString() } : c))
  await payload.update({ collection: o.sponsors as CollectionSlug, id: sponsorId, data: { contacts } as never, overrideAccess: true, context: { sponsorsInternal: true } })
  return true
}

// ---------------------------------------------------------------- public list

export type SponsorGroup<T> = { tier: { id: string; name: string; description?: string | null; color?: string | null } | null; sponsors: T[] }

/** Listed, current sponsors, grouped by tier (tier order, then sponsor order); ungrouped last. Contacts never included. */
export async function getSponsors<T = Record<string, unknown>>(payload: Payload, opts: { where?: Where; locale?: string; depth?: number } = {}): Promise<SponsorGroup<T>[]> {
  const o = sponsorsOf(payload)
  const { docs } = await payload.find({
    collection: o.sponsors as CollectionSlug,
    where: { and: [publicSponsors, ...(opts.where ? [opts.where] : [])] },
    sort: '_order',
    depth: opts.depth ?? 1,
    pagination: false,
    overrideAccess: true,
    locale: opts.locale as never,
    select: { contacts: false } as never,
  })
  const tiers = o.tiers
    ? ((await payload.find({ collection: o.tiers as CollectionSlug, sort: '_order', pagination: false, depth: 0, overrideAccess: true, locale: opts.locale as never })).docs as unknown as {
        id: string
        name: string
        description?: string | null
        color?: string | null
      }[])
    : []
  const groups: SponsorGroup<T>[] = tiers.map((t) => ({ tier: { id: String(t.id), name: t.name, description: t.description ?? null, color: t.color ?? null }, sponsors: [] }))
  const none: SponsorGroup<T> = { tier: null, sponsors: [] }
  for (const s of docs as unknown as (T & { tier?: unknown })[]) (groups.find((g) => g.tier?.id === idOf(s.tier)) ?? none).sponsors.push(s)
  return [...groups, none].filter((g) => g.sponsors.length)
}

// ---------------------------------------------------------------- listings from other plugins (memberships)

/** Creates or updates a listing owned by another plugin (listed right away). Returns its ID. */
export async function upsertListing(payload: Payload, listing: ExternalListing): Promise<string> {
  const o = sponsorsOf(payload)
  const { docs } = await payload.find({
    collection: o.sponsors as CollectionSlug,
    where: { and: [{ source: { equals: listing.source } }, { externalRef: { equals: listing.externalRef } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const data = {
    ...(listing.data ?? {}),
    name: listing.name,
    source: listing.source,
    externalRef: listing.externalRef,
    ...(listing.tier !== undefined && o.tiers ? { tier: listing.tier } : {}),
    ...(listing.website !== undefined ? { website: listing.website } : {}),
    ...(listing.attribution !== undefined ? { attribution: listing.attribution } : {}),
    ...(listing.summary !== undefined ? { summary: listing.summary } : {}),
    ...(listing.contacts ? { contacts: listing.contacts.map((c) => ({ name: c.name ?? null, email: c.email })) } : {}),
    archivedAt: null,
    listed: true,
  }
  const ctx = { context: { sponsorsInternal: true }, overrideAccess: true }
  const doc = docs[0]
    ? await payload.update({ collection: o.sponsors as CollectionSlug, id: docs[0].id, data: data as never, ...ctx })
    : await payload.create({ collection: o.sponsors as CollectionSlug, data: data as never, ...ctx })
  return String(doc.id)
}

/** Archives a listing owned by another plugin (e.g. the membership ended). */
export async function retireListing(payload: Payload, source: string, externalRef: string) {
  const o = sponsorsOf(payload)
  await payload.update({
    collection: o.sponsors as CollectionSlug,
    where: { and: [{ source: { equals: source } }, { externalRef: { equals: externalRef } }, notArchived] },
    data: { archivedAt: new Date().toISOString() } as never,
    overrideAccess: true,
    context: { sponsorsInternal: true },
  })
}

/** Archive (hidden from the public page, history kept) or restore a sponsor. */
export async function setArchived(payload: Payload, id: string, archived: boolean) {
  const o = sponsorsOf(payload)
  await payload.update({ collection: o.sponsors as CollectionSlug, id, data: { archivedAt: archived ? new Date().toISOString() : null } as never, overrideAccess: true, context: { sponsorsInternal: true } })
}

// ---------------------------------------------------------------- sending updates

export type SendStatus = 'sent' | 'partial' | 'failed'
/**
 * What one send did (counts, never addresses). `alreadySent` counts contacts an
 * earlier, unfinished send reached, who were not emailed again. `stoppedEarly`
 * means something other than one delivery failed and the rest weren't tried.
 */
export type SendReport = {
  status: SendStatus
  sponsors: { id: string; name: string; sent: number; skipped: number; failed: number; alreadySent: number }[]
  sent: number
  skipped: number
  failed: number
  alreadySent: number
  stoppedEarly?: boolean
}

/** Statuses an update may be sent from: a draft, or a send that didn't reach everyone. */
export const sendableStatuses = ['draft', 'partial', 'failed'] as const

/**
 * Marks one contact of one sponsor as delivered for an update. A keyed hash, so
 * the update keeps no addresses; the same contact always gives the same key.
 */
export const deliveryKey = (payload: Payload, sponsorId: string, email: string) =>
  crypto.createHmac('sha256', payload.secret).update(`sponsors-delivered:${JSON.stringify([sponsorId, email.toLowerCase()])}`).digest('base64url')

/** The current sponsors an update goes to (all, or the chosen sponsors and tiers). */
export async function recipientsOf(payload: Payload, update: { recipients?: { all?: boolean | null; sponsors?: unknown[] | null; tiers?: unknown[] | null } | null }) {
  const o = sponsorsOf(payload)
  const r = update.recipients ?? {}
  const chosen = (r.sponsors ?? []).map(idOf).filter(Boolean) as string[]
  const tiers = (r.tiers ?? []).map(idOf).filter(Boolean) as string[]
  if (!r.all && !chosen.length && !tiers.length) return []
  const or: Where[] = []
  if (chosen.length) or.push({ id: { in: chosen } })
  if (tiers.length && o.tiers) or.push({ tier: { in: tiers } })
  const { docs } = await payload.find({
    collection: o.sponsors as CollectionSlug,
    where: { and: [notArchived, ...(r.all ? [] : [{ or }])] },
    depth: 0,
    pagination: false,
    overrideAccess: true,
  })
  return docs as unknown as SponsorDoc[]
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const textOf = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|div)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** The update body as HTML (Lexical rich text). */
async function bodyHtml(body: unknown): Promise<string> {
  if (typeof body === 'string') return body
  if (!body || typeof body !== 'object') return ''
  const { convertLexicalToHTML } = await import('@payloadcms/richtext-lexical/html')
  return convertLexicalToHTML({ data: body as never })
}

/**
 * Sends an update: one email per contact of each recipient sponsor, each with
 * its own opt-out link. Archived sponsors and opted-out contacts are skipped.
 * Records who got it (counts, never addresses) and marks the update sent.
 */
export async function sendUpdate(payload: Payload, updateId: string, userId?: string | number | null): Promise<SendReport> {
  const o = sponsorsOf(payload)
  if (o.canSend && !(await o.canSend({ payload }))) throw new Error('Sending sponsor updates is turned off here.')
  type UpdateDoc = {
    id: string
    subject: string
    body: unknown
    status?: string
    delivered?: unknown
    recipients?: { all?: boolean; sponsors?: unknown[]; tiers?: unknown[] }
  }
  const read = async () => (await payload.findByID({ collection: o.updates as CollectionSlug, id: updateId, depth: 0, overrideAccess: true })) as unknown as UpdateDoc
  const refusal = (status?: string) => new Error(status === 'sending' ? 'This update is already sending.' : 'This update was already sent.')
  const first = await read()
  if (!sendableStatuses.includes((first.status ?? 'draft') as never)) throw refusal(first.status)
  const sponsors = await recipientsOf(payload, first)
  if (!sponsors.length) throw new Error('Choose at least one sponsor or tier (or all current sponsors).')
  // Claim it in one conditional write: only one send can move it to "sending".
  const claimed = await payload.db.updateOne({
    collection: o.updates as CollectionSlug,
    where: { and: [{ id: { equals: updateId } }, { status: { in: [...sendableStatuses] } }] },
    data: { status: 'sending' },
  })
  if (!claimed) throw refusal((await read()).status)

  const report: SendReport = { status: 'sent', sponsors: [], sent: 0, skipped: 0, failed: 0, alreadySent: 0 }
  const now = new Date().toISOString()
  let delivered = new Set<string>()
  // Whatever happens after the claim, record who got it, so a resend reaches only the rest.
  const finish = async (stoppedEarly: boolean) => {
    for (const k of ['sent', 'skipped', 'failed', 'alreadySent'] as const) report[k] = report.sponsors.reduce((n, r) => n + r[k], 0)
    if (stoppedEarly) report.stoppedEarly = true
    report.status = !stoppedEarly && !report.failed ? 'sent' : delivered.size ? 'partial' : 'failed'
    await payload.update({
      collection: o.updates as CollectionSlug,
      id: updateId,
      data: { status: report.status, sentAt: now, sentBy: userId ?? null, report, delivered: [...delivered] } as never,
      overrideAccess: true,
    })
  }
  try {
    const update = await read()
    delivered = new Set(Array.isArray(update.delivered) ? update.delivered.filter((k): k is string => typeof k === 'string') : [])
    const html = await bodyHtml(update.body)
    const origin = (o.publicURL || payload.config.serverURL || '').replace(/\/$/, '')
    const apiRoute = payload.config.routes.api
    const deliver =
      o.sendEmail ?? (async ({ payload: p, to, subject, html: h, text, replyTo }) => void (await p.sendEmail({ to, subject, html: h, text, ...(replyTo ? { replyTo } : {}) })))
    for (const s of sponsors) {
      const row = { id: String(s.id), name: s.name, sent: 0, skipped: 0, failed: 0, alreadySent: 0 }
      report.sponsors.push(row)
      for (const c of s.contacts ?? []) {
        if (c.optedOut || !c.email) {
          row.skipped++
          continue
        }
        const key = deliveryKey(payload, String(s.id), c.email)
        if (delivered.has(key)) {
          row.alreadySent++
          continue
        }
        const link = `${origin}${apiRoute}/${o.sponsors}/opt-out?t=${encodeURIComponent(optOutToken(payload, String(s.id), c.email))}`
        const withFooter = `${html}<hr><p style="font-size:12px;color:#666">You receive these updates as a contact for ${escapeHtml(s.name)}. <a href="${link}">Stop these updates</a>.</p>`
        const text = `${textOf(html)}\n\n—\nYou receive these updates as a contact for ${s.name}. Stop these updates: ${link}`
        const finished = o.renderEmail ? o.renderEmail({ subject: update.subject, html: withFooter, text, sponsorName: s.name }) : { html: withFooter, text }
        try {
          await deliver({ payload, to: c.email, subject: update.subject, html: finished.html, text: finished.text, replyTo: o.replyTo })
          delivered.add(key)
          row.sent++
        } catch (err) {
          payload.logger.warn({ err, sponsor: s.id }, 'Sponsors: an update could not be delivered')
          row.failed++
        }
      }
      if (row.sent)
        await payload.update({ collection: o.sponsors as CollectionSlug, id: s.id, data: { lastUpdateAt: now } as never, overrideAccess: true, context: { sponsorsInternal: true } })
    }
  } catch (err) {
    await finish(true)
    payload.logger.error({ err, update: updateId, sent: report.sent }, 'Sponsors: sending stopped partway')
    const n = delivered.size
    throw new Error(
      `Sending stopped partway: ${n} contact${n === 1 ? ' has' : 's have'} it so far. The update is marked ${report.status === 'partial' ? 'partly sent' : 'failed'}; send it again to reach only the rest.`,
      { cause: err },
    )
  }
  await finish(false)
  payload.logger.info({ update: updateId, status: report.status, sent: report.sent, skipped: report.skipped, failed: report.failed }, 'Sponsors: update sent')
  return report
}
