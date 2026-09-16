/**
 * The one bridge between a framework action and a use case (blueprint B16,
 * decisions D08 and D10).
 *
 * Every `actions/*.ts` file is a `defineAction` declaration plus a single call
 * to `runAppAction`, so the four things that must happen identically on every
 * surface — UI, agent, MCP, HTTP, CLI — happen in exactly one place:
 *
 * 1. The actor is resolved from the request context only (D10): never from an
 *    argument, and the role is always read fresh from membership.
 * 2. The use case runs with the composed `Dependencies`.
 * 3. One structured log line is written, success or failure.
 * 4. Every error leaves as `fail(...)`, which is the only way the framework
 *    lets a message, an `errorCode` and an HTTP status survive to the caller;
 *    a raw `throw` would become an opaque 500 with the message withheld (F5).
 */

import { fail, type ActionRunContext } from "@agent-native/core/action";

import type { Actor } from "../application/actor";
import { resolveActor } from "../application/actor";
import { AppError, HTTP_STATUS_FOR, toAppError } from "../application/errors";
import type { Dependencies } from "../application/ports";
import { getDependencies } from "../infrastructure/container";
import { logAction, logUnexpectedError } from "../infrastructure/logging";

/** `ActionRunContext.caller` is required by the framework, but `ctx` itself is
 * optional on `run`, so the runner still needs a value for the case where the
 * framework hands us nothing at all. */
const UNKNOWN_CALLER = "unknown";

export async function runAppAction<T>(
  ctx: ActionRunContext | undefined,
  actionName: string,
  fn: (actor: Actor, deps: Dependencies) => Promise<T>,
): Promise<T> {
  const deps = getDependencies();
  const started = Date.now();
  try {
    const actor = await resolveActor(
      {
        userEmail: ctx?.userEmail,
        orgId: ctx?.orgId,
        caller: ctx?.caller ?? UNKNOWN_CALLER,
      },
      deps.membership,
    );
    const result = await fn(actor, deps);
    logAction({
      action: actionName,
      outcome: "success",
      caller: actor.caller,
      orgId: actor.orgId,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (err) {
    const appErr = toAppError(err);
    // Only a value that was not already an `AppError` and did not map to one
    // is unexpected: `toAppError` turns those, and only those, into INTERNAL
    // with a message that hides the original. The original is worth a server
    // log line with its stack — it is the only record of what actually broke —
    // and it never reaches the caller.
    if (appErr.code === "INTERNAL" && !(err instanceof AppError)) {
      logUnexpectedError({
        action: actionName,
        orgId: ctx?.orgId ?? null,
        error: err,
      });
    }
    logAction({
      action: actionName,
      outcome: "error",
      errorCode: appErr.code,
      caller: ctx?.caller,
      orgId: ctx?.orgId ?? null,
      durationMs: Date.now() - started,
    });
    return fail(appErr.message, {
      errorCode: appErr.code,
      statusCode: HTTP_STATUS_FOR[appErr.code],
      details: appErr.details,
    });
  }
}
