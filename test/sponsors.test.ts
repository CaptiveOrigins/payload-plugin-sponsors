import crypto from 'node:crypto'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { sponsorsOf } from '../src/api.js'
import { archiveEndpoint, optOutEndpoint, recipientsEndpoint, sendEndpoint } from '../src/endpoints.js'
import { getSponsors, optOut, optOutToken, retireListing, sendUpdate, setArchived, sponsorsPlugin, upsertListing } from '../src/index.js'

let payload: Payload
let mongo: MongoMemoryReplSet
const mail: { to: string; subject: string; html: string; text: string }[] = []
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const lexical = (text: string) => ({ root: { type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children: [{ type: 'text', text, version: 1, format: 0 }] }] } })
let admin: Doc
let gold: Doc
let friends: Doc

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      serverURL: 'https://example.org',
      typescript: { autoGenerate: false },
      editor: lexicalEditor(),
      db: mongooseAdapter({ url: mongo.getUri('sponsors'), ensureIndexes: true }),
      collections: [
        { slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }] },
        { slug: 'media', upload: true, fields: [] },
      ],
      admin: { user: 'users' },
      plugins: [
        sponsorsPlugin({
          canManage: ({ req }) => (req.user as { role?: string } | null)?.role === 'admin',
          sendEmail: async ({ to, subject, html, text }) => void mail.push({ to, subject, html, text }),
          renderEmail: ({ html, text, sponsorName }) => ({ html: `<div class="brand">${html}</div>`, text: `${text}\n(for ${sponsorName})` }),
        }),
      ],
    }),
  })
  admin = await payload.create({ collection: 'users', data: { email: 'admin@example.org', password: 'admin-password-long', role: 'admin' } as never })
  gold = await payload.create({ collection: 'sponsor-tiers' as never, data: { name: 'Gold' } as never })
  friends = await payload.create({ collection: 'sponsor-tiers' as never, data: { name: 'Friends' } as never })
  const sponsor = (name: string, extra: Doc) => payload.create({ collection: 'sponsors' as never, data: { name, listed: true, ...extra } as never })
  await sponsor('Herp Society', { tier: gold.id, contacts: [{ name: 'Pat', email: 'pat@herp.example' }, { email: 'board@herp.example' }] })
  await sponsor('Conservation Foundation', { tier: gold.id, contacts: [{ email: 'hello@cf.example', optedOut: true }] })
  await sponsor('Local Shop', { tier: friends.id, contacts: [{ email: 'shop@shop.example' }] })
  await sponsor('Not yet', { listed: false, contacts: [{ email: 'secret@x.example' }] })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

describe('sponsors', () => {
  it('shows only listed, current sponsors publicly, by tier, and never their contacts', async () => {
    const pub = await payload.find({ collection: 'sponsors' as never, overrideAccess: false })
    expect(pub.docs.map((d: Doc) => d.name).sort()).toEqual(['Conservation Foundation', 'Herp Society', 'Local Shop'])
    // Contacts are closed to the public: no addresses, whatever shape the field takes.
    expect(JSON.stringify(pub.docs)).not.toContain('@')
    const asAdmin = await payload.find({ collection: 'sponsors' as never, overrideAccess: false, user: { ...admin, collection: 'users' } })
    expect(asAdmin.totalDocs).toBe(4)
    expect((asAdmin.docs as Doc[]).find((d) => d.name === 'Herp Society')?.contacts).toHaveLength(2)
    const groups = await getSponsors(payload)
    expect(groups.map((g) => [g.tier?.name ?? null, g.sponsors.map((s: Doc) => s.name)])).toEqual([
      // Tiers in their (drag-and-drop) order; sponsors A–Z unless moved.
      ['Gold', ['Conservation Foundation', 'Herp Society']],
      ['Friends', ['Local Shop']],
    ])
    expect(JSON.stringify(groups)).not.toContain('@')
  })

  it('sends an update to a tier: one email per contact, opted-out and archived skipped, never twice', async () => {
    const update = await payload.create({ collection: 'sponsor-updates' as never, data: { subject: 'Spring news', body: lexical('Thank you for a great season.'), recipients: { tiers: [gold.id] } } as never })
    const report = await sendUpdate(payload, String(update.id), admin.id)
    expect(report).toMatchObject({ sent: 2, skipped: 1, failed: 0 })
    expect(mail.map((m) => m.to).sort()).toEqual(['board@herp.example', 'pat@herp.example'])
    expect(mail[0]?.html).toContain('Thank you for a great season.')
    expect(mail[0]!.html).toContain('class="brand"')
    expect(mail[0]!.html).toMatch(/https:\/\/example\.org\/api\/sponsors\/opt-out\?t=/)
    expect(mail[0]!.text).toContain('(for Herp Society)')
    const saved = (await payload.findByID({ collection: 'sponsor-updates' as never, id: update.id })) as Doc
    expect(saved).toMatchObject({ status: 'sent' })
    expect(JSON.stringify(saved.report)).not.toContain('@')
    await expect(sendUpdate(payload, String(update.id))).rejects.toThrow(/already sent/)
    // Archived sponsors receive nothing.
    const shop = (await payload.find({ collection: 'sponsors' as never, where: { name: { equals: 'Local Shop' } } })).docs[0] as Doc
    await setArchived(payload, String(shop.id), true)
    mail.length = 0
    const all = await payload.create({ collection: 'sponsor-updates' as never, data: { subject: 'To all', body: lexical('Hi all'), recipients: { all: true } } as never })
    await sendUpdate(payload, String(all.id))
    expect(mail.map((m) => m.to)).not.toContain('shop@shop.example')
    expect((await getSponsors(payload)).flatMap((g) => g.sponsors.map((s: Doc) => s.name))).not.toContain('Local Shop')
  })

  it('stops updates for a contact through their signed link', async () => {
    const herp = (await payload.find({ collection: 'sponsors' as never, where: { name: { equals: 'Herp Society' } } })).docs[0] as Doc
    expect(await optOut(payload, `${optOutToken(payload, String(herp.id), 'pat@herp.example')}x`)).toBe(false)
    expect(await optOut(payload, optOutToken(payload, String(herp.id), 'PAT@herp.example'))).toBe(true)
    const after = (await payload.findByID({ collection: 'sponsors' as never, id: herp.id })) as Doc
    expect(after.contacts.find((c: Doc) => c.email === 'pat@herp.example')).toMatchObject({ optedOut: true })
    expect(after.contacts.find((c: Doc) => c.email === 'board@herp.example').optedOut).toBeFalsy()
  })

  it('lists members from another plugin and retires them when they leave', async () => {
    const id = await upsertListing(payload, { source: 'memberships', externalRef: 'm-1', name: 'Member Co', tier: String(friends.id), contacts: [{ email: 'm@member.example' }] })
    expect(await upsertListing(payload, { source: 'memberships', externalRef: 'm-1', name: 'Member Co (renamed)' })).toBe(id)
    expect((await getSponsors(payload)).flatMap((g) => g.sponsors.map((s: Doc) => s.name))).toContain('Member Co (renamed)')
    await retireListing(payload, 'memberships', 'm-1')
    expect((await getSponsors(payload)).flatMap((g) => g.sponsors.map((s: Doc) => s.name))).not.toContain('Member Co (renamed)')
  })
})

describe('the default order', () => {
  it('places each new sponsor between its alphabetical neighbours, with its own key', async () => {
    for (const name of ['Mm Beta Reptiles', 'Mm Alpha Herps', 'Mm Delta Dragons', 'Mm Gamma Geckos']) await payload.create({ collection: 'sponsors' as never, data: { name } as never })
    // `_order` is hidden from the API, so read it where it's stored.
    const raw = await (payload.db as unknown as { collections: Record<string, { find: (f: object) => { sort: (s: object) => { lean: () => Promise<{ name: string; _order?: string }[]> } } }> }).collections
      .sponsors!.find({ name: { $regex: '^Mm ' } })
      .sort({ _order: 1 })
      .lean()
    expect(raw.map((d) => d.name)).toEqual(['Mm Alpha Herps', 'Mm Beta Reptiles', 'Mm Delta Dragons', 'Mm Gamma Geckos'])
    expect(new Set(raw.map((d) => d._order)).size).toBe(4)
  })
})

describe('refusals and failures (test audit 2026-11-10)', () => {
  const asUser = (u: Doc) => ({ ...u, collection: 'users' })
  const findSponsor = async (name: string) => (await payload.find({ collection: 'sponsors' as never, where: { name: { equals: name } }, depth: 0 })).docs[0] as Doc
  const draftUpdate = (recipients: Doc, subject = 'Audit update') => payload.create({ collection: 'sponsor-updates' as never, data: { subject, body: lexical('Audit body'), recipients } as never }) as Promise<Doc>
  let member: Doc

  beforeAll(async () => {
    member = await payload.create({ collection: 'users', data: { email: 'member@example.org', password: 'member-password-long', role: 'member' } as never })
  })

  it('shows a signed-in non-manager only the public list, without contacts, and lets them change nothing', async () => {
    const seen = await payload.find({ collection: 'sponsors' as never, overrideAccess: false, user: asUser(member), pagination: false })
    expect(seen.docs.map((d: Doc) => d.name)).not.toContain('Not yet')
    expect(seen.docs.map((d: Doc) => d.name)).not.toContain('Local Shop') // archived earlier
    expect(JSON.stringify(seen.docs)).not.toContain('@')
    const herp = await findSponsor('Herp Society')
    const as = { overrideAccess: false, user: asUser(member) }
    await expect(payload.update({ collection: 'sponsors' as never, id: herp.id, data: { name: 'Hijacked', contacts: [{ email: 'attacker@evil.example' }] } as never, ...as })).rejects.toThrow()
    await expect(payload.create({ collection: 'sponsors' as never, data: { name: 'Uninvited', listed: true } as never, ...as })).rejects.toThrow()
    await expect(payload.delete({ collection: 'sponsors' as never, id: herp.id, ...as })).rejects.toThrow()
    await expect(payload.create({ collection: 'sponsor-tiers' as never, data: { name: 'Platinum' } as never, ...as })).rejects.toThrow()
    await expect(payload.find({ collection: 'sponsor-updates' as never, ...as })).rejects.toThrow()
    await expect(payload.create({ collection: 'sponsor-updates' as never, data: { subject: 'Spam', body: lexical('x'), recipients: { all: true } } as never, ...as })).rejects.toThrow()
    const after = (await payload.findByID({ collection: 'sponsors' as never, id: herp.id, depth: 0 })) as Doc
    expect(after.name).toBe('Herp Society')
    expect(after.contacts.map((c: Doc) => c.email)).not.toContain('attacker@evil.example')
    // Anonymous visitors can't read updates either.
    await expect(payload.find({ collection: 'sponsor-updates' as never, overrideAccess: false })).rejects.toThrow()
  })

  it('refuses send, recipients and archive to anonymous visitors (401) and non-managers (403), sending and changing nothing', async () => {
    const update = await draftUpdate({ all: true })
    const herp = await findSponsor('Herp Society')
    mail.length = 0
    const calls = [
      [sendEndpoint, update.id],
      [recipientsEndpoint, update.id],
      [archiveEndpoint, herp.id],
    ] as const
    for (const [user, status] of [[null, 401], [asUser(member), 403]] as const) {
      for (const [endpoint, id] of calls) {
        const req = { user, payload, routeParams: { id: String(id) }, json: async () => ({ archived: true }) }
        await expect((endpoint.handler as (r: unknown) => Promise<Response>)(req)).rejects.toMatchObject({ status })
      }
    }
    expect(mail).toEqual([])
    expect(((await payload.findByID({ collection: 'sponsor-updates' as never, id: update.id })) as Doc).status).toBe('draft')
    expect(((await payload.findByID({ collection: 'sponsors' as never, id: herp.id })) as Doc).archivedAt).toBeFalsy()
    // A manager sees counts only, never addresses.
    const res = await (recipientsEndpoint.handler as (r: unknown) => Promise<Response>)({ user: asUser(admin), payload, routeParams: { id: String(update.id) } })
    const body = await res.text()
    expect(body).not.toContain('@')
    expect(JSON.parse(body)).toMatchObject({ status: 'draft' })
  })

  it('sends nothing where sending is off, with no recipients, or while an update is already sending', async () => {
    const o = sponsorsOf(payload)
    mail.length = 0
    const off = await draftUpdate({ all: true })
    o.canSend = async () => false
    try {
      await expect(sendUpdate(payload, String(off.id))).rejects.toThrow(/turned off/)
    } finally {
      o.canSend = undefined
    }
    expect(((await payload.findByID({ collection: 'sponsor-updates' as never, id: off.id })) as Doc).status).toBe('draft')
    const nobody = await draftUpdate({ all: false, sponsors: [], tiers: [] })
    await expect(sendUpdate(payload, String(nobody.id))).rejects.toThrow(/Choose at least one/)
    expect(((await payload.findByID({ collection: 'sponsor-updates' as never, id: nobody.id })) as Doc).status).toBe('draft')
    const busy = await draftUpdate({ all: true })
    await payload.update({ collection: 'sponsor-updates' as never, id: busy.id, data: { status: 'sending' } as never })
    await expect(sendUpdate(payload, String(busy.id))).rejects.toThrow(/already sent/)
    expect(mail).toEqual([])
  })

  it('counts a failed delivery, carries on, keeps addresses out of the report, and escapes the sponsor name', async () => {
    await payload.create({ collection: 'sponsors' as never, data: { name: 'Fail <b>&</b> Co', listed: true, contacts: [{ email: 'bounce@fail.example' }, { email: 'ok@fail.example' }] } as never })
    const fail = await findSponsor('Fail <b>&</b> Co')
    const o = sponsorsOf(payload)
    const original = o.sendEmail
    const warn = payload.logger.warn
    payload.logger.warn = (() => undefined) as never
    o.sendEmail = async (args) => {
      if (args.to.startsWith('bounce@')) throw new Error('mailbox full for bounce@fail.example')
      await original!(args)
    }
    mail.length = 0
    try {
      const update = await draftUpdate({ sponsors: [fail.id] })
      const report = await sendUpdate(payload, String(update.id))
      expect(report).toMatchObject({ sent: 1, failed: 1, skipped: 0 })
      expect(mail.map((m) => m.to)).toEqual(['ok@fail.example'])
      expect(mail[0]!.html).toContain('Fail &lt;b&gt;&amp;&lt;/b&gt; Co')
      expect(mail[0]!.html).not.toContain('<b>&</b>')
      const saved = (await payload.findByID({ collection: 'sponsor-updates' as never, id: update.id })) as Doc
      expect(saved.status).toBe('sent')
      expect(JSON.stringify(saved.report)).not.toContain('@')
    } finally {
      o.sendEmail = original
      payload.logger.warn = warn
    }
  })

  it('rejects opt-out links that are malformed, forged, tampered with or for a sponsor that is gone, changing nothing', async () => {
    const herp = await findSponsor('Herp Society')
    const before = ((await payload.findByID({ collection: 'sponsors' as never, id: herp.id })) as Doc).contacts
    const body = (email: string) => Buffer.from(JSON.stringify([String(herp.id), email])).toString('base64url')
    const forged = `${body('board@herp.example')}.${crypto.createHmac('sha256', 'another-secret').update(`sponsors-opt-out:${body('board@herp.example')}`).digest('base64url')}`
    const valid = optOutToken(payload, String(herp.id), 'pat@herp.example')
    const tampered = `${body('board@herp.example')}.${valid.split('.')[1]}`
    for (const token of ['', 'no-dot', '.', `${body('board@herp.example')}.`, forged, tampered]) expect([token, await optOut(payload, token)]).toEqual([token, false])
    expect(await optOut(payload, optOutToken(payload, '000000000000000000000000', 'board@herp.example'))).toBe(false)
    const after = ((await payload.findByID({ collection: 'sponsors' as never, id: herp.id })) as Doc).contacts
    expect(after.map((c: Doc) => [c.email, Boolean(c.optedOut)])).toEqual(before.map((c: Doc) => [c.email, Boolean(c.optedOut)]))
    const res = await (optOutEndpoint.handler as (r: unknown) => Promise<Response>)({ payload, searchParams: new URLSearchParams({ t: forged }) })
    expect(res.status).toBe(400)
  })
})
