import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const reportURL = pathToFileURL(resolve('../docs/evidence/fitness/report.html')).href;

test('offline fitness evidence expands and downloads without external resources', async ({ page }, info) => {
 const external: string[] = [];
 page.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
 await page.goto(reportURL);
 await expect(page.getByRole('heading', { name: 'Failure happened. The data tells the story.' })).toBeVisible();
 await expect(page.locator('article')).toHaveCount(3);
 await expect(page.locator('article .badge.ok')).toHaveCount(3);
 await page.locator('summary').first().click();
 await expect(page.getByRole('cell', { name: 'Commit exists before retry', exact: true })).toBeVisible();
 const downloadEvent = page.waitForEvent('download');
 await page.getByRole('link', { name: 'Download JSON' }).click();
 expect((await downloadEvent).suggestedFilename()).toBe('report.json');
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
 expect(external).toEqual([]);
 await page.locator('summary').first().click();
 if (process.env.BLACKBOX_SCREENSHOTS) {
  mkdirSync(process.env.BLACKBOX_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.BLACKBOX_SCREENSHOTS, `fitness-${info.project.name}.png`), fullPage: true });
 }
});

test('evidence walkthrough advances, pauses and closes', async ({ page }, info) => {
 if (info.project.name === 'desktop') await page.setViewportSize({ width: 1280, height: 720 });
 await page.clock.install();
 await page.goto(reportURL);
 await page.getByRole('button', { name: 'Play 75-second walkthrough' }).click();
 const dialog = page.getByRole('dialog');
 await expect(dialog).toBeVisible();
 await expect(dialog.locator('.slide.active')).toContainText('What if the server saved');
 await page.clock.fastForward(15100);
 await expect(dialog.locator('.slide.active')).toContainText('The server saved. The client never knew.');
 expect(await dialog.evaluate(element => element.scrollHeight <= element.clientHeight)).toBeTruthy();
 await page.getByRole('button', { name: 'Pause', exact: true }).click();
 await page.clock.fastForward(16000);
 await expect(dialog.locator('.slide.active')).toContainText('The server saved. The client never knew.');
 await page.getByRole('button', { name: 'Next', exact: true }).click();
 await expect(dialog.locator('.slide.active')).toContainText('Two failures. One successful change.');
 await page.getByRole('button', { name: 'Resume', exact: true }).click();
 await page.clock.fastForward(45100);
 await expect(dialog.locator('.slide.active')).toContainText('3 of 3 scenarios passed.');
 await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
 expect(await dialog.evaluate(element => element.scrollWidth <= innerWidth)).toBeTruthy();
 await page.getByRole('button', { name: 'Close', exact: true }).click();
 await expect(dialog).not.toBeVisible();
});
