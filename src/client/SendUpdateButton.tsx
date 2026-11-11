'use client'

import { useConfig, useDocumentInfo } from '@payloadcms/ui'
import React, { useEffect, useState } from 'react'

type Report = { status: 'sent' | 'partial' | 'failed'; recovered?: boolean; sent: number; skipped: number; failed: number; alreadySent: number; sponsors: { name: string; sent: number }[] }

/**
 * In a sponsor update's sidebar: shows who it would reach, asks to confirm,
 * sends it (save first), and reports the result. Sent updates can't be resent;
 * a partly sent or failed one can, and then reaches only those it missed. A send
 * that stopped mid-way (the server went down) shows as stuck, with a Recover button.
 */
export function SendUpdateButton() {
  const { id, collectionSlug } = useDocumentInfo()
  const { config } = useConfig()
  const api = `${config.serverURL ?? ''}${config.routes.api}/${collectionSlug}`
  const [info, setInfo] = useState<{ sponsors: number; contacts: number; status: string; stuck?: boolean } | null>(null)
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
  if (info?.status === 'sending' && info.stuck) {
    const recover = async () => {
      if (!window.confirm('This send stopped before it finished. Recover it? It will be marked partly sent (or failed if nobody got it), and sending it again reaches only those who haven’t had it.')) return
      setBusy(true)
      const res = await fetch(`${api}/${id}/recover`, { method: 'POST', credentials: 'include' })
      const body = (await res.json().catch(() => null)) as (Report & { errors?: { message: string }[] }) | null
      setBusy(false)
      if (!res.ok) return setMessage(`${body?.errors?.[0]?.message ?? 'Recovering failed.'} Reload to see where it stands.`)
      setMessage(`Recovered: ${body!.sent} contact${body!.sent === 1 ? ' has' : 's have'} it. Send it again to reach the rest.`)
      setInfo((i) => (i ? { ...i, status: body!.status, stuck: false } : i))
    }
    return (
      <div style={{ marginBottom: 'var(--base)' }}>
        <p role="status">Sending stopped: recover it to finish.</p>
        <button type="button" className="btn btn--style-primary btn--size-medium" disabled={busy} onClick={recover} style={{ margin: 0 }}>
          {busy ? 'Recovering…' : 'Recover'}
        </button>
        {message && <p role="status">{message}</p>}
      </div>
    )
  }
  if (info?.status === 'sending') return <p role="status">Sending now. Reload in a moment to see the report.</p>
  const unfinished = info?.status === 'partial' || info?.status === 'failed'
  const send = async () => {
    if (!info?.contacts) return setMessage('No one to send to yet: choose sponsors or tiers with contacts, then save.')
    const who = `${info.contacts} contact${info.contacts === 1 ? '' : 's'}${unfinished ? ' who haven’t received it yet' : ` at ${info.sponsors} sponsor${info.sponsors === 1 ? '' : 's'}`}`
    if (!window.confirm(`Send this update to ${who}? Save your latest changes first. It can’t be unsent.`)) return
    setBusy(true)
    const res = await fetch(`${api}/${id}/send`, { method: 'POST', credentials: 'include' })
    const body = (await res.json().catch(() => null)) as (Report & { errors?: { message: string }[] }) | null
    setBusy(false)
    if (!res.ok) return setMessage(`${body?.errors?.[0]?.message ?? 'Sending failed.'} Reload to see the report.`)
    const b = body!
    const tail = b.status === 'sent' ? '' : ' Not everyone got it: send again to reach only those who didn’t.'
    setMessage(`Sent ${b.sent}${b.alreadySent ? ` (${b.alreadySent} already had it)` : ''}${b.skipped ? `, ${b.skipped} opted out` : ''}${b.failed ? `, ${b.failed} failed` : ''}.${tail} Reload to see the report.`)
    setInfo((i) => (i ? { ...i, status: b.status, contacts: b.failed } : i))
  }
  return (
    <div style={{ marginBottom: 'var(--base)' }}>
      <button type="button" className="btn btn--style-primary btn--size-medium" disabled={busy} onClick={send} style={{ margin: 0 }}>
        {busy ? 'Sending…' : unfinished ? 'Send to the rest' : 'Send update'}
      </button>
      {unfinished && <p role="status">{info?.status === 'partial' ? 'Partly sent.' : 'Sending failed.'} See the report below.</p>}
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
