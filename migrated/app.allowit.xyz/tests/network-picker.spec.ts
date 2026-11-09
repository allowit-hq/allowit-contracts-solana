import {test, expect} from '@playwright/test';
import {installWallet} from './test-wallet';

test('public Solana policies offer Devnet and Mainnet with persistent cross-tab preferences', async ({page, context}) => {
  test.skip((process.env.VITE_ALLOWIT_LOCAL_SANDBOX ?? '1') !== '0', 'Public network selection runs with the sandbox disabled.');
  await installWallet(page);
  await page.goto('/allowances');
  const trigger = page.getByRole('button', {name:/^Network for new policies/});
  for (const saved of ['solana:mainnet', 'solana:testnet', 'solana:localnet', 'local:dev']) {
    await page.evaluate(network => localStorage.setItem('allowit.network', network), saved);
    await page.reload();
    await expect(trigger).toContainText(saved==='solana:mainnet'?'Mainnet':'Devnet');
  }
  await expect(page.getByRole('button', {name: 'Try Local dev without a wallet'})).toHaveCount(0);
  await trigger.click();
  const choices=page.getByRole('listbox',{name:'Network for new policies',exact:true});
  await expect(choices.getByRole('option')).toHaveText(['Mainnet','Devnet']);
  await choices.getByRole('option',{name:'Mainnet',exact:true}).click();
  await expect(trigger).toContainText('Mainnet');

  const other = await context.newPage();
  await other.goto('/allowances');
  await other.evaluate(() => localStorage.setItem('allowit.network', 'solana:devnet'));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('allowit.network'))).toBe('solana:devnet');
  await expect(trigger).toContainText('Devnet');
  await other.close();
  await page.reload();
  await expect(trigger).toContainText('Devnet');
});
