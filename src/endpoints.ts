import { APIError, type Endpoint, type PayloadRequest } from 'payload'

import { optOut, recipientsOf, sendUpdate, setArchived, sponsorsOf } from './api.js'

const allowed = async (req: PayloadRequest) => {
  if (!req.user) throw new APIError('Sign in first.', 401, undefined, true)
  if (!(await sponsorsOf(req.payload).canManage({ req }))) throw new APIError('Not allowed.', 403, undefined, true)
}

/** GET /api/<updates>/:id/recipients: who an update would reach (for the confirm dialog). */
export const recipientsEndpoint: Endpoint = {
  path: '/:id/recipients',
  method: 'get',
  handler: async (req) => {
    await allowed(req)
    const o = sponsorsOf(req.payload)
    const update = await req.payload.findByID({ collection: o.updates as never, id: String(req.routeParams?.id), depth: 0, overrideAccess: true })
    const sponsors = await recipientsOf(req.payload, update as never)
    const contacts = sponsors.reduce((n, s) => n + (s.contacts ?? []).filter((c) => c.email && !c.optedOut).length, 0)
    return Response.json({ sponsors: sponsors.length, contacts, status: (update as { status?: string }).status ?? 'draft' })
  },
}

/** POST /api/<updates>/:id/send: send the update now. */
export const sendEndpoint: Endpoint = {
  path: '/:id/send',
  method: 'post',
  handler: async (req) => {
    await allowed(req)
    try {
      return Response.json(await sendUpdate(req.payload, String(req.routeParams?.id), req.user?.id))
    } catch (error) {
      throw new APIError((error as Error).message, 400, undefined, true)
    }
  },
}

/** POST /api/<sponsors>/:id/archive { archived: boolean }: hide from (or return to) the public page. */
export const archiveEndpoint: Endpoint = {
  path: '/:id/archive',
  method: 'post',
  handler: async (req) => {
    await allowed(req)
    const body = (await req.json?.().catch(() => ({}))) as { archived?: boolean }
    await setArchived(req.payload, String(req.routeParams?.id), body?.archived !== false)
    return Response.json({ ok: true })
  },
}

/** GET /api/<sponsors>/opt-out?t=…: the link in every update; stops updates for that contact. */
export const optOutEndpoint: Endpoint = {
  path: '/opt-out',
  method: 'get',
  handler: async (req) => {
    const ok = await optOut(req.payload, String(req.searchParams?.get('t') ?? ''))
    const message = ok ? 'You won’t receive further sponsor updates at this address. Thank you for your support.' : 'This link isn’t valid. Reply to the last update and we’ll take you off the list.'
    return new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sponsor updates</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>${message}</p></body>`,
      { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8' } },
    )
  },
}
