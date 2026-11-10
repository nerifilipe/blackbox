import { chromium } from '../../web/node_modules/playwright/index.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const [origin, output] = process.argv.slice(2);
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const browser = await chromium.launch({ channel: process.env.BLACKBOX_BROWSER_CHANNEL || 'chrome', headless: true });
const results = [];
try {
 for (const viewport of [{ name: 'desktop', width: 1440, height: 1100 }, { name: 'mobile', width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByText('The demo is disabled for custom targets. Send your own requests to the proxy.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Run experiment', exact: true }).isDisabled(), true);
  await page.getByRole('navigation').getByRole('button', { name: /Request stream/ }).click();
  await page.getByRole('textbox', { name: 'Filter requests' }).fill('/lost');
  await page.getByRole('button', { name: 'Inspect POST /lost, connection dropped', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await dialog.getByText('No HTTP response', { exact: true }).isVisible(), true);
  assert.equal(await dialog.locator('dt').filter({ hasText: 'Upstream status' }).locator('..').locator('dd').textContent(), '201');
  await page.screenshot({ path: join(output, `${viewport.name}-inspection.png`), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  results.push({ viewport: viewport.name, passed: true, checks: ['external target explanation', 'demo disabled', 'real lost-response event inspectable', 'no horizontal page overflow', 'no JavaScript errors'] });
  await page.close();
 }
} finally {
 await browser.close();
 await writeFile(join(output, 'browser-checks.json'), JSON.stringify(results, null, 2));
}
