// Record the report's real-time, 75-second walkthrough. Requires web/npm ci and Playwright FFmpeg.
import { chromium } from '../web/node_modules/playwright/index.mjs';
import { mkdir, mkdtemp, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = resolve(process.argv[2] || join(root, 'docs/evidence/fitness/report.html'));
const output = resolve(process.argv[3] || join(root, 'docs/images/fitness-demo.webm'));
await mkdir(dirname(output), { recursive: true });
const tempRoot = join(root, '.blackbox');
await mkdir(tempRoot, { recursive: true });
const videos = await mkdtemp(join(tempRoot, 'recording-'));
const browser = await chromium.launch({ channel: process.env.BLACKBOX_BROWSER_CHANNEL || 'chrome', headless: true });
try {
 const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videos, size: { width: 1280, height: 720 } } });
 const page = await context.newPage();
 await page.goto(pathToFileURL(report).href);
 await page.getByRole('button', { name: 'Play 75-second walkthrough' }).click();
 await page.mouse.move(1250, 700);
 for (let index = 0; index < 5; index++) {
  await page.waitForTimeout(1000);
  if (await page.locator('dialog').evaluate(element => element.scrollHeight > element.clientHeight)) {
   throw new Error(`Slide ${index + 1} overflows the recording viewport`);
  }
  await page.screenshot({ path: join(videos, `slide-${index + 1}.png`) });
  console.log(`Recording slide ${index + 1}/5`);
  await page.waitForTimeout(14000);
 }
 await page.getByRole('dialog').getByRole('button', { name: 'Resume', exact: true }).waitFor({ timeout: 5000 });
 const video = page.video();
 await context.close();
 await rename(await video.path(), output);
 console.log(`Saved ${output}`);
 console.log(`Slide previews: ${videos}`);
} finally {
 await browser.close();
}
