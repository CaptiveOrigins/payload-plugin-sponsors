import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
  gold = await payload.create({ collection: 'sponsor-tiers' as never, data: { name: 'Gold', order: 1 } as never })
  friends = await payload.create({ collection: 'sponsor-tiers' as never, data: { name: 'Friends', order: 2 } as never })
  const sponsor = (name: string, extra: Doc) => payload.create({ collection: 'sponsors' as never, data: { name, listed: true, ...extra } as never })
  await sponsor('Herp Society', { tier: gold.id, order: 1, contacts: [{ name: 'Pat', email: 'pat@herp.example' }, { email: 'board@herp.example' }] })
  await sponsor('Conservation Foundation', { tier: gold.id, order: 2, contacts: [{ email: 'hello@cf.example', optedOut: true }] })
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
      ['Gold', ['Herp Society', 'Conservation Foundation']],
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
