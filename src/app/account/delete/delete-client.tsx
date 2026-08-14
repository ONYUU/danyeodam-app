"use client";

import { createClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  deletionCopy,
  type DeletionLocale,
} from "@/app/account/delete/copy";
import {
  clearDeletionCredential,
  createDeletionCredential,
  readDeletionCredential,
  storeDeletionCredential,
  type DeletionCredential,
} from "@/app/account/delete/credential";
import { signInReviewerWithPassword } from "@/app/account/delete/reviewer-auth";

type PublicDeletionStatus = {
  status: "pending" | "completed" | "action_required";
  support_url: string | null;
};

type Props = {
  locale: DeletionLocale;
  developerName: string | null;
  supportUrl: string | null;
  publicAppUrl: string | null;
  supabaseUrl: string;
  supabaseAnonKey: string;
};

function accessTokenFromSession(
  session: { access_token?: string } | null,
): string | null {
  return typeof session?.access_token === "string" && session.access_token !== ""
    ? session.access_token
    : null;
}

export function AccountDeletionClient(props: Props) {
  const copy = deletionCopy[props.locale];
  const [email, setEmail] = useState("");
  const [reviewerPassword, setReviewerPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [credential, setCredential] = useState<DeletionCredential | null>(null);
  const [status, setStatus] = useState<PublicDeletionStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const supabase = useMemo(() => createClient(
    props.supabaseUrl,
    props.supabaseAnonKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
      },
    },
  ), [props.supabaseAnonKey, props.supabaseUrl]);

  const checkStatus = useCallback(async (saved: DeletionCredential) => {
    const response = await fetch(`/api/account/deletion-requests/${saved.requestId}`, {
      headers: { "X-Deletion-Status-Token": saved.statusToken },
      cache: "no-store",
    });
    if (!response.ok) throw new Error("status unavailable");
    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null) throw new Error("invalid status");
    const publicStatus = Reflect.get(parsed, "status");
    const supportUrl = Reflect.get(parsed, "support_url");
    if (
      !["pending", "completed", "action_required"].includes(String(publicStatus))
      || (supportUrl !== null && typeof supportUrl !== "string")
    ) throw new Error("invalid status");
    const next = {
      status: publicStatus as PublicDeletionStatus["status"],
      support_url: supportUrl as string | null,
    };
    setStatus(next);
    if (next.status === "completed") {
      try {
        clearDeletionCredential(window.localStorage);
      } catch {
        // Local Storage can be disabled. Completion and local Auth sign-out
        // must not depend on clearing a non-authoritative browser cache.
      }
      setCredential(null);
      await supabase.auth.signOut({ scope: "local" });
      setAccessToken(null);
    }
  }, [supabase]);

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setAccessToken(accessTokenFromSession(data.session));
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setAccessToken(accessTokenFromSession(session));
    });
    const restoreTimer = window.setTimeout(() => {
      let saved: DeletionCredential | null;
      try {
        saved = readDeletionCredential(window.localStorage);
      } catch {
        if (active) setMessage(copy.genericError);
        return;
      }
      if (saved === null || !active) return;
      setCredential(saved);
      void checkStatus(saved).catch(() => {
        if (active) setMessage(copy.genericError);
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(restoreTimer);
      listener.subscription.unsubscribe();
    };
  }, [checkStatus, copy.genericError, supabase]);

  const sendEmailLink = async () => {
    if (props.publicAppUrl === null || email.trim() === "") return;
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: `${props.publicAppUrl}/account/delete`,
          shouldCreateUser: false,
        },
      });
      if (error !== null) throw error;
      setMessage(copy.emailSent);
    } catch {
      setMessage(copy.emailSent);
    } finally {
      setBusy(false);
    }
  };

  const signInReviewer = async () => {
    const normalizedEmail = email.trim();
    if (normalizedEmail === "" || reviewerPassword === "") return;
    const password = reviewerPassword;
    setReviewerPassword("");
    setBusy(true);
    setMessage(null);
    try {
      const token = await signInReviewerWithPassword(
        supabase.auth,
        normalizedEmail,
        password,
      );
      if (token === null) {
        setMessage(copy.reviewerSignInError);
        return;
      }
      setAccessToken(token);
      setMessage(copy.authenticated);
    } catch {
      setMessage(copy.reviewerSignInError);
    } finally {
      setBusy(false);
    }
  };

  const submitDeletion = async (mode: "authenticated" | "recovery") => {
    if (!confirmed) return;
    let saved = credential;
    if (saved === null) {
      try {
        saved = createDeletionCredential(window.crypto);
        storeDeletionCredential(window.localStorage, saved);
        setCredential(saved);
      } catch {
        setMessage(copy.genericError);
        return;
      }
    }
    setBusy(true);
    setMessage(null);
    try {
      const endpoint = mode === "authenticated"
        ? "/api/me/deletion-requests"
        : "/api/account/deletion-requests/recovery";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(mode === "authenticated" && accessToken !== null
            ? { Authorization: `Bearer ${accessToken}` }
            : {}),
        },
        body: JSON.stringify({
          ...(mode === "recovery" ? { recovery_code: recoveryCode.trim() } : {}),
          client_request_id: saved.requestId,
          status_token: saved.statusToken,
          confirmation: "DELETE_MY_ACCOUNT",
        }),
      });
      if (!response.ok) throw new Error("request failed");
      await checkStatus(saved);
    } catch {
      setMessage(copy.genericError);
    } finally {
      setBusy(false);
    }
  };

  const statusText = status?.status === "completed"
    ? copy.completed
    : status?.status === "action_required"
      ? copy.actionRequired
      : status?.status === "pending"
        ? copy.pending
        : null;
  const effectiveSupport = status?.support_url ?? props.supportUrl;
  const configured = props.developerName !== null
    && props.supportUrl !== null
    && props.publicAppUrl !== null;

  return (
    <main>
      <section className="deletion-panel">
        <header>
          <p className="deletion-brand">DANYEODAM · 다녀담</p>
          <h1>{copy.title}</h1>
          <p>{copy.intro}</p>
        </header>
        <dl className="deletion-details">
          <div><dt>{copy.developer}</dt><dd>{props.developerName ?? copy.unavailable}</dd></div>
        </dl>
        <p>{copy.scope}</p>
        <p><strong>{copy.deadline}</strong></p>

        {!configured ? <p role="alert">{copy.unavailable}</p> : null}

        {statusText !== null ? (
          <section aria-live="polite" className="deletion-status">
            <h2>{statusText}</h2>
            {status?.status !== "completed" && credential !== null ? (
              <button disabled={busy} onClick={() => void checkStatus(credential)} type="button">
                {copy.retry}
              </button>
            ) : null}
            {status?.status === "action_required" && effectiveSupport !== null ? (
              <a href={effectiveSupport} rel="noreferrer">{copy.support}</a>
            ) : null}
          </section>
        ) : (
          <>
            <section className="deletion-form">
              <label htmlFor="deletion-email">{copy.emailLabel}</label>
              <input
                autoComplete="email"
                id="deletion-email"
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                value={email}
              />
              <button disabled={busy || !configured} onClick={() => void sendEmailLink()} type="button">
                {copy.emailAction}
              </button>
              {accessToken !== null ? <p>{copy.authenticated}</p> : null}
            </section>

            {accessToken === null ? (
              <section className="deletion-form">
                <h2>{copy.reviewerTitle}</h2>
                <p>{copy.reviewerDescription}</p>
                <label htmlFor="deletion-reviewer-password">{copy.reviewerPasswordLabel}</label>
                <input
                  autoComplete="current-password"
                  id="deletion-reviewer-password"
                  onChange={(event) => setReviewerPassword(event.target.value)}
                  type="password"
                  value={reviewerPassword}
                />
                <button
                  disabled={busy || !configured || email.trim() === "" || reviewerPassword === ""}
                  onClick={() => void signInReviewer()}
                  type="button"
                >
                  {copy.reviewerPasswordAction}
                </button>
              </section>
            ) : null}

            <section className="deletion-form">
              <label htmlFor="deletion-recovery">{copy.recoveryLabel}</label>
              <input
                autoCapitalize="none"
                autoComplete="off"
                id="deletion-recovery"
                onChange={(event) => setRecoveryCode(event.target.value)}
                type="password"
                value={recoveryCode}
              />
            </section>

            <label className="deletion-confirm">
              <input
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                type="checkbox"
              />
              <span>{copy.confirm}</span>
            </label>

            <div className="deletion-actions">
              {accessToken !== null ? (
                <button disabled={busy || !confirmed || !configured} onClick={() => void submitDeletion("authenticated")} type="button">
                  {copy.deleteAction}
                </button>
              ) : null}
              <button
                disabled={busy || !confirmed || recoveryCode.trim() === "" || !configured}
                onClick={() => void submitDeletion("recovery")}
                type="button"
              >
                {copy.recoveryAction}
              </button>
            </div>
          </>
        )}

        {message !== null ? <p aria-live="polite">{message}</p> : null}
        {effectiveSupport !== null ? <a href={effectiveSupport} rel="noreferrer">{copy.support}</a> : null}
      </section>
    </main>
  );
}
