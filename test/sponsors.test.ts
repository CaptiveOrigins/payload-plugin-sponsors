import crypto from 'node:crypto'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { sponsorsOf } from '../src/api.js'
import { SponsorsNavLink, SponsorsView } from '../src/rsc/SponsorsView.js'
import { archiveEndpoint, optOutEndpoint, recipientsEndpoint, recoverEndpoint, sendEndpoint } from '../src/endpoints.js'
import { getSponsors, optOut, optOutToken, recoverSend, retireListing, sendUpdate, setArchived, sponsorsPlugin, upsertListing } from '../src/index.js'

// The admin view renders inside Payload's admin shell; a bare stand-in keeps the test to its own decision.
vi.mock('@payloadcms/next/templates', () => ({ DefaultTemplate: ({ children }: { children: unknown }) => children }))
vi.mock('@payloadcms/ui', () => ({ useConfig: () => ({ config: { routes: { api: '/api' } } }), useDocumentInfo: () => ({}) }))

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
    await expect(sendUpdate(payload, String(busy.id))).rejects.toThrow(/already sending/)
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
      const saved = (await payload.findByID({ collection: 'sponsor-updates' as never, id: update.id, depth: 0 })) as Doc
      // A failed delivery leaves it partly sent, so staff can see it and send to the rest (fixed 2026-11-10).
      expect(saved.status).toBe('partial')
      expect(JSON.stringify(saved.report)).not.toContain('@')
      expect(JSON.stringify(saved)).not.toContain('@')
      // Sending again tries only the contact that missed it.
      o.sendEmail = original
      mail.length = 0
      expect(await sendUpdate(payload, String(update.id))).toMatchObject({ status: 'sent', sent: 1, alreadySent: 1, failed: 0 })
      expect(mail.map((m) => m.to)).toEqual(['bounce@fail.example'])
      await expect(sendUpdate(payload, String(update.id))).rejects.toThrow(/already sent/)
    } finally {
      o.sendEmail = original
      payload.logger.warn = warn
    }
  })

  it('sends once when two sends start together: one goes out, the other is refused (fixed 2026-11-10)', async () => {
    await payload.create({ collection: 'sponsors' as never, data: { name: 'Race Co', listed: true, contacts: [{ email: 'one@race.example' }, { email: 'two@race.example' }] } as never })
    const race = await findSponsor('Race Co')
    const update = await draftUpdate({ sponsors: [race.id] }, 'Race update')
    const o = sponsorsOf(payload)
    const original = o.sendEmail
    // Hold deliveries until the other send has been refused (or a short timeout), so both really overlap.
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
      setTimeout(r, 1500)
    })
    o.sendEmail = async (args) => {
      await gate
      await original!(args)
    }
    mail.length = 0
    try {
      const send = () => sendUpdate(payload, String(update.id)).catch((e: Error) => (release(), Promise.reject(e)))
      const results = await Promise.allSettled([send(), send()])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      expect(refused).toHaveLength(1)
      expect(refused[0]!.reason.message).toBe('This update is already sending.')
      expect(mail.map((m) => m.to).sort()).toEqual(['one@race.example', 'two@race.example'])
      expect(((await payload.findByID({ collection: 'sponsor-updates' as never, id: update.id })) as Doc).status).toBe('sent')
    } finally {
      o.sendEmail = original
    }
  })

  it('a send that stops partway is marked partly sent, and sending again reaches only the rest (fixed 2026-11-10)', async () => {
    await payload.create({ collection: 'sponsors' as never, data: { name: 'Halt One', listed: true, contacts: [{ email: 'a@halt.example' }, { email: 'b@halt.example' }] } as never })
    await payload.create({ collection: 'sponsors' as never, data: { name: 'Halt Two', listed: true, contacts: [{ email: 'c@halt.example' }] } as never })
    const ids = [(await findSponsor('Halt One')).id, (await findSponsor('Halt Two')).id]
    const o = sponsorsOf(payload)
    const render = o.renderEmail
    const errorLog = payload.logger.error
    payload.logger.error = (() => undefined) as never
    const stopAfter = (n: number) => {
      let calls = 0
      o.renderEmail = (args) => {
        if (++calls > n) throw new Error('layout broke')
        return render!(args)
      }
    }
    const status = async (id: unknown) => (await payload.findByID({ collection: 'sponsor-updates' as never, id: id as string, depth: 0 })) as Doc
    try {
      // Stops after one email: partly sent, with that contact recorded.
      const update = await draftUpdate({ sponsors: ids }, 'Halt update')
      mail.length = 0
      stopAfter(1)
      await expect(sendUpdate(payload, String(update.id))).rejects.toThrow(/stopped partway: 1 contact has it so far.*partly sent/)
      const saved = await status(update.id)
      expect(saved.status).toBe('partial')
      expect(saved.report).toMatchObject({ status: 'partial', sent: 1, stoppedEarly: true })
      expect(saved.delivered).toHaveLength(1)
      expect(JSON.stringify(saved)).not.toContain('@')
      const first = mail.map((m) => m.to)
      expect(first).toHaveLength(1)
      // The admin preview counts only those still to reach.
      const preview = await (recipientsEndpoint.handler as (r: unknown) => Promise<Response>)({ user: asUser(admin), payload, routeParams: { id: String(update.id) } })
      expect(await preview.json()).toMatchObject({ contacts: 2, status: 'partial' })
      // Sending again reaches the other two, and nobody twice.
      o.renderEmail = render
      expect(await sendUpdate(payload, String(update.id))).toMatchObject({ status: 'sent', sent: 2, alreadySent: 1 })
      expect(mail.map((m) => m.to).sort()).toEqual(['a@halt.example', 'b@halt.example', 'c@halt.example'])
      expect((await status(update.id)).status).toBe('sent')

      // Stops before anyone gets it: failed, and it can be sent again.
      const none = await draftUpdate({ sponsors: ids }, 'Halt early')
      mail.length = 0
      stopAfter(0)
      await expect(sendUpdate(payload, String(none.id))).rejects.toThrow(/0 contacts have it so far.*failed/)
      expect((await status(none.id)).status).toBe('failed')
      expect(mail).toEqual([])
      o.renderEmail = render
      expect(await sendUpdate(payload, String(none.id))).toMatchObject({ status: 'sent', sent: 3, alreadySent: 0 })
    } finally {
      o.renderEmail = render
      payload.logger.error = errorLog
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


describe('a send the server stopped (recovery, 2026-11-11)', () => {
  const asUser = (u: Doc) => ({ ...u, collection: 'users' })
  const findSponsor = async (name: string) => (await payload.find({ collection: 'sponsors' as never, where: { name: { equals: name } }, depth: 0 })).docs[0] as Doc
  const draftUpdate = (recipients: Doc, subject: string) => payload.create({ collection: 'sponsor-updates' as never, data: { subject, body: lexical('Recovery body'), recipients } as never }) as Promise<Doc>
  const saved = async (id: unknown) => (await payload.findByID({ collection: 'sponsor-updates' as never, id: id as string, depth: 0 })) as Doc
  // Where the update is stored, to play a dead server: backdate the lease, or leave a send claimed.
  // (timestamps off, so a backdated `updatedAt` stays backdated)
  const model = () => (payload.db as unknown as { collections: Record<string, { updateOne: (f: object, u: object, o: object) => Promise<unknown> }> }).collections['sponsor-updates']!
  const raw = () => ({ updateOne: (f: object, u: object) => model().updateOne(f, u, { timestamps: false }) })
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)
  const call = (endpoint: typeof recoverEndpoint, user: Doc | null, id: unknown) =>
    (endpoint.handler as (r: unknown) => Promise<Response>)({ user: user ? asUser(user) : null, payload, routeParams: { id: String(id) } })
  let member: Doc
  let ids: unknown[]

  beforeAll(async () => {
    member = (await payload.find({ collection: 'users', where: { email: { equals: 'member@example.org' } } })).docs[0] as Doc
    await payload.create({ collection: 'sponsors' as never, data: { name: 'Stop One', listed: true, contacts: [{ email: 'a@stop.example' }, { email: 'b@stop.example' }] } as never })
    await payload.create({ collection: 'sponsors' as never, data: { name: 'Stop Two', listed: true, contacts: [{ email: 'c@stop.example' }] } as never })
    ids = [(await findSponsor('Stop One')).id, (await findSponsor('Stop Two')).id]
  })

  /** A delivery to `to` that hangs until released, as on a server that has stopped. */
  const hangOn = (to: string) => {
    const o = sponsorsOf(payload)
    const original = o.sendEmail!
    let fail!: (e: Error) => void
    let reached!: () => void
    const atHang = new Promise<void>((r) => (reached = r))
    let hung = false
    o.sendEmail = async (args) => {
      if (args.to === to && !hung) {
        hung = true
        reached()
        return new Promise<void>((_, reject) => (fail = reject))
      }
      await original(args)
    }
    return { atHang, release: () => fail(new Error('connection reset')), restore: () => (o.sendEmail = original) }
  }

  it('recovers a stale send to partly sent; sending again reaches only the rest, and nobody gets it twice', async () => {
    const update = await draftUpdate({ sponsors: ids }, 'Stopped update')
    const hang = hangOn('b@stop.example')
    const warn = payload.logger.warn
    payload.logger.warn = (() => undefined) as never
    mail.length = 0
    try {
      // The send reaches a, then hangs on b: to everyone else it looks like a server that stopped.
      const stopped = sendUpdate(payload, String(update.id)).then(
        () => null,
        (e: Error) => e,
      )
      await hang.atHang
      const during = await saved(update.id)
      expect(during).toMatchObject({ status: 'sending' })
      expect(during.claimId).toEqual(expect.any(String))
      expect(Date.now() - Date.parse(during.sendingSince)).toBeLessThan(60_000)
      expect(during.delivered).toHaveLength(1) // a, recorded before b was tried
      expect(mail.map((m) => m.to)).toEqual(['a@stop.example'])

      // Fresh: not stuck, can't be recovered, can't be sent.
      expect(await (await call(recipientsEndpoint as never, admin, update.id)).json()).toMatchObject({ status: 'sending', stuck: false })
      await expect(call(recoverEndpoint, admin, update.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/still sending/) })
      await expect(recoverSend(payload, String(update.id))).rejects.toThrow(/still sending/)
      await expect(sendUpdate(payload, String(update.id))).rejects.toThrow('This update is already sending.')
      expect((await saved(update.id)).status).toBe('sending')

      // 31 minutes without progress: stuck. The admin shows it, and sending says to recover first.
      await raw().updateOne({ _id: update.id }, { $set: { sendingSince: minutesAgo(31) } })
      expect(await (await call(recipientsEndpoint as never, admin, update.id)).json()).toMatchObject({ status: 'sending', stuck: true, contacts: 2 })
      await expect(sendUpdate(payload, String(update.id))).rejects.toThrow(/recover it/)

      const res = await call(recoverEndpoint, admin, update.id)
      const report = await res.json()
      expect(report).toMatchObject({ status: 'partial', sent: 1, recovered: true, stoppedEarly: true })
      expect(report.sponsors).toEqual([expect.objectContaining({ name: 'Stop One', sent: 1 }), expect.objectContaining({ name: 'Stop Two', sent: 0 })])
      const after = await saved(update.id)
      expect(after).toMatchObject({ status: 'partial', report: { status: 'partial', recovered: true } })
      expect(after.claimId ?? null).toBeNull()
      expect(after.sendingSince ?? null).toBeNull()
      expect(JSON.stringify(after)).not.toContain('@')
      await expect(call(recoverEndpoint, admin, update.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/nothing to recover/) })

      // Sending again reaches b and c only.
      expect(await sendUpdate(payload, String(update.id), admin.id)).toMatchObject({ status: 'sent', sent: 2, alreadySent: 1, failed: 0 })
      const done = await saved(update.id)
      expect(done).toMatchObject({ status: 'sent', sentBy: admin.id })
      expect(done.claimId ?? null).toBeNull()

      // The old send wakes up: it notices it was recovered and emails no one else (c comes after b).
      hang.release()
      expect(((await stopped) as Error).message).toMatch(/recovered while it ran/)
      expect(mail.map((m) => m.to).sort()).toEqual(['a@stop.example', 'b@stop.example', 'c@stop.example'])
      expect(await saved(update.id)).toMatchObject({ status: 'sent', report: { status: 'sent' } })
    } finally {
      hang.restore()
      payload.logger.warn = warn
    }
  })

  it('lets an old send that wakes after its last email overwrite nothing', async () => {
    const update = await draftUpdate({ sponsors: [ids[1]] }, 'Stopped on the last one')
    const hang = hangOn('c@stop.example')
    const warn = payload.logger.warn
    payload.logger.warn = (() => undefined) as never
    mail.length = 0
    try {
      const stopped = sendUpdate(payload, String(update.id)).then(
        () => null,
        (e: Error) => e,
      )
      await hang.atHang
      await raw().updateOne({ _id: update.id }, { $set: { sendingSince: minutesAgo(31) } })
      expect(await recoverSend(payload, String(update.id))).toMatchObject({ status: 'failed', sent: 0 })
      expect(await sendUpdate(payload, String(update.id))).toMatchObject({ status: 'sent', sent: 1 })
      hang.release()
      expect(((await stopped) as Error).message).toMatch(/recovered while it ran/)
      expect(await saved(update.id)).toMatchObject({ status: 'sent', report: { status: 'sent', sent: 1 } })
      expect(mail.map((m) => m.to)).toEqual(['c@stop.example'])
    } finally {
      hang.restore()
      payload.logger.warn = warn
    }
  })

  it('recovers a send claimed before the lease existed (0.3.1) by its last write, as failed when nobody had it', async () => {
    const update = await draftUpdate({ sponsors: [ids[1]] }, 'Stuck since 0.3.1')
    await raw().updateOne({ _id: update.id }, { $set: { status: 'sending', updatedAt: minutesAgo(45) }, $unset: { sendingSince: 1, claimId: 1 } })
    expect(await (await call(recipientsEndpoint as never, admin, update.id)).json()).toMatchObject({ stuck: true })
    expect(await recoverSend(payload, String(update.id))).toMatchObject({ status: 'failed', sent: 0, recovered: true })
    expect((await saved(update.id)).status).toBe('failed')
    mail.length = 0
    expect(await sendUpdate(payload, String(update.id))).toMatchObject({ status: 'sent', sent: 1 })
    expect(mail.map((m) => m.to)).toEqual(['c@stop.example'])
  })

  it('gives one winner when two recoveries start together', async () => {
    const update = await draftUpdate({ sponsors: ids }, 'Two recoveries')
    await raw().updateOne({ _id: update.id }, { $set: { status: 'sending', claimId: 'dead-claim', sendingSince: minutesAgo(40), delivered: [] } })
    const results = await Promise.allSettled([recoverSend(payload, String(update.id)), recoverSend(payload, String(update.id))])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(lost).toHaveLength(1)
    expect(lost[0]!.reason.message).toMatch(/changed while recovering/)
    expect((await saved(update.id)).status).toBe('failed')
  })

  it('loses to a send that moves on between the stale check and the takeover', async () => {
    // Each change lands just before the recovery's write: progress, a new claim, or (before the lease) any write.
    const cases = [
      { start: { claimId: 'slow-claim', sendingSince: minutesAgo(40) }, meanwhile: { sendingSince: new Date() } },
      { start: { claimId: 'slow-claim', sendingSince: minutesAgo(40) }, meanwhile: { claimId: 'another-claim' } },
      { start: { updatedAt: minutesAgo(40) }, meanwhile: { updatedAt: new Date() } },
    ]
    const db = payload.db as unknown as { updateOne: (args: { data?: { report?: { recovered?: boolean } } }) => Promise<unknown> }
    const original = db.updateOne
    try {
      for (const { start, meanwhile } of cases) {
        const update = await draftUpdate({ sponsors: ids }, 'Raced recovery')
        await raw().updateOne({ _id: update.id }, { $set: { status: 'sending', delivered: [], ...start }, $unset: 'claimId' in start ? {} : { claimId: 1, sendingSince: 1 } })
        db.updateOne = async function (this: unknown, args) {
          if (args.data?.report?.recovered) await raw().updateOne({ _id: update.id }, { $set: meanwhile })
          return original.call(this, args)
        }
        await expect(recoverSend(payload, String(update.id))).rejects.toThrow(/changed while recovering/)
        db.updateOne = original
        expect([meanwhile, (await saved(update.id)).status]).toEqual([meanwhile, 'sending'])
      }
    } finally {
      db.updateOne = original
    }
  })

  it('refuses recovery to anonymous visitors, non-managers and anything but an exact yes, changing nothing', async () => {
    const update = await draftUpdate({ sponsors: ids }, 'Refused recovery')
    await raw().updateOne({ _id: update.id }, { $set: { status: 'sending', claimId: 'dead-claim', sendingSince: minutesAgo(40), delivered: [] } })
    await expect(call(recoverEndpoint, null, update.id)).rejects.toMatchObject({ status: 401 })
    await expect(call(recoverEndpoint, member, update.id)).rejects.toMatchObject({ status: 403 })
    const o = sponsorsOf(payload)
    const canManage = o.canManage
    try {
      for (const answer of [1, 'yes', {}, Promise.reject(new Error('directory down'))]) {
        o.canManage = (() => answer) as never
        await expect(call(recoverEndpoint, admin, update.id)).rejects.toMatchObject({ status: 403 })
      }
    } finally {
      o.canManage = canManage
    }
    expect(await saved(update.id)).toMatchObject({ status: 'sending', claimId: 'dead-claim' })
    // A manager can.
    expect(await (await call(recoverEndpoint, admin, update.id)).json()).toMatchObject({ status: 'failed' })
  })

  it('refuses a stale-send time that is not a positive number of minutes', () => {
    const bare = {} as Parameters<ReturnType<typeof sponsorsPlugin>>[0]
    for (const bad of [0, -5, Number.NaN, Infinity]) expect(() => sponsorsPlugin({ staleSendMinutes: bad })(bare)).toThrow(/staleSendMinutes/)
    expect((sponsorsPlugin({ staleSendMinutes: 5 })(bare) as Doc).custom.sponsors).toMatchObject({ staleSendMinutes: 5 })
  })
})

describe('only an exact yes from canManage or canSend (2026-11-11)', () => {
  const asUser = (u: Doc) => ({ ...u, collection: 'users' })
  // Each a no: truthy values, objects (one shaped like a query, which must not widen reads), and errors.
  const noes: [string, () => unknown][] = [
    ['1', () => 1],
    ["'yes'", () => 'yes'],
    ['{}', () => ({})],
    ['a query-shaped object', () => ({ listed: { equals: false } })],
    ['a thrown error', () => {
      throw new Error('directory down')
    }],
    ['a rejected promise', async () => {
      throw new Error('directory down')
    }],
  ]
  const call = (endpoint: { handler: unknown }, id: unknown, body: Doc = {}) =>
    (endpoint.handler as (r: unknown) => Promise<Response>)({ user: asUser(admin), payload, routeParams: { id: String(id) }, json: async () => body })
  const saved = async (slug: string, id: unknown) => (await payload.findByID({ collection: slug as never, id: id as string, depth: 0 })) as Doc
  /** Runs `body` with `canManage` (or `canSend`) answering `answer`, then puts the site's rule back. */
  const answering = async (key: 'canManage' | 'canSend', answer: () => unknown, body: () => Promise<void>) => {
    const o = sponsorsOf(payload)
    const before = o[key]
    o[key] = answer as never
    try {
      await body()
    } finally {
      o[key] = before as never
    }
  }
  /** The text in a React element tree (components not rendered; enough to see what the view chose to show). */
  const textOf = (node: unknown): string =>
    node === null || node === undefined || typeof node === 'boolean'
      ? ''
      : typeof node === 'string' || typeof node === 'number'
        ? String(node)
        : Array.isArray(node)
          ? node.map(textOf).join(' ')
          : textOf((node as { props?: { children?: unknown } }).props?.children)
  const view = async (user: Doc | null) =>
    textOf(await SponsorsView({ initPageResult: { req: { user: user ? asUser(user) : null, payload, i18n: {} }, permissions: {}, visibleEntities: {}, locale: undefined }, params: {}, searchParams: {} } as never))
  const navLink = async (user: Doc | null) => SponsorsNavLink({ payload, user: user ? asUser(user) : undefined })
  let sponsor: Doc
  let tier: Doc

  beforeAll(async () => {
    sponsor = (await payload.create({ collection: 'sponsors' as never, data: { name: 'Exact Yes', listed: true, contacts: [{ email: 'exact@yes.example' }] } as never })) as Doc
    tier = (await payload.create({ collection: 'sponsor-tiers' as never, data: { name: 'Exact Tier' } as never })) as Doc
  })

  it('refuses collection and field access to anything but true: public rows only, no contacts, no writes', async () => {
    const as = { overrideAccess: false, user: asUser(admin) }
    const update = (await payload.create({ collection: 'sponsor-updates' as never, data: { subject: 'Exact', body: lexical('x'), recipients: { sponsors: [sponsor.id] } } as never })) as Doc
    for (const [label, answer] of noes) {
      await answering('canManage', answer, async () => {
        const seen = await payload.find({ collection: 'sponsors' as never, pagination: false, ...as })
        const names = seen.docs.map((d: Doc) => d.name)
        expect(names, label).toContain('Exact Yes')
        expect(names, label).not.toContain('Not yet') // unlisted: managers only
        expect(JSON.stringify(seen.docs), label).not.toContain('@') // contacts field: managers only
        await expect(payload.update({ collection: 'sponsors' as never, id: sponsor.id, data: { name: 'Changed' } as never, ...as }), label).rejects.toThrow()
        await expect(payload.create({ collection: 'sponsors' as never, data: { name: 'Uninvited' } as never, ...as }), label).rejects.toThrow()
        await expect(payload.delete({ collection: 'sponsors' as never, id: sponsor.id, ...as }), label).rejects.toThrow()
        await expect(payload.update({ collection: 'sponsor-tiers' as never, id: tier.id, data: { name: 'Changed' } as never, ...as }), label).rejects.toThrow()
        await expect(payload.delete({ collection: 'sponsor-tiers' as never, id: tier.id, ...as }), label).rejects.toThrow()
        await expect(payload.find({ collection: 'sponsor-updates' as never, ...as }), label).rejects.toThrow()
        await expect(payload.update({ collection: 'sponsor-updates' as never, id: update.id, data: { subject: 'Changed' } as never, ...as }), label).rejects.toThrow()
      })
    }
    expect(await saved('sponsors', sponsor.id)).toMatchObject({ name: 'Exact Yes' })
    expect(await saved('sponsor-tiers', tier.id)).toMatchObject({ name: 'Exact Tier' })
    expect(await saved('sponsor-updates', update.id)).toMatchObject({ subject: 'Exact' })
    // Exactly true: every row, contacts included, and writes go through.
    await answering('canManage', () => true, async () => {
      const seen = await payload.find({ collection: 'sponsors' as never, pagination: false, ...as })
      expect(seen.docs.map((d: Doc) => d.name)).toContain('Not yet')
      expect(JSON.stringify(seen.docs)).toContain('exact@yes.example')
      await payload.update({ collection: 'sponsor-tiers' as never, id: tier.id, data: { name: 'Exact Tier 2' } as never, ...as })
      expect((await payload.find({ collection: 'sponsor-updates' as never, ...as })).docs.length).toBeGreaterThan(0)
    })
    expect(await saved('sponsor-tiers', tier.id)).toMatchObject({ name: 'Exact Tier 2' })
  })

  it('answers send, recipients, archive and recover with 403 (never a 500) for anything but true, changing nothing', async () => {
    const { sendEndpoint: send, recipientsEndpoint: recipients, archiveEndpoint: archive, recoverEndpoint: recover } = await import('../src/endpoints.js')
    const update = (await payload.create({ collection: 'sponsor-updates' as never, data: { subject: 'Exact send', body: lexical('x'), recipients: { sponsors: [sponsor.id] } } as never })) as Doc
    mail.length = 0
    for (const [label, answer] of noes) {
      await answering('canManage', answer, async () => {
        for (const [endpoint, id] of [[send, update.id], [recipients, update.id], [archive, sponsor.id], [recover, update.id]] as const) {
          await expect(call(endpoint, id, { archived: true }), `${label} ${endpoint.path}`).rejects.toMatchObject({ status: 403 })
        }
      })
    }
    expect(mail).toEqual([])
    expect(await saved('sponsor-updates', update.id)).toMatchObject({ status: 'draft' })
    expect((await saved('sponsors', sponsor.id)).archivedAt).toBeFalsy()
    // Exactly true: each goes through.
    await answering('canManage', () => true, async () => {
      expect(await (await call(recipients, update.id)).json()).toMatchObject({ sponsors: 1, contacts: 1 })
      expect((await call(archive, sponsor.id, { archived: false })).status).toBe(200)
      await expect(call(recover, update.id)).rejects.toMatchObject({ status: 409 }) // allowed in; nothing to recover
      expect(await (await call(send, update.id)).json()).toMatchObject({ status: 'sent', sent: 1 })
    })
    expect(mail.map((m) => m.to)).toEqual(['exact@yes.example'])
  })

  it('sends nothing unless canSend answers exactly true; an error there is a 400, not a 500', async () => {
    const { sendEndpoint: send } = await import('../src/endpoints.js')
    const update = (await payload.create({ collection: 'sponsor-updates' as never, data: { subject: 'Exact canSend', body: lexical('x'), recipients: { sponsors: [sponsor.id] } } as never })) as Doc
    mail.length = 0
    for (const [label, answer] of noes) {
      await answering('canSend', answer, async () => {
        await expect(call(send, update.id), label).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/turned off/) })
        await expect(sendUpdate(payload, String(update.id)), label).rejects.toThrow(/turned off/)
      })
    }
    expect(mail).toEqual([])
    expect(await saved('sponsor-updates', update.id)).toMatchObject({ status: 'draft' })
    await answering('canSend', () => true, async () => {
      expect(await (await call(send, update.id)).json()).toMatchObject({ status: 'sent', sent: 1 })
    })
    expect(mail).toHaveLength(1)
  })

  it('shows the admin overview and its nav link only for an exact true', async () => {
    for (const [label, answer] of noes) {
      await answering('canManage', answer, async () => {
        const html = await view(admin)
        expect(html, label).toContain('You don’t have access to sponsors.')
        expect(html, label).not.toContain('Exact Yes')
        expect(await navLink(admin), label).toBeNull()
      })
    }
    // No one signed in: no, without asking the site.
    await answering('canManage', () => true, async () => {
      expect(await view(null)).toContain('You don’t have access')
      expect(await navLink(null)).toBeNull()
      const html = await view(admin)
      expect(html).toContain('Exact Yes')
      expect(html).not.toContain('You don’t have access')
      expect(await navLink(admin)).not.toBeNull()
    })
  })
})
