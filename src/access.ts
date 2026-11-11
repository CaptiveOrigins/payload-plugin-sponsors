import type { Payload, PayloadRequest } from 'payload'

import type { ResolvedSponsors } from './types.js'

/** Only an answer of exactly `true` passes; anything else, a thrown error included, is no. */
export async function exactlyTrue(check: () => unknown): Promise<boolean> {
  try {
    return (await check()) === true
  } catch {
    return false
  }
}

/** A signed-in manager: `canManage` answered exactly `true` (a truthy value or an error is a no). */
export const isManager = (o: Pick<ResolvedSponsors, 'canManage'>, req: PayloadRequest): Promise<boolean> =>
  req.user ? exactlyTrue(() => o.canManage({ req })) : Promise.resolve(false)

/** Sending is allowed here: no `canSend`, or `canSend` answered exactly `true`. */
export const sendingAllowed = (o: Pick<ResolvedSponsors, 'canSend'>, payload: Payload): Promise<boolean> =>
  o.canSend ? exactlyTrue(() => o.canSend!({ payload })) : Promise.resolve(true)
