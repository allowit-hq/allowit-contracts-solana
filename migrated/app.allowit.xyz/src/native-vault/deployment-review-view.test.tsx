import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import type {MicroController} from '../micro/micro-contracts';
import fixture from '../../tests/fixtures/cli-deployment-sdk.json';
import DeploymentReview from './DeploymentReview';

const base64url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fragment = '#allowit-deploy=' + base64url(JSON.stringify(fixture));
const c = {auth: {session: {address: fixture.owner, network: 'solana', expiresAt: '2099-01-01T00:00:00Z'}}, network: 'solana:devnet'} as unknown as MicroController;
// Effects never run on the server, so this is the review before any backend check has passed.
const html = renderToStaticMarkup(<DeploymentReview c={c} fragment={fragment} close={() => {}}/>);

describe('DeploymentReview before verification', () => {
  it('cannot sign while the deployment is unverified', () => {
    expect(html.match(/<button[^>]*>Approve and sign once<\/button>/)?.[0]).toContain('disabled=""');
    expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html).not.toContain('Retry saved transaction');
  });
});
