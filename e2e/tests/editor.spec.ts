import { expect, test, type Page } from '@playwright/test';

const BASE = 'http://127.0.0.1:4600';

async function openEditor(page: Page): Promise<void> {
  await page.goto(`${BASE}/editor/`);
  await page.getByRole('button', { name: /Breakthrough Medical/ }).click();
  await expect(page.getByTestId('canvas-frame')).toBeVisible();
  // wait for the preview iframe to render the hero
  await expect(page.frameLocator('[data-testid="canvas-frame"]').locator('.c-hero')).toBeVisible();
}

test.describe('visual editor', () => {
  test('lists sites and opens the editor with canvas, outline, palette', async ({ page }) => {
    await openEditor(page);
    await expect(page.locator('.outline-row').first()).toContainText('page-root');
    await expect(page.getByTestId('palette-hero')).toBeVisible();
    await expect(page.locator('.pages li')).toHaveCount(4);
  });

  test('click-to-select in canvas populates the inspector', async ({ page }) => {
    await openEditor(page);
    const frame = page.frameLocator('[data-testid="canvas-frame"]');
    await frame.locator('.c-hero').click();
    await expect(page.getByTestId('inspector')).toContainText('hero');
    // props form generated from the schema
    await expect(page.getByTestId('prop-headline')).toHaveValue(/Weight loss/);
  });

  test('editing a prop saves and re-renders the canvas', async ({ page }) => {
    await openEditor(page);
    const frame = page.frameLocator('[data-testid="canvas-frame"]');
    await frame.locator('.c-hero').click();
    const headline = page.getByTestId('prop-headline');
    await headline.fill('A new headline from the editor');
    await headline.blur();
    await expect(page.locator('.toolbar .status')).toHaveText(/saved/);
    await expect(
      page.frameLocator('[data-testid="canvas-frame"]').locator('.wb-hero-copy h1'),
    ).toHaveText('A new headline from the editor');
  });

  test('double-click palette inserts into selected container; undo reverts', async ({ page }) => {
    await openEditor(page);
    const frame = () => page.frameLocator('[data-testid="canvas-frame"]');
    const outlineRows = () => page.locator('.outline-row');
    const before = await outlineRows().count();

    // select the page root via outline, then insert a section
    await outlineRows().first().click();
    await page.getByTestId('palette-section').dblclick();
    await expect(page.locator('.toolbar .status')).toHaveText(/saved/);
    await expect(outlineRows()).toHaveCount(before + 1);
    await expect(frame().locator('main > .c-section').last()).toBeVisible();

    await page.getByRole('button', { name: /undo/ }).click();
    await expect(outlineRows()).toHaveCount(before);
  });

  test('blocks panel inserts a pre-built section into the page', async ({ page }) => {
    await openEditor(page);
    const frame = page.frameLocator('[data-testid="canvas-frame"]');
    const before = await frame.locator('.c-faq').count();
    await page.getByTestId('block-faq').click();
    await expect(page.locator('.toolbar .status')).toHaveText(/saved/);
    await expect.poll(() => frame.locator('.c-faq').count()).toBe(before + 1);
    // undo to keep the shared fixture stable
    await page.getByRole('button', { name: /undo/ }).click();
    await expect.poll(() => frame.locator('.c-faq').count()).toBe(before);
  });

  test('layout tab edits auto-layout tokens', async ({ page }) => {
    await openEditor(page);
    // select the testimonials section (grid) via outline
    await page.locator('.outline-row', { hasText: 'section' }).nth(0).click();
    await page.getByRole('button', { name: 'layout', exact: true }).click();
    await page.getByTestId('layout-direction').selectOption('grid');
    await expect(page.locator('.toolbar .status')).toHaveText(/saved/);
  });

  test('style tab sets background token on a section', async ({ page }) => {
    await openEditor(page);
    await page.locator('.outline-row', { hasText: 'section' }).nth(0).click();
    await page.getByRole('button', { name: 'style', exact: true }).click();
    await page.getByTestId('style-background').selectOption('secondary');
    await expect(page.locator('.toolbar .status')).toHaveText(/saved/);
    // undo to keep fixture stable
    await page.getByRole('button', { name: /undo/ }).click();
  });

  test('style tab sets a hover state that renders as pure CSS', async ({ page }) => {
    await openEditor(page);
    await page.locator('.outline-row', { hasText: 'section' }).nth(0).click();
    await page.getByRole('button', { name: 'style', exact: true }).click();
    await page.getByTestId('style-hover-background').selectOption('accent');
    await expect(page.locator('.toolbar .status')).toHaveText(/saved/);

    // The stylesheet gains a real :hover rule — no JavaScript involved.
    const sites = (await (await page.request.get(`${BASE}/sites`)).json()) as Array<{ id: string }>;
    const css = await (await page.request.get(`${BASE}/preview/${sites[0]!.id}/styles.css`)).text();
    expect(css).toContain(':hover{');
    expect(css).not.toMatch(/<script|onmouse/i);

    await page.getByRole('button', { name: /undo/ }).click();
  });

  test('style tab sets a gradient background (pure CSS)', async ({ page }) => {
    await openEditor(page);
    await page.locator('.outline-row', { hasText: 'section' }).nth(0).click();
    await page.getByRole('button', { name: 'style', exact: true }).click();
    await page.getByTestId('style-grad-from').selectOption('primary');
    await page.getByTestId('style-grad-to').selectOption('accent');
    await expect(page.locator('.toolbar .status')).toHaveText(/saved/);

    const sites = (await (await page.request.get(`${BASE}/sites`)).json()) as Array<{ id: string }>;
    const css = await (await page.request.get(`${BASE}/preview/${sites[0]!.id}/styles.css`)).text();
    expect(css).toContain('linear-gradient(');
    expect(css).not.toMatch(/<script|onmouse/i);

    await page.getByRole('button', { name: /undo/ }).click();
  });

  test('delete node removes it from canvas and outline', async ({ page }) => {
    await openEditor(page);
    const frame = page.frameLocator('[data-testid="canvas-frame"]');
    await frame.locator('.c-featureGrid .c-card').first().click();
    await expect(page.getByTestId('inspector')).toContainText('card');
    const before = await page.locator('.outline-row').count();
    await page.getByTestId('delete-node').click();
    await expect(page.locator('.outline-row')).toHaveCount(before - 1);
    await page.getByRole('button', { name: /undo/ }).click();
    await expect(page.locator('.outline-row')).toHaveCount(before);
  });

  test('drag from palette onto canvas inserts at the drop point', async ({ page }) => {
    await openEditor(page);
    const before = await page.locator('.outline-row').count();

    // HTML5 drag with a real DataTransfer: dragstart on the palette item,
    // then dragover + drop on the canvas overlay (which appears during drag).
    const item = page.getByTestId('palette-divider');
    await item.dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
    const overlay = page.getByTestId('drag-overlay');
    await expect(overlay).toBeVisible();
    const box = (await overlay.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await overlay.dispatchEvent('dragover', { dataTransfer: dt, clientX: x, clientY: y });
    // give the iframe hit-test roundtrip a beat
    await page.waitForTimeout(300);
    await overlay.dispatchEvent('dragover', { dataTransfer: dt, clientX: x, clientY: y });
    await page.waitForTimeout(200);
    await overlay.dispatchEvent('drop', { dataTransfer: dt, clientX: x, clientY: y });

    await expect(page.locator('.toolbar .status')).toHaveText(/saved/, { timeout: 10_000 });
    await expect(page.locator('.outline-row')).toHaveCount(before + 1);
    await expect(page.locator('.outline-row', { hasText: 'divider' })).toBeVisible();
    await page.getByRole('button', { name: /undo/ }).click();
  });

  test('theme dialog rebrands the site live', async ({ page }) => {
    await openEditor(page);
    await page.getByRole('button', { name: /Theme/ }).click();
    const dialog = page.getByTestId('theme-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('theme-primary').fill('#aa2266');
    await dialog.getByTestId('theme-save').click();
    await expect(dialog).not.toBeVisible();
    const css = await page.evaluate(async () => {
      const res = await fetch('/sites');
      const sites = (await res.json()) as Array<{ id: string }>;
      const cssRes = await fetch(`/preview/${sites[0]!.id}/styles.css`);
      return cssRes.text();
    });
    expect(css).toContain('--color-primary:#aa2266');
  });

  test('publish button reports success', async ({ page }) => {
    await openEditor(page);
    await page.getByRole('button', { name: /Publish/ }).click();
    await expect(page.locator('.toolbar .status')).toHaveText(/published 4 pages/, { timeout: 15_000 });
  });

  test('add then delete a page (regression: bodyless DELETE must not 400)', async ({ page }) => {
    await openEditor(page);
    await expect(page.locator('.pages li')).toHaveCount(4);

    // Add a throwaway page.
    await page.locator('button[title="Add page"]').click();
    await page.getByPlaceholder(/slug/).fill('scratch-del');
    await page.getByPlaceholder('Title').fill('Scratch');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('.pages li')).toHaveCount(5);

    // Delete it — auto-accept the confirm dialog. Before the fix this DELETE was
    // sent with `content-type: application/json` and no body, and the server 400'd,
    // so the page was never removed.
    page.on('dialog', (d) => void d.accept());
    await page.locator('.pages li', { hasText: 'scratch-del' }).locator('button[title="Delete page"]').click();

    await expect(page.locator('.pages li')).toHaveCount(4);
    await expect(page.locator('.pages li', { hasText: 'scratch-del' })).toHaveCount(0);
  });

  test('Inspector move down/up reorders siblings (regression guard for move-down)', async ({ page }) => {
    // Seed a section with three labelled headings on the home page via the API.
    const api = page.request;
    const sites = (await (await api.get(`${BASE}/sites`)).json()) as Array<{ id: string }>;
    const siteId = sites[0]!.id;
    const pages = (await (await api.get(`${BASE}/sites/${siteId}/pages`)).json()) as Array<{ id: string }>;
    const pageId = pages[0]!.id;
    const full = (await (await api.get(`${BASE}/sites/${siteId}/pages/${pageId}`)).json()) as {
      tree: { id: string };
    };
    await api.post(`${BASE}/sites/${siteId}/pages/${pageId}/tree/ops`, {
      data: {
        ops: [
          {
            op: 'insert',
            parentId: full.tree.id,
            node: {
              type: 'section',
              props: {},
              layout: { direction: 'stack', gap: 'md' },
              children: [
                { type: 'heading', props: { text: 'Alpha', level: 2 } },
                { type: 'heading', props: { text: 'Bravo', level: 2 } },
                { type: 'heading', props: { text: 'Charlie', level: 2 } },
              ],
            },
          },
        ],
      },
    });

    await openEditor(page);
    const frame = page.frameLocator('[data-testid="canvas-frame"]');
    const order = async () =>
      (await frame.locator('.c-heading').allInnerTexts()).filter((t) => ['Alpha', 'Bravo', 'Charlie'].includes(t));
    await expect.poll(order).toEqual(['Alpha', 'Bravo', 'Charlie']);

    // Move Alpha DOWN → Bravo, Alpha, Charlie  (the case PR that regressed move-down would break).
    await frame.locator('.c-heading', { hasText: 'Alpha' }).click();
    await page.locator('button[title="Move down"]').click();
    await expect.poll(order).toEqual(['Bravo', 'Alpha', 'Charlie']);

    // Move Alpha back UP → Alpha, Bravo, Charlie.
    await frame.locator('.c-heading', { hasText: 'Alpha' }).click();
    await page.locator('button[title="Move up"]').click();
    await expect.poll(order).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  test('SEO dialog edits page metadata and the renderer emits it', async ({ page }) => {
    await openEditor(page);
    await page.getByTestId('seo-open').click();
    await expect(page.getByTestId('seo-dialog')).toBeVisible();

    await page.getByTestId('seo-title').fill('Custom Home Title');
    await page.getByTestId('seo-description').fill('A crisp meta description for search.');
    await page.getByTestId('seo-noindex').check();
    // live Google preview reflects the typed title
    await expect(page.getByTestId('seo-dialog')).toContainText('Custom Home Title');
    await page.getByTestId('seo-save').click();
    await expect(page.getByTestId('seo-dialog')).not.toBeVisible();

    // Persisted AND emitted by the renderer — fetch the rendered preview head.
    const sites = (await (await page.request.get(`${BASE}/sites`)).json()) as Array<{ id: string }>;
    const html = await (await page.request.get(`${BASE}/preview/${sites[0]!.id}/`)).text();
    expect(html).toContain('<title>Custom Home Title</title>');
    expect(html).toContain('A crisp meta description for search.');
    expect(html).toContain('content="noindex"');
    expect(html).toContain('property="og:title" content="Custom Home Title"');
    expect(html).toContain('name="twitter:card"');
  });

  test('inline WYSIWYG: double-click a text node and type on the canvas', async ({ page }) => {
    await openEditor(page);
    const frame = page.frameLocator('[data-testid="canvas-frame"]');

    // Insert a fresh heading into the page root so we have a known leaf text node.
    await page.locator('.outline-row').first().click();
    await page.getByTestId('palette-heading').dblclick();
    await expect(page.locator('.toolbar .status')).toHaveText(/saved/);

    const heading = frame.locator('.c-heading', { hasText: 'Heading' });
    await expect(heading).toBeVisible();

    // Double-click starts inline editing: the injected script sets contenteditable
    // and selects the text; typing replaces it, Enter commits.
    await heading.dblclick();
    await expect(heading).toHaveAttribute('contenteditable', 'true');
    await page.keyboard.type('Edited right on the canvas');
    await page.keyboard.press('Enter');

    await expect(page.locator('.toolbar .status')).toHaveText(/saved/);
    await expect(frame.locator('.c-heading', { hasText: 'Edited right on the canvas' })).toBeVisible();

    // The edit went through the tree-ops pipeline, so undo reverts it.
    await page.getByRole('button', { name: /undo/ }).click();
    await expect(page.locator('.toolbar .status')).toHaveText(/saved/);
    await expect(frame.locator('.c-heading', { hasText: 'Heading' })).toBeVisible();
  });
});
