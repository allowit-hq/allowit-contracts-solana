import NetworkPicker from './NetworkPicker';
import './chain-picker.css';

const CHAINS = [{id: 'solana', label: 'Solana'}, {id: 'tempo', label: 'Tempo'}, {id: 'stellar', label: 'Stellar'}] as const;

/** Chain choice navigates to a separate owner and policy scope. It never copies an allowance or wallet session. */
export default function ChainPicker({chain = 'solana', disabled = false}: {chain?: 'solana' | 'tempo' | 'stellar'; disabled?: boolean}) {
  return <div className="chain-picker"><NetworkPicker label="Blockchain" controlId="blockchain" networks={CHAINS} network={chain} disabled={disabled} onChange={next => {
    // Every chain opens its policies workspace.
    window.location.assign(next === 'tempo' ? '/?native=1&chain=tempo' : next === 'stellar' ? '/?chain=stellar' : '/');
  }}/></div>;
}

/** The chain row on a sign-in card. Each chain has its own sign-in and wallets; Solana returns to the policies sign-in. */
export function ChainSelect({chain, disabled = false, describedBy}: {chain: 'solana' | 'tempo' | 'stellar'; disabled?: boolean; describedBy?: string}) {
  return <NetworkPicker label="Chain for sign-in" controlId="signin-chain" networks={CHAINS} network={chain} disabled={disabled} describedBy={describedBy} onChange={next => {
    window.location.assign(next === 'tempo' ? '/?native=1&chain=tempo' : next === 'stellar' ? '/?chain=stellar' : '/');
  }}/>;
}
