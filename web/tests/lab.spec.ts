import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const scenario = {
 version: 1, name: 'The lost response', description: 'The server saves the workout. The response never arrives. Is a retry safe?',
 rules: [{ id: 'lost-response', name: 'Drop the first response', method: 'POST', path: '/workouts', kind: 'drop_response', limit: 1, delayMs: 0, status: 0, enabled: true }],
};

test.beforeEach(async ({ request }) => {
 const response = await request.put('/api/scenario', { data: scenario });
 expect(response.ok()).toBeTruthy();
});

test('real lost response: unsafe retries duplicate, idempotent retries recover', async ({ page }, info) => {
 const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
 await page.goto('/');
 await expect(page.getByRole('heading', { name: 'Make failure repeatable.' })).toBeVisible();
 await page.getByRole('button', { name: 'Run experiment', exact: true }).click();
 await expect(page.getByText('One action. Duplicate writes.')).toBeVisible();
 await expect(page.getByText('actual: 2', { exact: true })).toBeVisible();
 await page.getByRole('button', { name: 'Idempotent', exact: true }).click();
 await page.getByRole('button', { name: 'Run experiment', exact: true }).click();
 await expect(page.getByText('One action. One workout.')).toBeVisible();
 await expect(page.getByText('actual: 1', { exact: true })).toBeVisible();
 await expect(page.getByRole('button', { name: 'Inspect POST /workouts, connection dropped' }).first()).toBeVisible();
 if (process.env.BLACKBOX_SCREENSHOTS) {
  mkdirSync(process.env.BLACKBOX_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.BLACKBOX_SCREENSHOTS, `${info.project.name}.png`), fullPage: true });
 }
 await page.getByRole('button', { name: 'Inspect POST /workouts, connection dropped' }).first().click();
 await expect(page.getByRole('dialog')).toContainText('No HTTP response');
 await expect(page.getByRole('dialog')).toContainText('201');
 await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog')).not.toBeVisible();
 expect(errors).toEqual([]);
});

test('503 scenario retries exactly twice before succeeding', async ({ page }) => {
 await page.goto('/');
 await page.getByRole('button', { name: /Third time lucky/ }).click();
 await expect(page.locator('.active-name')).toHaveText('Third time lucky');
 await page.getByRole('button', { name: 'Run experiment', exact: true }).click();
 await expect(page.locator('.result-context')).toContainText('Third time lucky');
 await expect(page.locator('.attempt')).toHaveCount(3);
 await expect(page.getByText('actual: 1', { exact: true })).toBeVisible();
 await expect(page.locator('.attempt').last()).toContainText('201');
});

test('import, validate, export and re-arm a custom scenario', async ({ page }) => {
 await page.goto('/');
 await page.getByRole('button', { name: 'Edit scenario', exact: true }).click();
 await page.getByRole('textbox', { name: 'Scenario JSON' }).fill('{ invalid');
 await page.getByRole('button', { name: 'Save scenario' }).click();
 await expect(page.getByRole('dialog')).toContainText('Check the JSON syntax');
 await page.getByRole('button', { name: 'Cancel', exact: true }).click();
 const custom = { ...scenario, name: 'Imported case', rules: [{ ...scenario.rules[0], kind: 'latency', delayMs: 250 }] };
 await page.getByLabel('Import scenario JSON').setInputFiles({ name: 'case.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(custom)) });
 await expect(page.locator('.active-name')).toHaveText('Imported case');
 await page.getByRole('button', { name: 'Run experiment', exact: true }).click();
 await expect(page.locator('.result-context')).toContainText('Imported case');
 await expect(page.getByText('1 / 1 used')).toBeVisible();
 await page.getByRole('button', { name: 'Re-arm faults' }).click();
 await expect(page.getByText('0 / 1 used')).toBeVisible();
 const downloadPromise = page.waitForEvent('download');
 await page.getByRole('link', { name: 'Export JSON' }).click();
 const download = await downloadPromise;
 expect(download.suggestedFilename()).toBe('blackbox-scenario.json');
 const exported = await page.request.get('/api/scenario');
 expect((await exported.json()).name).toBe('Imported case');
});

test('navigation, filters and narrow viewport avoid page overflow', async ({ page }) => {
 await page.goto('/');
 await page.getByRole('button', { name: /Request stream/ }).click();
 await expect(page.getByRole('heading', { name: 'Every request. In focus.' })).toBeVisible();
 await page.getByRole('textbox', { name: 'Filter requests' }).fill('no-such-path');
 await expect(page.getByText(/No matching requests|Your next request starts the story/)).toBeVisible();
 await page.getByRole('button', { name: /Field guide/ }).click();
 await expect(page.getByRole('heading', { name: 'Learn from the breakage.' })).toBeVisible();
 await page.getByRole('button', { name: 'Open failure lab' }).click();
 await expect(page.getByRole('heading', { name: 'Make failure repeatable.' })).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
});

test('history compares real runs, restores the saved rules and survives reload', async ({ page, request }, info) => {
 const fragileResponse = await request.post('/api/demo/run', { data: { mode: 'fragile' } });
 expect(fragileResponse.ok()).toBeTruthy();
 const fragile = await fragileResponse.json();
 const resilientResponse = await request.post('/api/demo/run', { data: { mode: 'resilient' } });
 expect(resilientResponse.ok()).toBeTruthy();
 const resilient = await resilientResponse.json();
 await page.goto('/');
 await page.getByRole('button', { name: 'Experiments', exact: true }).click();
 await expect(page.getByRole('heading', { name: 'Before. After. Understood.' })).toBeVisible();
 await page.getByRole('combobox', { name: 'Baseline experiment', exact: true }).selectOption(fragile.id);
 await page.getByRole('combobox', { name: 'Comparison experiment', exact: true }).selectOption(resilient.id);
 await expect(page.getByText('The invariant recovered.', { exact: true })).toBeVisible();
 await expect(page.getByRole('article', { name: 'Baseline experiment' })).toContainText('Unprotected client');
 await expect(page.getByRole('article', { name: 'Comparison experiment' })).toContainText('Idempotent client');
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
 if (process.env.BLACKBOX_SCREENSHOTS) await page.screenshot({ path: join(process.env.BLACKBOX_SCREENSHOTS, `history-${info.project.name}.png`), fullPage: true });
 const downloadPromise = page.waitForEvent('download');
 await page.getByRole('article', { name: 'Comparison experiment' }).getByRole('link', { name: 'Export result' }).click();
 expect((await downloadPromise).suggestedFilename()).toBe('blackbox-experiment.json');
 const snapshot = await request.get(`/api/runs/${resilient.id}/scenario`);
 expect((await snapshot.json()).rules[0].kind).toBe('drop_response');
 await page.getByRole('button', { name: 'Swap baseline and comparison' }).click();
 await expect(page.getByText('The invariant regressed.', { exact: true })).toBeVisible();
 await page.reload();
 await page.getByRole('button', { name: 'Experiments', exact: true }).click();
 await expect(page.getByText('The invariant recovered.', { exact: true })).toBeVisible();
 const edited = { ...scenario, rules: [{ ...scenario.rules[0], kind: 'latency', delayMs: 50 }] };
 expect((await request.put('/api/scenario', { data: edited })).ok()).toBeTruthy();
 await page.getByRole('article', { name: 'Comparison experiment' }).getByRole('button', { name: 'Restore setup' }).click();
 await expect(page.getByRole('heading', { name: 'Make failure repeatable.' })).toBeVisible();
 await expect(page.getByRole('button', { name: 'Idempotent', exact: true })).toHaveAttribute('aria-pressed', 'true');
 const active = await request.get('/api/scenario');
 expect((await active.json()).rules[0].kind).toBe('drop_response');
});

test('comparison flags different rules with the same name and handles legacy runs', async ({ page, request }) => {
 const before = await (await request.post('/api/demo/run', { data: { mode: 'fragile' } })).json();
 const edited = { ...scenario, rules: [{ ...scenario.rules[0], kind: 'latency', delayMs: 50 }] };
 expect((await request.put('/api/scenario', { data: edited })).ok()).toBeTruthy();
 const after = await (await request.post('/api/demo/run', { data: { mode: 'resilient' } })).json();
 await page.goto('/');
 await page.getByRole('button', { name: 'Experiments', exact: true }).click();
 await page.getByRole('combobox', { name: 'Baseline experiment', exact: true }).selectOption(before.id);
 await page.getByRole('combobox', { name: 'Comparison experiment', exact: true }).selectOption(after.id);
 await expect(page.getByText('Different fault configurations.', { exact: true })).toBeVisible();
 await expect(page.getByText('The invariant recovered.', { exact: true })).not.toBeVisible();
 // Legacy records have no configuration snapshot; never fabricate one from current settings.
 const { scenarioSnapshot: _snapshot, fixture: _fixture, ...legacy } = before;
 await page.route('**/api/runs', route => route.fulfill({ json: { runs: [after, legacy] } }));
 await page.getByRole('button', { name: 'Refresh history' }).click();
 await expect(page.getByText('Configuration unavailable.', { exact: true })).toBeVisible();
 await expect(page.getByRole('article', { name: 'Baseline experiment' }).getByRole('button', { name: 'Restore setup' })).toBeDisabled();
 await page.getByRole('textbox', { name: 'Search experiments' }).fill('does-not-exist');
 await expect(page.getByText('No matching experiments', { exact: true })).toBeVisible();
});

test('history distinguishes an unavailable database from an empty history', async ({ page }) => {
 let unavailable = true;
 await page.route('**/api/runs', route => unavailable
  ? route.fulfill({ status: 500, json: { error: 'could not load experiment history' } })
  : route.fulfill({ json: { runs: [] } }));
 await page.goto('/');
 await page.getByRole('button', { name: 'Experiments', exact: true }).click();
 await expect(page.getByRole('heading', { name: 'History is unavailable.' })).toBeVisible();
 await expect(page.getByText('Your experiments belong here.', { exact: true })).not.toBeVisible();
 unavailable = false;
 await page.getByRole('button', { name: 'Refresh history' }).click();
 await expect(page.getByRole('heading', { name: 'Your experiments belong here.' })).toBeVisible();
 await expect(page.getByRole('alert')).not.toBeVisible();
});
