import {useEffect, useRef, useState} from 'react';

/** The prompt reuses the current private skill; copying never issues access or initiates a payment. */
export default function NativeHarnessPrompt({skill, disabled, isCurrent}: {skill: string; disabled: boolean; isCurrent: () => boolean}) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const live = useRef(true);
  useEffect(() => {live.current = true; return () => {live.current = false;};}, []);
  useEffect(() => {if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer);}, [copied]);
  const copy = async () => {
    if (disabled || !live.current || !isCurrent()) return;
    try {
      await navigator.clipboard.writeText('Load the following Allowit skill for this conversation. Keep its capability private and use it only at the endpoint specified in the skill. Confirm that you are ready, then wait for my payment request. Do not make a payment while loading the skill.\n\n' + skill);
      if (live.current && isCurrent()) {setCopied(true); setError('');}
    } catch {if (live.current && isCurrent()) setError('Copy failed. Copy the skill or download SKILL.md instead.');}
  };
  return <div className="skill-file"><div className="btn-row"><button type="button" className="btn" disabled={disabled} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy harness prompt'}</button></div><p className="small" role="status">{error || (copied ? 'Harness prompt copied to the clipboard.' : '')}</p></div>;
}
