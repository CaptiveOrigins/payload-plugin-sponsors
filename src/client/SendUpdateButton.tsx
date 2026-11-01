'use client'

import { useConfig, useDocumentInfo } from '@payloadcms/ui'
import React, { useEffect, useState } from 'react'

type Report = { sent: number; skipped: number; failed: number; sponsors: { name: string; sent: number }[] }

/**
 * In a sponsor update's sidebar: shows who it would reach, asks to confirm,
 * sends it (save first), and reports the result. Sent updates can't be resent.
 */
export function SendUpdateButton() {
  const { id, collectionSlug } = useDocumentInfo()
  const { config } = useConfig()
  const api = `${config.serverURL ?? ''}${config.routes.api}/${collectionSlug}`
  const [info, setInfo] = useState<{ sponsors: number; contacts: number; status: string } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!id) return
    void fetch(`${api}/${id}/recipients`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then(setInfo)
  }, [api, id])

  if (!id) return <p style={{ opacity: 0.7 }}>Save the update, then send it from here.</p>
  if (info?.status === 'sent') return <p>Sent. See the report below.</p>
  const send = async () => {
    if (!info?.contacts) return setMessage('No one to send to yet: choose sponsors or tiers with contacts, then save.')
    if (!window.confirm(`Send this update to ${info.contacts} contact${info.contacts === 1 ? '' : 's'} at ${info.sponsors} sponsor${info.sponsors === 1 ? '' : 's'}? Save your latest changes first. It can’t be unsent.`)) return
    setBusy(true)
    const res = await fetch(`${api}/${id}/send`, { method: 'POST', credentials: 'include' })
    const body = (await res.json().catch(() => null)) as (Report & { errors?: { message: string }[] }) | null
    setBusy(false)
    if (!res.ok) return setMessage(body?.errors?.[0]?.message ?? 'Sending failed.')
    setMessage(`Sent ${body!.sent}${body!.skipped ? `, ${body!.skipped} opted out` : ''}${body!.failed ? `, ${body!.failed} failed` : ''}. Reload to see the report.`)
    setInfo((i) => (i ? { ...i, status: 'sent' } : i))
  }
  return (
    <div style={{ marginBottom: 'var(--base)' }}>
      <button type="button" className="btn btn--style-primary btn--size-medium" disabled={busy} onClick={send} style={{ margin: 0 }}>
        {busy ? 'Sending…' : 'Send update'}
      </button>
      <p style={{ opacity: 0.7, marginTop: 6 }}>{info ? `Reaches ${info.contacts} contact${info.contacts === 1 ? '' : 's'} at ${info.sponsors} sponsor${info.sponsors === 1 ? '' : 's'} (saved recipients).` : ' '}</p>
      {message && <p role="status">{message}</p>}
    </div>
  )
}

/** Archive or restore a sponsor (from the overview), with a clear warning. */
export function ArchiveButton({ id, archived, apiBase }: { id: string; archived: boolean; apiBase: string }) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    const text = archived
      ? 'Return this sponsor to the public page (if “Show on the public page” is on)?'
      : 'Archive this sponsor? They disappear from the public page and stop receiving updates; their record and past updates are kept, and you can restore them any time. (To erase them completely, delete from their page instead.)'
    if (!window.confirm(text)) return
    setBusy(true)
    await fetch(`${apiBase}/${id}/archive`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: !archived }) })
    window.location.reload()
  }
  return (
    <button type="button" className="btn btn--style-secondary btn--size-small" disabled={busy} onClick={run} style={{ margin: 0 }}>
      {archived ? 'Restore' : 'Archive'}
    </button>
  )
}
