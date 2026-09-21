// Capture only the pages selected for this visual change; checks still cover all routes.
const selected = new Set(
  (process.env.HDD_V2_SCREENSHOT_PAGES ?? '')
    .split(',')
    .map((page) => page.trim())
    .filter(Boolean),
);
export async function screenshot(page, options) {
  if (!page) return;
  const route = new URL(page.url()).pathname.split('/')[1] || 'home';
  if (selected.has(route) || selected.has('*')) await page.screenshot(options);
}
