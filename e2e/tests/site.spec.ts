import { expect, test, type Page } from '@playwright/test';

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
} as const;

const PAGES = ['/', '/services/', '/about/', '/contact/'];

async function noHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

test.describe('published Breakthrough Medical site', () => {
  test('all pages render with no horizontal overflow at every viewport', async ({ page }) => {
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(viewport);
      for (const path of PAGES) {
        const res = await page.goto(path);
        expect(res?.status(), `${path} at ${name}`).toBe(200);
        expect(await noHorizontalOverflow(page), `overflow on ${path} at ${name}`).toBe(true);
      }
    }
  });

  test('home hero: side-by-side on desktop, stacked on mobile', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/');
    const copy = page.locator('.wb-hero-copy');
    const media = page.locator('.wb-hero-media');
    const copyBoxD = (await copy.boundingBox())!;
    const mediaBoxD = (await media.boundingBox())!;
    expect(mediaBoxD.x).toBeGreaterThan(copyBoxD.x + copyBoxD.width - 5); // beside

    await page.setViewportSize(VIEWPORTS.mobile);
    const copyBoxM = (await copy.boundingBox())!;
    const mediaBoxM = (await media.boundingBox())!;
    expect(mediaBoxM.y).toBeGreaterThan(copyBoxM.y + copyBoxM.height - 5); // below
  });

  test('feature grid collapses 3 → 2 → 1 columns', async ({ page }) => {
    const columnCount = async () =>
      page
        .locator('.wb-fg-grid')
        .first()
        .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);

    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/');
    expect(await columnCount()).toBe(3);
    await page.setViewportSize(VIEWPORTS.tablet);
    expect(await columnCount()).toBe(2);
    await page.setViewportSize(VIEWPORTS.mobile);
    expect(await columnCount()).toBe(1);
  });

  test('mobile nav toggle opens the menu', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/');
    const nav = page.locator('.wb-nav');
    await expect(nav).toBeHidden();
    await page.locator('.wb-nav-burger').click();
    await expect(nav).toBeVisible();
    await expect(nav.getByText('Services')).toBeVisible();
  });

  test('FAQ accordion toggles without JavaScript', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/services/');
    const first = page.locator('.wb-faq-item').first();
    const answer = first.locator('.wb-faq-a');
    await expect(answer).toBeHidden();
    await first.locator('summary').click();
    await expect(answer).toBeVisible();
  });

  test('contact form has the configured fields', async ({ page }) => {
    await page.goto('/contact/');
    for (const field of ['name', 'email', 'phone', 'interest', 'message']) {
      await expect(page.locator(`[name="${field}"]`)).toBeAttached();
    }
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  });

  test('rebrand: republished css carries the new primary color', async ({ page }) => {
    const res = await page.goto('/styles.css');
    const css = await res!.text();
    expect(css).toContain('--color-primary:#7c3aed'); // set via `wb theme set` in fixture
    expect(css).not.toContain('--color-primary:#0e7c66');
  });

  test('published pages ship zero JavaScript', async ({ page }) => {
    for (const path of PAGES) {
      await page.goto(path);
      const scripts = await page.locator('script').count();
      expect(scripts, path).toBe(0);
    }
  });

  test('SEO basics present', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveCount(1);
    expect(await page.locator('meta[name="description"]').getAttribute('content')).toBeTruthy();
    expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe('https://breakthrough.example/');
  });

  test('screenshots for human review', async ({ page }) => {
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      await page.screenshot({ path: `screenshots/home-${name}.png`, fullPage: name !== 'mobile' });
    }
    await page.setViewportSize(VIEWPORTS.desktop);
    for (const path of PAGES.slice(1)) {
      await page.goto(path);
      await page.screenshot({ path: `screenshots/${path.replaceAll('/', '')}-desktop.png`, fullPage: true });
    }
  });
});
