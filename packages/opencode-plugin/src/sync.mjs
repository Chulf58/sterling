// Post-update sync: runs once per plugin process, at the first context request
// that reaches the context handler. A no-op until a lane gives it duties; the
// root-session check belongs with the first real duty, because a no-op must not
// add a session lookup to every context request.

/** Returns `syncOnce(root, sessionID)`; only the first call does anything. */
export function createSessionSync(deps = {}) {
  let ran = false;
  return async function syncOnce(root, sessionID) {
    if (ran) return;
    ran = true;
  };
}
