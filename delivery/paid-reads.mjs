// Reusable adapter: injected account meter and existing application route/error types.
// It owns no database configuration, fixture, test IPC or absolute filesystem path.
export function paidReadLifecycle(
  {
    meter,
    failure,
    uncertainHold,
    observe = () => {},
    maxPending = 64,
    finalizationMs = 2000,
  },
) {
  if (
    !Number.isInteger(maxPending) ||
    maxPending < 1 ||
    maxPending > 64 ||
    finalizationMs < 1 ||
    finalizationMs > 2000
  )
    throw Error("INVALID_METER_BOUNDS");
  const tickets = new Set();
  let closing = false,
    peak = 0;
  const deny = (status, code) =>
    failure(status, code, "Access is unavailable.");
  const codes = new Set([
    "INVALID_KEY",
    "REVOKED_KEY",
    "ACCOUNT_DISABLED",
    "ACCESS_EXPIRED",
    "BURST_LIMIT",
    "DAILY_QUOTA",
    "PENDING_LIMIT",
    "PERIOD_QUOTA",
    "PERIOD_ACCESS_EXPIRED",
    "PERIOD_CONFLICT",
    "PERIOD_UNAVAILABLE",
  ]);

  const begin = async (request, reply, work) => {
    const route = work.route;
    const header = request.headers.authorization;
    if (closing || tickets.size >= maxPending) throw deny(503, "meter_busy");
    const controller = new AbortController(),
      taskController = new AbortController();
    const deadline = work.deadline;
    const signal = AbortSignal.any([controller.signal, work.signal]);
    let releaseTicket;
    const ticket = {
      controller,
      taskController,
      done: new Promise((r) => (releaseTicket = r)),
    };
    tickets.add(ticket);
    peak = Math.max(peak, tickets.size);
    let hold,
      terminalStarted = false,
      finished = false,
      closed = false,
      preparedStatus;
    const emit = (stage, detail = {}) =>
      observe(request, stage, { ...detail, hold: hold ?? null });
    const cleanup = () => {
      clearTimeout(timer);
      request.raw.removeListener("aborted", abort);
      work.signal.removeEventListener("abort", abort);
      reply.raw.removeListener("finish", finish);
      reply.raw.removeListener("close", close);
      tickets.delete(ticket);
      releaseTicket();
    };
    const terminalize = (success, status, reason) => {
      if (!hold || terminalStarted) return;
      terminalStarted = true;
      clearTimeout(timer);
      const due = performance.now() + finalizationMs;
      const bound = setTimeout(() => taskController.abort(), finalizationMs);
      void (async () => {
        let state = "uncertain",
          attempts = 0;
        try {
          for (
            ;
            attempts < 2 &&
            performance.now() < due &&
            !taskController.signal.aborted;
          ) {
            attempts++;
            try {
              state = await meter.finalize(hold, success, status, reason, {
                deadline: due,
                signal: taskController.signal,
              });
              break;
            } catch {
              /* Same ID only; one retry within the original total budget. */
            }
          }
          emit("terminal", { state, attempts, successIntent: success, status });
        } finally {
          clearTimeout(bound);
          cleanup();
        }
      })();
    };
    ticket.cancel = () => {
      controller.abort();
      terminalize(false, null, "disconnect");
    };
    const abort = () => {
      controller.abort();
      terminalize(false, null, "disconnect");
    };
    const finish = () => {
      finished = reply.raw.writableFinished;
      preparedStatus = reply.statusCode;
      emit("finish", { finished, status: preparedStatus });
      if (finished)
        terminalize(
          !signal.aborted &&
            (preparedStatus === 200 || preparedStatus === 304),
          preparedStatus,
          "error",
        );
    };
    const close = () => {
      closed = true;
      emit("close", {
        finished: reply.raw.writableFinished,
        status: reply.statusCode,
      });
      if (!reply.raw.writableFinished) {
        abort();
        terminalize(false, null, "disconnect");
      }
    };
    const timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
    work.signal.addEventListener("abort", abort, { once: true });
    request.raw.once("aborted", abort);
    reply.raw.once("finish", finish);
    reply.raw.once("close", close);
    try {
      if (work.signal.aborted || request.raw.aborted || reply.raw.destroyed) controller.abort();
      emit("reserve_begin");
      hold = await meter.reserve(header.slice(7), route, request.method, {
        deadline,
        signal,
      });
      emit("reserved");
      if (
        signal.aborted ||
        request.raw.aborted ||
        reply.raw.destroyed ||
        closed
      ) {
        terminalize(false, null, "disconnect");
        if (reply.raw.destroyed) {
          reply.hijack();
          return;
        }
        throw deny(503, "source_unavailable");
      }
      // No account lock/connection is held once this hook returns to analytics.
    } catch (error) {
      const ambiguous = uncertainHold(error);
      if (ambiguous) {
        hold = ambiguous;
        emit("reserve_uncertain");
        terminalize(false, null, "uncertain");
      } else if (hold) terminalize(false, null, "disconnect");
      else {
        emit("reserve_failed", {
          code: codes.has(error.code) ? error.code : "unavailable",
        });
        cleanup();
      }
      if (reply.raw.destroyed) {
        reply.hijack();
        return;
      }
      if (codes.has(error.code))
        throw deny(error.status, error.code.toLowerCase());
      throw deny(503, "source_unavailable");
    }
  };
  return {
    begin,
    stats: () => ({ pending: tickets.size, peak, maxPending }),
    async close() {
      closing = true;
      for (const t of tickets) t.cancel();
      const timer = setTimeout(() => {
        for (const t of tickets) t.taskController.abort();
      }, 2000);
      try {
        await Promise.allSettled([...tickets].map((t) => t.done));
      } finally {
        clearTimeout(timer);
      }
      await meter.drain();
    },
  };
}
