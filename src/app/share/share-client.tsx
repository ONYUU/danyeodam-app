"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Image from "next/image";

import {
  PUBLIC_SHARE_COPY,
  type PublicShareLocale,
} from "@/app/share/copy";
import { postPublicShareJson } from "@/app/share/request";
import {
  consumePublicShareAgeResponse,
  consumePublicSharePhotoResponse,
  consumePublicShareReportResponse,
  consumePublicShareResolveResponse,
} from "@/app/share/response";
import {
  classifyDateOfBirth,
  consumeShareSecretFromFragment,
  PUBLIC_SHARE_AGE_VERSION,
  PUBLIC_SHARE_ENDPOINTS,
  publicShareReportBody,
  publicShareBlockAppUrl,
  publicShareSecretBody,
  selectSpotName,
  type ResolvedPublicShare,
} from "@/app/share/transport";

type Stage = "loading" | "age" | "ready" | "unavailable";

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export function ShareClient({ locale }: { locale: PublicShareLocale }) {
  const secretRef = useRef<string | null>(null);
  const photoObjectUrlRef = useRef<string | null>(null);
  const lifecycleControllerRef = useRef<AbortController | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [share, setShare] = useState<ResolvedPublicShare | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [ageMessage, setAgeMessage] = useState<string | null>(null);
  const [reportMessage, setReportMessage] = useState<string | null>(null);
  const copy = PUBLIC_SHARE_COPY[locale];

  const replacePhotoObjectUrl = useCallback((next: string | null) => {
    if (photoObjectUrlRef.current !== null) {
      URL.revokeObjectURL(photoObjectUrlRef.current);
    }
    photoObjectUrlRef.current = next;
    setPhotoUrl(next);
  }, []);

  const resolveShare = useCallback(async (shareSecret: string, signal?: AbortSignal) => {
    setStage("loading");
    setAgeMessage(null);
    const resolution = await postPublicShareJson(
      PUBLIC_SHARE_ENDPOINTS.resolve,
      publicShareSecretBody(shareSecret),
      consumePublicShareResolveResponse,
      signal,
    );
    if (isAborted(signal)) return;
    if (resolution.kind === "age") {
      setStage("age");
      return;
    }
    if (resolution.kind === "unavailable") {
      setStage("unavailable");
      return;
    }

    const photo = await postPublicShareJson(
      PUBLIC_SHARE_ENDPOINTS.photo,
      publicShareSecretBody(shareSecret),
      consumePublicSharePhotoResponse,
      signal,
    );
    if (isAborted(signal)) return;
    if (photo === null) {
      setStage("unavailable");
      return;
    }
    replacePhotoObjectUrl(URL.createObjectURL(photo));
    setShare(resolution.share);
    setStage("ready");
  }, [replacePhotoObjectUrl]);

  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    secretRef.current ??= consumeShareSecretFromFragment(window);
    if (secretRef.current === null) {
      setStage("unavailable");
      return;
    }
    const controller = new AbortController();
    lifecycleControllerRef.current = controller;
    void resolveShare(secretRef.current, controller.signal).catch(() => {
      if (!controller.signal.aborted) {
        setStage("unavailable");
      }
    });
    return () => {
      controller.abort();
      if (lifecycleControllerRef.current === controller) {
        lifecycleControllerRef.current = null;
      }
    };
  }, [locale, resolveShare]);

  useEffect(() => () => {
    if (photoObjectUrlRef.current !== null) {
      URL.revokeObjectURL(photoObjectUrlRef.current);
    }
  }, []);

  async function submitAge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const ageCheck = (() => {
      const value = new FormData(form).get("date_of_birth");
      let dateOfBirth = typeof value === "string" ? value : "";
      const result = classifyDateOfBirth(dateOfBirth);
      form.reset();
      dateOfBirth = "";
      return result;
    })();
    if (ageCheck === "invalid") {
      setAgeMessage(copy.invalidDate);
      return;
    }
    if (ageCheck === "underage") {
      lifecycleControllerRef.current?.abort();
      lifecycleControllerRef.current = null;
      secretRef.current = null;
      setAgeMessage(null);
      setStage("unavailable");
      return;
    }

    setAgeMessage(null);
    const response = await postPublicShareJson(
      PUBLIC_SHARE_ENDPOINTS.ageAttestation,
      JSON.stringify({ pass: true, version: PUBLIC_SHARE_AGE_VERSION }),
      consumePublicShareAgeResponse,
      lifecycleControllerRef.current?.signal,
    ).catch(() => null);
    const secret = secretRef.current;
    if (response !== true || secret === null) {
      setStage("unavailable");
      return;
    }
    await resolveShare(secret, lifecycleControllerRef.current?.signal)
      .catch(() => setStage("unavailable"));
  }

  async function submitReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secret = secretRef.current;
    if (secret === null) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const reason = typeof data.get("reason") === "string" ? String(data.get("reason")) : "other";
    const rawComment = typeof data.get("comment") === "string" ? String(data.get("comment")).trim() : "";
    form.reset();
    setReportMessage(copy.reportSubmitting);
    const response = await postPublicShareJson(
      PUBLIC_SHARE_ENDPOINTS.report,
      publicShareReportBody({
        shareSecret: secret,
        clientReportId: crypto.randomUUID(),
        reason,
        ...(rawComment === "" ? {} : { comment: rawComment }),
      }),
      consumePublicShareReportResponse,
      lifecycleControllerRef.current?.signal,
    ).catch(() => null);
    setReportMessage(response === true ? copy.reportReceived : copy.reportFailed);
  }

  function hideShare() {
    lifecycleControllerRef.current?.abort();
    lifecycleControllerRef.current = null;
    secretRef.current = null;
    replacePhotoObjectUrl(null);
    setShare(null);
    setStage("unavailable");
  }

  function openBlockInApp() {
    const secret = secretRef.current;
    if (secret === null) return;
    const destination = publicShareBlockAppUrl(secret);
    if (destination !== null) window.location.assign(destination);
  }

  if (stage === "loading") {
    return <p role="status">{copy.checking}</p>;
  }
  if (stage === "age") {
    return (
      <section aria-labelledby="age-title" className="share-panel">
        <h1 id="age-title">{copy.ageTitle}</h1>
        <p>{copy.agePrompt}</p>
        <form className="share-form" onSubmit={(event) => void submitAge(event)}>
          <label htmlFor="date-of-birth">{copy.dateOfBirth}</label>
          <input id="date-of-birth" name="date_of_birth" type="date" required autoComplete="off" />
          <button type="submit">{copy.confirm}</button>
        </form>
        {ageMessage === null ? null : <p role="alert">{ageMessage}</p>}
        <p className="share-note">{copy.dobPrivacy}</p>
      </section>
    );
  }
  if (stage === "unavailable" || share === null || photoUrl === null) {
    return (
      <section className="share-panel">
        <h1>{copy.shareTitle}</h1>
        <p>{copy.unavailable}</p>
      </section>
    );
  }

  const spotName = selectSpotName(share.spotName, locale);
  return (
    <article className="share-panel">
      <header>
        <p className="share-brand">{copy.brand}</p>
        <h1>{spotName}</h1>
        <time dateTime={share.dateKst}>{share.dateKst}</time>
      </header>
      {/* The blob URL is revocable and never contains the share secret. */}
      <Image
        className="share-photo"
        src={photoUrl}
        alt={copy.imageAlt}
        width={2_048}
        height={2_048}
        unoptimized
      />
      <p>{share.caption}</p>
      <div className="share-actions">
        <button type="button" onClick={hideShare}>{copy.hide}</button>
        <button type="button" onClick={openBlockInApp}>{copy.blockInApp}</button>
      </div>
      <details>
        <summary>{copy.report}</summary>
        <form className="share-form" onSubmit={(event) => void submitReport(event)}>
          <label htmlFor="report-reason">{copy.reason}</label>
          <select id="report-reason" name="reason" defaultValue="privacy">
            <option value="sexual_content">{copy.reportReasons.sexual_content}</option>
            <option value="violence">{copy.reportReasons.violence}</option>
            <option value="hate_or_harassment">{copy.reportReasons.hate_or_harassment}</option>
            <option value="privacy">{copy.reportReasons.privacy}</option>
            <option value="copyright">{copy.reportReasons.copyright}</option>
            <option value="spam">{copy.reportReasons.spam}</option>
            <option value="illegal">{copy.reportReasons.illegal}</option>
            <option value="other">{copy.reportReasons.other}</option>
          </select>
          <label htmlFor="report-comment">{copy.comment}</label>
          <textarea id="report-comment" name="comment" maxLength={300} />
          <button type="submit">{copy.submitReport}</button>
        </form>
        {reportMessage === null ? null : <p role="status">{reportMessage}</p>}
      </details>
    </article>
  );
}
