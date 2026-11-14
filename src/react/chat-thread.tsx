/**
 * `<ChatThread>`: the whole conversation for one participant: who they're talking with and the time left, the
 * messages, a composer that shows why a message was refused (and offers a review when it can be appealed), and the
 * outcomes they may choose, each confirmed in place. Plain CSS with `cc-` classes and `--cc-` variables
 * (`chaperone-chat/react/styles.css`); every word through `labels`.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { DEFAULT_LABELS, type ChatLabels } from "./labels";
import { useChatThread, type UseChatThreadOptions } from "./use-chat-thread";

export interface ChatThreadProps extends UseChatThreadOptions {
  labels?: Partial<ChatLabels>;
  className?: string;
}

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

export function ChatThread(props: ChatThreadProps) {
  const { labels: overrides, className, ...options } = props;
  const labels: ChatLabels = { ...DEFAULT_LABELS, ...overrides };
  const { state, send, appeal, resolve } = useChatThread(options);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<null | "send" | "resolve">(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [appealable, setAppealable] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [resolveNote, setResolveNote] = useState<string | null>(null);
  const textId = useId();
  const endRef = useRef<HTMLLIElement | null>(null);
  const seen = useRef(0);

  // Bring a new message into view.
  useEffect(() => {
    if (state.messages.length > seen.current) endRef.current?.scrollIntoView?.({ block: "nearest" });
    seen.current = state.messages.length;
  }, [state.messages.length]);

  if (state.status === "idle" || state.status === "loading") {
    return (
      <section className={cx("cc-thread", className)}>
        <div className="cc-card cc-loading" role="status">
          {labels.loading}
        </div>
      </section>
    );
  }
  if (state.status === "error" || !state.conversation || !state.you) {
    return (
      <section className={cx("cc-thread", className)}>
        <div className="cc-card" role="alert">
          {labels.error(state.error ?? "server_error")}
        </div>
      </section>
    );
  }

  const conversation = state.conversation;
  const you = state.you;
  const others = state.participants.filter((p) => p.id !== you.id).map((p) => p.alias);
  const open = conversation.open;
  const max = state.maxChars ?? 1_000;
  const status = open ? labels.timeLeft(conversation.msLeft) : conversation.state === "closed" ? labels.closed(conversation.outcome) : labels.closing;
  const counter = labels.counter(text.length, max);

  async function submit(asAppeal: boolean) {
    const body = asAppeal ? (appealable ?? "") : text;
    if (busy) return;
    if (!body.trim()) {
      setProblem(labels.error("empty"));
      return;
    }
    setBusy("send");
    setProblem(null);
    setNotice(null);
    setAppealable(null);
    try {
      const result = asAppeal ? await appeal(body) : await send(body);
      if (result.ok) {
        setText("");
        if (result.held) setNotice(labels.held);
      } else {
        setProblem(labels.error(result.error, result.message));
        if (result.appealable) setAppealable(body);
      }
    } catch {
      setProblem(labels.error("network"));
    } finally {
      setBusy(null);
    }
  }

  async function choose(outcome: string) {
    setBusy("resolve");
    setResolveNote(null);
    try {
      const result = await resolve(outcome);
      if (result.ok) {
        if (result.state === "waiting") setResolveNote(labels.waiting((result.waitingFor ?? []).map((p) => p.alias)));
      } else {
        setResolveNote(labels.error(result.error, result.message));
      }
    } catch {
      setResolveNote(labels.error("network"));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit(false);
  }

  return (
    <section className={cx("cc-thread", className)}>
      <header className="cc-card cc-header">
        <p className="cc-kicker">{labels.talkingWith(others)}</p>
        {status ? <p className="cc-status">{status}</p> : null}
        {open && labels.privacy ? <p className="cc-muted">{labels.privacy}</p> : null}
      </header>

      <div className="cc-card">
        {state.hasOlder ? <p className="cc-muted">{labels.olderHidden}</p> : null}
        {state.messages.length === 0 ? (
          <p className="cc-empty">{open ? labels.empty : labels.emptyClosed}</p>
        ) : (
          <ol className="cc-messages" aria-label={labels.messagesLabel} aria-live="polite">
            {state.messages.map((m) => (
              <li key={m.id} className={cx("cc-message", m.mine && "cc-message--mine", m.status !== "sent" && "cc-message--pending")}>
                <span className="cc-sr">{m.mine ? labels.you : m.alias}:</span>
                {m.body !== null ? <p className="cc-body">{m.body}</p> : null}
                {m.note ? <p className="cc-note">{m.note}</p> : null}
                <p className="cc-meta">
                  <span aria-hidden="true">{m.mine ? "" : `${m.alias} · `}</span>
                  {labels.time(m.at)}
                </p>
              </li>
            ))}
            <li ref={endRef} aria-hidden="true" className="cc-end" />
          </ol>
        )}
      </div>

      {open ? (
        <form className="cc-card cc-composer" onSubmit={onSubmit}>
          <label className="cc-sr" htmlFor={textId}>
            {labels.messageLabel}
          </label>
          <textarea
            id={textId}
            className="cc-textarea"
            value={text}
            rows={3}
            maxLength={max * 2}
            placeholder={labels.placeholder}
            onChange={(e) => {
              setText(e.target.value);
              if (problem) setProblem(null);
              if (appealable) setAppealable(null);
            }}
            onKeyDown={onKeyDown}
          />
          <div className="cc-row">
            <span className={cx("cc-counter", text.length > max && "cc-counter--over")}>{counter}</span>
            <button type="submit" className="cc-button" disabled={busy !== null}>
              {busy === "send" ? labels.sending : labels.send}
            </button>
          </div>
          {problem ? (
            <div className="cc-alert" role="alert">
              <p className="cc-error">{problem}</p>
              {appealable !== null ? (
                <button type="button" className="cc-button cc-button--quiet" disabled={busy !== null} onClick={() => void submit(true)}>
                  {labels.appeal}
                </button>
              ) : null}
            </div>
          ) : null}
          {notice ? (
            <p className="cc-muted" role="status">
              {notice}
            </p>
          ) : null}
        </form>
      ) : null}

      {open && state.outcomes.length > 0 ? (
        <div className="cc-card cc-outcomes">
          {confirming ? (
            <div className="cc-confirm">
              <p>{labels.confirmOutcome(confirming)}</p>
              <div className="cc-row">
                <button type="button" className="cc-button" disabled={busy !== null} onClick={() => void choose(confirming)}>
                  {labels.confirmYes(confirming)}
                </button>
                <button type="button" className="cc-button cc-button--quiet" disabled={busy !== null} onClick={() => setConfirming(null)}>
                  {labels.confirmNo}
                </button>
              </div>
            </div>
          ) : (
            <div className="cc-row cc-row--start">
              {state.outcomes.map((o) => (
                <button
                  key={o}
                  type="button"
                  className="cc-button cc-button--quiet"
                  disabled={busy !== null || state.voted.includes(o)}
                  onClick={() => setConfirming(o)}
                >
                  {labels.outcome(o)}
                </button>
              ))}
            </div>
          )}
          {resolveNote ? (
            <p className="cc-muted" role="status">
              {resolveNote}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
