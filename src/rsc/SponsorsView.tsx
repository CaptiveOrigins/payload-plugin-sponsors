import { DefaultTemplate } from '@payloadcms/next/templates'
import type { AdminViewServerProps, CollectionSlug } from 'payload'
import React from 'react'

import { isManager } from '../access.js'
import { sponsorsOf } from '../api.js'
import { ArchiveButton } from '../client/SendUpdateButton.js'

type Row = { id: string; name: string; listed?: boolean; archivedAt?: string | null; tier?: { id: string; name: string } | string | null; logo?: { url?: string | null } | null; contacts?: unknown[] }

/** /admin/sponsors: every sponsor by tier, with add, edit, archive/restore and "Email sponsors". */
export async function SponsorsView({ initPageResult, params, searchParams }: AdminViewServerProps) {
  const { req, permissions, visibleEntities, locale } = initPageResult
  const o = sponsorsOf(req.payload)
  const allowed = await isManager(o, req)
  const admin = req.payload.config.routes.admin
  const apiBase = `${req.payload.config.serverURL ?? ''}${req.payload.config.routes.api}/${o.sponsors}`
  const docs = allowed
    ? ((await req.payload.find({ collection: o.sponsors as CollectionSlug, depth: 1, pagination: false, sort: '_order', overrideAccess: true, req })).docs as unknown as Row[])
    : []
  const tierName = (r: Row) => (r.tier && typeof r.tier === 'object' ? r.tier.name : null)
  const current = docs.filter((d) => !d.archivedAt)
  const groups = new Map<string, Row[]>()
  for (const d of current) groups.set(tierName(d) ?? 'No tier', [...(groups.get(tierName(d) ?? 'No tier') ?? []), d])
  const archived = docs.filter((d) => d.archivedAt)
  const card = (d: Row) => (
    <li key={d.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 12, border: '1px solid var(--theme-elevation-150)', borderRadius: 8 }}>
      {d.logo && typeof d.logo === 'object' && d.logo.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={d.logo.url} alt="" style={{ width: 48, height: 48, objectFit: 'contain', background: '#fff', borderRadius: 6 }} />
      ) : (
        <span style={{ width: 48, height: 48, borderRadius: 6, background: 'var(--theme-elevation-100)' }} />
      )}
      <span style={{ flex: 1 }}>
        <a href={`${admin}/collections/${o.sponsors}/${d.id}`} style={{ fontWeight: 600 }}>
          {d.name}
        </a>
        <span style={{ display: 'block', opacity: 0.7, fontSize: 13 }}>
          {d.archivedAt ? 'Archived' : d.listed ? 'On the public page' : 'Hidden (not yet shown)'} · {(d.contacts ?? []).length} contact{(d.contacts ?? []).length === 1 ? '' : 's'}
        </span>
      </span>
      <ArchiveButton id={d.id} archived={Boolean(d.archivedAt)} apiBase={apiBase} />
    </li>
  )
  return (
    <DefaultTemplate i18n={req.i18n} locale={locale} params={params} payload={req.payload} permissions={permissions} req={req} searchParams={searchParams} user={req.user ?? undefined} visibleEntities={visibleEntities}>
      <div className="gutter--left gutter--right" style={{ paddingBlock: 'calc(var(--base) * 2)', display: 'grid', gap: 'var(--base)' }}>
        <h1>Sponsors</h1>
        {!allowed ? (
          <p>You don’t have access to sponsors.</p>
        ) : (
          <>
            <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: 0 }}>
              <a className="btn btn--style-primary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.sponsors}/create`}>
                Add sponsor
              </a>
              <a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.updates}/create`}>
                Email sponsors
              </a>
              {o.tiers && (
                <a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.tiers}`}>
                  Tiers
                </a>
              )}
              <a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.updates}`}>
                Past updates
              </a>
            </p>
            {current.length === 0 && <p>No sponsors yet.</p>}
            {[...groups].map(([tier, rows]) => (
              <section key={tier}>
                <h3 style={{ margin: '8px 0' }}>{tier}</h3>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>{rows.map(card)}</ul>
              </section>
            ))}
            {archived.length > 0 && (
              <details>
                <summary>Archived ({archived.length})</summary>
                <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 8 }}>{archived.map(card)}</ul>
              </details>
            )}
          </>
        )}
      </div>
    </DefaultTemplate>
  )
}

/** Nav link to the overview, for people who manage sponsors. */
export async function SponsorsNavLink({ payload, user }: { payload: import('payload').Payload; user?: unknown }) {
  const o = sponsorsOf(payload)
  if (!(await isManager(o, { user, payload } as never))) return null
  return (
    <a className="nav__link" href={`${payload.config.routes.admin}/sponsors`} style={{ display: 'block', marginTop: 'calc(var(--base) / 2)' }}>
      <span className="nav__link-label">Sponsors</span>
    </a>
  )
}
