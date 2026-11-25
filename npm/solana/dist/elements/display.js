import { address, signature } from '../message.js';
import { assets, cluster } from '../networks.js';
import { base, h, shortAddress } from './base.js';
/**
 * The Solana Explorer link of an address, a program or a transaction signature on `network`. Null for an unknown
 * network or an id that is not base58 of the kind's length.
 */
export function explorerUrl(network, kind, id) {
    const name = cluster(network);
    if (!name || typeof id !== 'string')
        return null;
    const valid = kind === 'tx' ? signature(id) : kind === 'address' || kind === 'contract' ? address(id) : null;
    return valid ? `https://explorer.solana.com/${kind === 'tx' ? 'tx' : 'address'}/${id}?cluster=${name}` : null;
}
export function link(network, kind, id, text) {
    const url = explorerUrl(network, kind, id);
    if (!url)
        return h('span', { title: id }, text);
    return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: id }, text);
}
export function addressElement() {
    return class extends base() {
        render() {
            const { network, address: at, label } = (this.data ?? {});
            if (typeof network !== 'string' || typeof at !== 'string' || !cluster(network) || !address(at)) {
                this.replaceChildren(h('span', { class: 'invalid' }, typeof at === 'string' ? at : ''));
                return;
            }
            this.replaceChildren(link(network, 'address', at, label || shortAddress(at)));
        }
    };
}
export function explorerLinkElement() {
    return class extends base() {
        render() {
            const { network, kind, id, text } = (this.data ?? {});
            if (typeof network !== 'string' || typeof id !== 'string' || !['address', 'tx', 'contract'].includes(String(kind))) {
                this.replaceChildren();
                return;
            }
            this.replaceChildren(link(network, kind, id, text || shortAddress(id)));
        }
    };
}
/** Integer units in the asset's decimals, without floating point. */
export function formatUnits(units, decimals) {
    if (!/^-?\d+$/.test(units))
        return units;
    const negative = units.startsWith('-'), digits = (negative ? units.slice(1) : units).padStart(decimals + 1, '0');
    const whole = digits.slice(0, digits.length - decimals), fraction = decimals ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
    return `${negative ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
}
/** An amount of a listed asset with its unit. An asset that the rail does not list stays in base units, with its id. */
export function amountElement() {
    return class extends base() {
        render() {
            const { network, asset, units } = (this.data ?? {});
            const info = typeof network === 'string' ? assets(network).find(a => a.id === asset || a.symbol === asset) : undefined;
            const text = typeof units !== 'string' ? '' : info ? formatUnits(units, info.decimals) : units;
            this.replaceChildren(h('span', {}, `${text} ${info?.symbol ?? asset ?? ''}`.trim()));
        }
    };
}
export function receiptElement() {
    return class extends base() {
        render() {
            const { network, receipt } = (this.data ?? {});
            if (typeof network !== 'string' || !receipt) {
                this.replaceChildren();
                return;
            }
            const rows = [h('dt', {}, 'Status'), h('dd', {}, String(receipt.status ?? 'unknown'))];
            if (typeof receipt.hash === 'string')
                rows.push(h('dt', {}, 'Transaction'), h('dd', {}, link(network, 'tx', receipt.hash, shortAddress(receipt.hash))));
            // The network fee is in lamports: SOL has nine decimals.
            if (receipt.fee?.native !== undefined)
                rows.push(h('dt', {}, 'Network fee'), h('dd', {}, `${formatUnits(String(receipt.fee.native), 9)} SOL`));
            if (receipt.fee?.charged !== undefined)
                rows.push(h('dt', {}, 'Fee charged to the budget'), h('dd', {}, String(receipt.fee.charged)));
            for (const debit of receipt.debits ?? []) {
                const info = assets(network).find(a => a.id === debit.asset || a.symbol === debit.asset);
                const text = info ? formatUnits(String(debit.units ?? ''), info.decimals) : String(debit.units ?? '');
                rows.push(h('dt', {}, 'Debit'), h('dd', {}, `${text} ${info?.symbol ?? debit.asset ?? ''}`.trim()));
            }
            this.replaceChildren(h('dl', { class: 'receipt' }, ...rows));
        }
    };
}
