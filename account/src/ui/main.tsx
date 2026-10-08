import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
async function api(url: string, body?: unknown) {
  const r = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok)
    throw Error(
      d.error === "AUTH_LINK_RETRY_REQUEST_NEW"
        ? "This link could not be completed. Request a fresh recovery link below."
        : d.error || d.message || "Request failed",
    );
  return d;
}
function App() {
  const [user, setUser] = useState<any>(null),
    [data, setData] = useState<any>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [secret, setSecret] = useState(""),
    [token] = useState(
      () => new URLSearchParams(location.search).get("token") || "",
    ),
    [result, setResult] = useState("");
  async function refresh() {
    const s = await api("/api/auth/get-session");
    setUser(s?.user);
    if (s?.user) setData(await api("/api/account"));
  }
  useEffect(() => {
    void refresh().catch(() => {});
    if (token) history.replaceState(null, "", "/reset");
  }, []);
  async function act(fn: () => Promise<any>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function form(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget));
  }
  const active =
    data?.grants.filter(
      (g: any) =>
        !g.refunded &&
        new Date(g.starts_at) <= new Date() &&
        new Date(g.ends_at) > new Date(),
    ) || [];
  let coverageEnd = Date.now();
  for (const g of [...(data?.grants || [])]
    .filter((g: any) => !g.refunded)
    .sort(
      (a: any, b: any) => +new Date(a.starts_at) - +new Date(b.starts_at),
    )) {
    if (+new Date(g.starts_at) > coverageEnd) break;
    coverageEnd = Math.max(coverageEnd, +new Date(g.ends_at));
  }
  return (
    <>
      <div className="banner">
        LAB — NO REAL PAYMENTS · Isolated synthetic data
      </div>
      <main>
        <header>
          <div className="mark">H</div>
          <div>
            <p className="eyebrow">HEX DAILY DATA / FOUNDATION EXPERIMENT</p>
            <h1>Developer access</h1>
          </div>
          {user && (
            <button
              onClick={() =>
                act(async () => {
                  await api("/api/auth/sign-out", {});
                  setData(null);
                  setSecret("");
                })
              }
            >
              Sign out
            </button>
          )}
        </header>
        <p className="intro">
          A local account, prepaid access and API keys. PLS and card events are
          internal simulations; no wallet debit, real payment confirmation or
          settlement occurs.
        </p>
        <p role="status" className="notice">
          {busy ? "Working…" : message}
        </p>
        {!user ? (
          <section className="grid">
            <article>
              <h2>{token ? "Reset password" : "Welcome to the lab"}</h2>
              <form
                onSubmit={(e) => {
                  const b = form(e);
                  void act(async () => {
                    if (token) {
                      await api("/api/auth/reset-password", {
                        token,
                        newPassword: b.password,
                      });
                      setMessage(
                        "Password reset. Return to the home page to sign in.",
                      );
                    } else {
                      await api("/api/auth/sign-in/email", b);
                      setMessage("Signed in.");
                    }
                  });
                }}
              >
                {!token && (
                  <label>
                    Email
                    <input
                      name="email"
                      type="email"
                      placeholder="member@example.test"
                      required
                      autoComplete="username"
                    />
                  </label>
                )}
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    minLength={12}
                    maxLength={128}
                    required
                    autoComplete={token ? "new-password" : "current-password"}
                  />
                </label>
                <button disabled={busy}>
                  {token ? "Save new password" : "Sign in"}
                </button>
              </form>
            </article>
            <article>
              <h2>Create your account</h2>
              <p>
                Use an example.test address. Verification arrives only in the
                local inbox.
              </p>
              <form
                onSubmit={(e) => {
                  const b = form(e);
                  void act(async () => {
                    await api("/api/auth/sign-up/email", b);
                    setMessage(
                      "Check the local inbox for your verification link.",
                    );
                  });
                }}
              >
                <label>
                  Email
                  <input
                    name="email"
                    type="email"
                    required
                    placeholder="member@example.test"
                  />
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    minLength={12}
                    maxLength={128}
                    required
                    autoComplete="new-password"
                  />
                </label>
                <button disabled={busy}>Register</button>
              </form>
              <form
                onSubmit={(e) => {
                  const b = form(e);
                  void act(async () => {
                    const action = (
                      e.nativeEvent as SubmitEvent
                    ).submitter?.getAttribute("value");
                    await api(
                      action === "verify"
                        ? "/api/auth/send-verification-email"
                        : "/api/auth/request-password-reset",
                      b,
                    );
                    setMessage(
                      "If eligible, a fresh recovery link is in the local inbox. Use a fresh link after an expired, used or failed link.",
                    );
                  });
                }}
              >
                <label>
                  Email for recovery
                  <input name="email" type="email" required />
                </label>
                <button className="secondary" disabled={busy}>
                  Send reset link
                </button>
                <button className="secondary" disabled={busy} value="verify">
                  Send verification link
                </button>
              </form>
            </article>
          </section>
        ) : (
          data && (
            <>
              <section className="stats">
                <article>
                  <p className="eyebrow">ACCOUNT</p>
                  <strong>{user.email}</strong>
                  <p>Verified · immutable account identity</p>
                </article>
                <article>
                  <p className="eyebrow">COVERAGE NOW</p>
                  <strong>{active.length ? "Active" : "Inactive"}</strong>
                  <p>
                    {active.length
                      ? Math.ceil((coverageEnd - Date.now()) / 86400000) +
                        " days of continuous coverage"
                      : "Purchase a fixture to test access"}
                  </p>
                </article>
                <article>
                  <p className="eyebrow">UTC DAILY QUOTA</p>
                  <strong>{data.remaining} / 100</strong>
                  <p>Shared across all keys · 30 per fixed UTC minute</p>
                </article>
              </section>
              <section className="grid">
                <article>
                  <h2>Add test coverage</h2>
                  <p>
                    PLS is prepaid, exactly 30 or 90 UTC days. Monthly card
                    fixtures use the actual calendar period. Amounts are
                    fixtures, not a market quote.
                  </p>
                  <div className="actions">
                    {[30, 90, 365].map((days) => (
                      <button
                        key={days}
                        disabled={busy || (days === 365 && !data.annualDemo)}
                        onClick={() =>
                          act(async () => {
                            await api("/api/invoices", { mode: "pls", days });
                            setMessage(
                              "Invoice saved. Confirm its internal simulation below.",
                            );
                          })
                        }
                      >
                        {days} days PLS{days === 365 ? " · demo disabled" : ""}
                      </button>
                    ))}
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          api("/api/invoices", { mode: "card", days: 30 }),
                        )
                      }
                    >
                      Monthly card fixture
                    </button>
                  </div>
                  <p>
                    Card auto-renew:{" "}
                    {data.customer.card_active ? "simulated active" : "off"} ·
                    Collectible: {data.customer.card_due ? "yes" : "no"}
                  </p>
                  <p>
                    Overlapping payment modes are blocked. Cancel at period end
                    preserves paid time.
                  </p>
                </article>
                <article>
                  <h2>API keys</h2>
                  <p>
                    A key is shown once. Renewal preserves it; revocation is
                    permanent.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        const k = await api("/api/keys", {
                          label: "Dashboard key",
                        });
                        setSecret(k.secret);
                        setMessage(
                          "Copy your key now. It is not available again.",
                        );
                      })
                    }
                  >
                    Create key
                  </button>
                  {secret && (
                    <div className="key">
                      <label>
                        New key (shown once)
                        <input
                          value={secret}
                          readOnly
                          type="password"
                          aria-label="New API key"
                        />
                      </label>
                      <button
                        onClick={() => {
                          void navigator.clipboard.writeText(secret);
                          setMessage("Key copied.");
                        }}
                      >
                        Copy
                      </button>
                      <button onClick={() => setSecret("")}>Dismiss key</button>
                    </div>
                  )}
                  <ul>
                    {data.keys.map((k: any) => (
                      <li key={k.id}>
                        <span>
                          {k.label} · {k.prefix}… ·{" "}
                          {k.revoked ? "revoked" : "active"}
                        </span>
                        {!k.revoked && (
                          <>
                            <button
                              className="small"
                              onClick={() =>
                                act(() => api("/api/keys/revoke", { id: k.id }))
                              }
                            >
                              Revoke
                            </button>
                            <button
                              className="small"
                              onClick={() =>
                                act(async () => {
                                  const next = await api("/api/keys", {
                                    label: k.label,
                                    rotate: k.id,
                                  });
                                  setSecret(next.secret);
                                })
                              }
                            >
                              Rotate
                            </button>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                  <form
                    onSubmit={(e) => {
                      const b = form(e);
                      void act(async () => {
                        const r = await fetch("/api/data", {
                          headers: { authorization: "Bearer " + b.key },
                        });
                        const d = await r.json();
                        setResult(JSON.stringify(d, null, 2));
                      });
                    }}
                  >
                    <label>
                      Test protected synthetic GET
                      <input
                        name="key"
                        type="password"
                        defaultValue={secret}
                        autoComplete="off"
                        required
                      />
                    </label>
                    <button disabled={busy}>Request synthetic data</button>
                  </form>
                  {result && <pre>{result}</pre>}
                </article>
              </section>
              <article>
                <h2>Saved invoices & purchase history</h2>
                <div className="history">
                  {data.invoices.length === 0 ? (
                    <p>No invoices yet.</p>
                  ) : (
                    data.invoices.map((i: any) => (
                      <div className="invoice" key={i.id}>
                        <div>
                          <strong>
                            {i.mode === "pls"
                              ? i.days + " day prepaid PLS"
                              : "Calendar card period"}
                          </strong>
                          <p className="mono">
                            {i.amount}{" "}
                            {i.mode === "pls"
                              ? "PLS base units (fixture)"
                              : "USD cents (fixture)"}
                          </p>
                          <small>
                            {i.id} · {i.status}
                          </small>
                        </div>
                        <div className="actions">
                          {i.status === "open" && (
                            <>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  act(async () => {
                                    const r = await api("/api/simulate", {
                                      invoiceId: i.id,
                                    });
                                    setMessage(
                                      "Internal simulation: " + r.result,
                                    );
                                  })
                                }
                              >
                                Simulate purchase
                              </button>
                              <button
                                className="secondary"
                                onClick={() =>
                                  act(() =>
                                    api("/api/simulate", {
                                      invoiceId: i.id,
                                      missCallback: true,
                                    }),
                                  )
                                }
                              >
                                Miss callback test
                              </button>
                            </>
                          )}
                          {i.mode === "card" && (
                            <button
                              className="secondary"
                              onClick={() =>
                                act(() =>
                                  api("/api/simulate", {
                                    invoiceId: i.id,
                                    status: "cancel",
                                  }),
                                )
                              }
                            >
                              Cancel auto-renew
                            </button>
                          )}
                          {i.status === "granted" && (
                            <button
                              className="secondary"
                              onClick={() =>
                                act(() =>
                                  api("/api/simulate", {
                                    invoiceId: i.id,
                                    status: "refund",
                                  }),
                                )
                              }
                            >
                              Simulate full refund
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <button className="secondary" onClick={() => act(refresh)}>
                  Refresh status
                </button>{" "}
                <a href={data.inboxOrigin} target="_blank" rel="noreferrer">
                  Open local inbox
                </a>
              </article>
            </>
          )
        )}
        <footer>
          Local experiment only. Annual offers, pricing, finality and provider
          eligibility remain unproven. Public data pages are outside this lab.
        </footer>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
