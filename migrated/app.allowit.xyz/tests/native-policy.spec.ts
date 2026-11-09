import {test, expect} from '@playwright/test';
import {fixture, selected} from './native-policy-harness';

test('same policy card: one owner setup, agent skill, separate finalized revoke', async ({page}) => {
  const b = await fixture(page);
  await expect(page.getByRole('note')).toContainText('Solana Devnet');
  await expect(page.getByText('Enable Testnet Mode in Phantom:', {exact: false})).not.toBeVisible();
  await expect(page.getByRole('button', {name: 'Approve and sign allocation', exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: 'Approve and sign once', exact: true}).click();
  await expect(page.getByLabel('Policy visual certificate')).toContainText('Ready');
  expect(b.signs).toBe(1);
  await page.getByText('Setup details and policy binding', {exact:true}).click();
  await expect(page.getByRole('region', {name: 'Funding', exact: true})).toContainText('Daily vault ceiling (UTC day)');
  await expect(page.getByRole('region', {name: 'Funding', exact: true})).toContainText(selected.sourceHash);
  await expect(page.getByRole('region', {name: 'Funding', exact: true})).toContainText('Action limit');
  // The skill is generated as soon as the vault is ready; there is no button to press.
  await expect(page.getByRole('region', {name: 'Agent access', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Copy skill', exact: true})).toBeEnabled();
  expect(b.calls.filter(c => c === 'POST /api/native/export')).toHaveLength(1);
  // Without questions to answer the section stays out of the page.
  await expect(page.getByRole('region', {name: 'Owner questions', exact: true})).toHaveCount(0);
  await page.getByText('View skill file', {exact: true}).click();
  // The vault names the owner's agent: the skill pays with the agent's own key, never a server endpoint.
  await expect(page.locator('.skill-source')).toContainText('allowit policy execute');
  await expect(page.locator('.skill-source')).not.toContainText('/api/native/spend');
  await expect(page.getByRole('region', {name: 'Funding', exact: true})).toContainText('key stays on the agent’s device');
  expect(b.signs).toBe(1);
  await page.getByRole('button', {name: 'Revoke vault', exact: true}).click();
  await expect(page.getByLabel('Policy visual certificate')).toContainText('Revoked');
  expect(b.signs).toBe(2); expect(b.unexpected).toEqual([]);
  expect(b.calls.some(c => /allocation|native\/generate|native\/execute|native\/spend/.test(c))).toBe(false);
  await expect(page).toHaveURL(/\/allowances$/);
  await page.screenshot({path: test.info().outputPath('same-policy-card.png'), fullPage: true});
});
