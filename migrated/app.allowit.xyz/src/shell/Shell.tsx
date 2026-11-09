import {useCallback, useEffect, useLayoutEffect, useRef, type FormEvent, type KeyboardEvent, type ReactNode, type Ref} from 'react';
import {ArrowUp, CircleAlert, LoaderCircle, Moon, Plus, Sun, SunMoon} from 'lucide-react';
import ChainPicker from '../wallet/ChainPicker';
import type {Theme} from '../contracts';
import './policy-flow.css';

/**
 * The chain-independent Allowit workspace: header, sign-in page, policy list, new-policy composer and section
 * primitives. Every chain renders its pages from these so the interface stays identical; only chain facts and
 * owner actions differ.
 */

export type Chain = 'solana' | 'tempo' | 'stellar';

export function Spinner() {
  return <LoaderCircle className="spin" size={16} aria-hidden="true" />;
}

export function ErrorLine({id, text}: {id: string; text: string | null}) {
  if (!text) return null;
  return (
    <span className="field-error" id={id}>
      <CircleAlert size={14} aria-hidden="true" />
      {text}
    </span>
  );
}

export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 64 64" width="26" height="26" aria-hidden="true" focusable="false">
      <path d="M10 23H25C33 23 31 14 39 14H54M10 42H25C33 42 31 33 39 33H54" stroke="currentColor" strokeWidth="5" fill="none" />
      <path d="M10 32H26C34 32 33 23 41 23H54" stroke="#F34632" strokeWidth="3" fill="none" />
    </svg>
  );
}

export type Banner = {key: string; text: string; dismiss: () => void; action?: {label: string; run: () => void; disabled?: boolean}};

export function ErrorBanners({errors}: {errors: Banner[]}) {
  return (
    <>
      {errors.map(e => (
        <div className="banner banner-error" role="alert" key={e.key}>
          <CircleAlert size={18} aria-hidden="true" />
          <div className="banner-text">{e.text}</div>
          <div className="banner-actions">
            {e.action ? (
              <button type="button" className="btn btn-sm btn-primary" disabled={e.action.disabled} onClick={e.action.run}>
                {e.action.label}
              </button>
            ) : null}
            <button type="button" className="btn btn-sm" onClick={e.dismiss}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

export function Section({id, title, children}: {id: string; title: string; children: ReactNode}) {
  return (
    <section className="section" aria-labelledby={id}>
      <h2 id={id} className="section-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

const THEMES: {id: Theme; label: string; Icon: typeof Sun}[] = [
  {id: 'auto', label: 'Auto theme', Icon: SunMoon},
  {id: 'light', label: 'Light theme', Icon: Sun},
  {id: 'dark', label: 'Dark theme', Icon: Moon},
];

export function ThemeSwitch({theme, setTheme}: {theme: Theme; setTheme: (t: Theme) => void}) {
  const index = THEMES.findIndex(t => t.id === theme), current = THEMES[index], next = THEMES[(index + 1) % THEMES.length];
  return <div className="theme"><button type="button" aria-label={`Theme: ${theme}. Switch to ${next.id}`} title={`Theme: ${theme}`} onClick={() => setTheme(next.id)}><current.Icon size={16} aria-hidden="true" /></button></div>;
}

export function submitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>) {
  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }
}

/** The signed-out header: brand, chain and theme. */
export function AuthHeader({chain, busy, pickerDisabled, theme}: {chain: Chain; busy: boolean; pickerDisabled: boolean; theme: ReactNode}) {
  return (
    <header className="auth-top">
      <div className="auth-top-inner">
        <a className="wordmark" href="/" aria-label="Allowit home">
          <Mark />
          Allowit
        </a>
        <ChainPicker chain={chain} disabled={pickerDisabled} />
        {theme}
      </div>
      {busy ? <div className="busy-rule" aria-hidden="true" /> : null}
    </header>
  );
}

/** The signed-in header: brand, chain, the chain's network control, then page links, theme and session. */
export function TopHeader({chain, busy, pickerDisabled, network, aside}: {chain: Chain; busy: boolean; pickerDisabled: boolean; network: ReactNode; aside: ReactNode}) {
  return (
    <header className="top">
      <div className="top-inner">
        <a className="wordmark" href={chain === 'tempo' ? '/?native=1&chain=tempo' : '/'} aria-label="Allowit home">
          <Mark />
          Allowit
        </a>
        <ChainPicker chain={chain} disabled={pickerDisabled} />
        {network}
        <div className="top-aside">{aside}</div>
      </div>
      {busy ? <div className="busy-rule" aria-hidden="true" /> : null}
    </header>
  );
}

export function SkipLink({target}: {target: {current: HTMLElement | null}}) {
  return (
    <a
      className="skip"
      href="#main"
      onClick={e => {
        e.preventDefault();
        target.current?.focus();
      }}
    >
      Skip to content
    </a>
  );
}

/** The policy list beside the workspace. Each chain supplies its own list items. */
export function PolicyNavFrame({onNew, newDisabled, empty, before, children}: {onNew: () => void; newDisabled: boolean; empty: boolean; before?: ReactNode; children: ReactNode}) {
  return (
    <nav className="policy-nav" aria-label="Policies">
      <div className="policy-nav-heading"><span>Policies</span><button className="icon-action" type="button" aria-label="New policy" title="New policy" disabled={newDisabled} onClick={onNew}><Plus size={18} /></button></div>
      {before}
      {empty ? <p className="small muted">Your policies will appear here.</p> : children}
    </nav>
  );
}

/**
 * The New policy page. The owner's own words are the policy; `fields` holds any chain-specific setting shown below
 * them, and `cue` says where the draft is saved.
 */
export function ComposerFrame({examples, extraExamples, text, setText, onSubmit, blocked, sendDisabled, generating, error, clearError, cue, fields}: {
  examples: readonly {title: string; prompt: string}[];
  /** Example links that open another editor instead of filling the composer. */
  extraExamples?: ReactNode;
  text: string;
  setText: (text: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  blocked: boolean;
  sendDisabled: boolean;
  generating: boolean;
  error: string | null;
  clearError: () => void;
  cue: ReactNode;
  fields?: ReactNode;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resizeInput = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${input.scrollHeight}px`;
  }, []);
  useLayoutEffect(resizeInput, [text, resizeInput]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth !== width) {
        width = input.clientWidth;
        resizeInput();
      }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [resizeInput]);
  return (
    <section className="section composer" aria-labelledby="new-title">
      <h1 id="new-title" className="title">
        New policy
      </h1>
      <form className="form" onSubmit={onSubmit} noValidate>
        <fieldset className="field" aria-label="Examples">
          <div className="examples">
            {examples.map(ex => (
              <button
                type="button"
                key={ex.title}
                className="example"
                aria-pressed={text === ex.prompt}
                disabled={blocked}
                onClick={() => {
                  setText(ex.prompt);
                  clearError();
                  document.getElementById('compose')?.focus();
                }}
              >
                {ex.title}
              </button>
            ))}
            {extraExamples}
          </div>
        </fieldset>
        <div className="compose-input">
          <label className="compose-label" htmlFor="compose">What may the agent do, in your own words</label>
          <div className="compose-surface">
            <textarea
              id="compose"
              ref={inputRef as Ref<HTMLTextAreaElement>}
              rows={1}
              value={text}
              disabled={blocked}
              onChange={e => {
                setText(e.target.value);
                if (error) clearError();
              }}
              onKeyDown={submitOnEnter}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'compose-err' : undefined}
            />
            <button
              type="submit"
              className="compose-send"
              disabled={blocked || !text.trim() || sendDisabled}
              aria-label={generating ? 'Generating…' : 'Generate policy'}
              title={generating ? 'Generating…' : 'Generate policy'}
            >
              {generating ? <Spinner /> : <ArrowUp size={20} aria-hidden="true" />}
            </button>
          </div>
          <ErrorLine id="compose-err" text={error} />
          {cue}
          {fields}
        </div>
      </form>
    </section>
  );
}
