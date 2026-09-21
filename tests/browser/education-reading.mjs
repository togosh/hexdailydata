// Measure the rendered default article, including headings/resource hosts/disclosure labels.
// Count whitespace-delimited tokens containing a letter or number, not decorative symbols.
export async function readingCopy(page) {
  return page.locator('.learn-page').evaluate((root) => {
    const copy = root.cloneNode(true);
    copy.querySelectorAll('details:not([open])').forEach((details) => {
      for (const child of [...details.children]) if (child.tagName !== 'SUMMARY') child.remove();
    });
    copy.querySelectorAll('nav, .sr-only').forEach((element) => element.remove());
    copy.querySelectorAll('h1, h2, h3, p, dt, dd, li, summary, br, a').forEach((element) => {
      element.before(document.createTextNode(' '));
      element.after(document.createTextNode(' '));
    });
    const text = copy.textContent.replace(/\s+/g, ' ').trim();
    return {
      text,
      words: text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length,
      bodyFontPx: getComputedStyle(root).fontSize,
      documentHeight: document.documentElement.scrollHeight,
      closed: root.querySelectorAll('details:not([open])').length,
    };
  });
}
