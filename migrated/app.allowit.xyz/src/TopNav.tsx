import {ShieldCheck} from 'lucide-react';
import './top-nav.css';

export type TopPage = 'policies';

const PAGES = [
  {id: 'policies', href: '/', label: 'Policies', title: 'Your policies', Icon: ShieldCheck},
] as const;

/** The same page links in every header; the current page is marked. */
export default function TopNav({current, chain = 'solana', disabled = false}: {current?: TopPage; chain?: 'solana' | 'tempo' | 'stellar'; disabled?: boolean}) {
  return (
    <nav className="top-nav" aria-label="Pages">
      {PAGES.map(({id, href, label, title, Icon}) => (
        <a key={id} className="btn btn-sm btn-quiet top-nav-link" href={chain === 'tempo' && id === 'policies' ? '/?native=1&chain=tempo' : chain === 'stellar' && id === 'policies' ? '/?chain=stellar' : href} title={title} aria-current={current === id ? 'page' : undefined} aria-disabled={disabled||undefined} tabIndex={disabled?-1:undefined} onClick={event=>{if(disabled)event.preventDefault();}}>
          <Icon size={14} aria-hidden="true" />
          <span className="top-label">{label}</span>
        </a>
      ))}
    </nav>
  );
}
