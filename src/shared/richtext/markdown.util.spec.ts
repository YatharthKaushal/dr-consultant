/**
 * This is a SECURITY test, not a formatting test. `renderMarkdownToHtml`'s
 * entire safety argument is "escape first, then interpret constructs" — the
 * job of this file is to prove no interpreted construct can ever put a real
 * tag, attribute, or script-executing URL back into the output.
 */
import { renderMarkdownToHtml, renderPlainTextToHtml } from './markdown.util';

describe('renderMarkdownToHtml — XSS resistance', () => {
  it('neutralises a raw <script> tag entirely — it is never treated as markup', () => {
    const html = renderMarkdownToHtml('Before <script>alert(1)</script> after');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('neutralises an img onerror payload', () => {
    const html = renderMarkdownToHtml('<img src=x onerror=alert(1)>');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;img');
  });

  it('refuses a javascript: link — renders the literal markdown as inert text, no <a>, no live href', () => {
    const html = renderMarkdownToHtml('[click me](javascript:alert(1))');
    expect(html).not.toContain('<a ');
    expect(html).not.toMatch(/href=/i);
  });

  it('refuses a data: link — no <a>, no live href (the payload survives only as escaped, non-executing text)', () => {
    const html = renderMarkdownToHtml('[click me](data:text/html,<script>alert(1)</script>)');
    expect(html).not.toContain('<a ');
    expect(html).not.toMatch(/href=/i);
    expect(html).not.toContain('<script>');
  });

  it('refuses a vbscript: link and a bare protocol-relative URL', () => {
    expect(renderMarkdownToHtml('[x](vbscript:msgbox(1))')).not.toContain('<a ');
    expect(renderMarkdownToHtml('[x](//evil.example/x)')).not.toContain('<a ');
  });

  it('accepts http/https/mailto and renders a real, safe anchor', () => {
    const https = renderMarkdownToHtml('[Privacy](https://example.com/privacy)');
    expect(https).toContain('<a href="https://example.com/privacy" rel="noopener noreferrer" target="_blank">Privacy</a>');

    const mail = renderMarkdownToHtml('[Contact us](mailto:privacy@example.com)');
    expect(mail).toContain('<a href="mailto:privacy@example.com"');
  });

  it('cannot be broken out of via a crafted quote/attribute in the URL', () => {
    const html = renderMarkdownToHtml('[x](https://example.com/"onmouseover="alert(1))');
    // Whatever comes out, there must be no live onmouseover attribute — either
    // refused entirely, or the quote character is escaped inside the href.
    expect(html).not.toMatch(/"\s*onmouseover=/);
  });

  it('escapes markup smuggled inside bold/italic/code spans', () => {
    const html = renderMarkdownToHtml('**<b>bold</b>** and *<i>italic</i>* and `<code>x</code>`');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>italic</i>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('escapes markup smuggled inside a heading, list item and blockquote', () => {
    const heading = renderMarkdownToHtml('# <script>alert(1)</script>');
    expect(heading).not.toContain('<script>');

    const list = renderMarkdownToHtml('- <img src=x onerror=alert(1)>');
    expect(list).not.toMatch(/<img/i);

    const quote = renderMarkdownToHtml('> <script>alert(1)</script>');
    expect(quote).not.toContain('<script>');
  });

  it('never lets an ampersand-based entity trick reconstruct a tag', () => {
    // A classic double-encoding bypass attempt: if this renderer ever
    // decoded before re-escaping, `&lt;` could round-trip into `<`.
    const html = renderMarkdownToHtml('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('renderMarkdownToHtml — formatting', () => {
  it('renders headings, bold, italic and code', () => {
    const html = renderMarkdownToHtml('# Title\n\nSome **bold** and *italic* and `code`.');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
  });

  it('groups consecutive list lines into one <ul>/<ol>', () => {
    const html = renderMarkdownToHtml('- one\n- two\n- three');
    expect(html).toBe('<ul><li>one</li><li>two</li><li>three</li></ul>');

    const ordered = renderMarkdownToHtml('1. first\n2. second');
    expect(ordered).toBe('<ol><li>first</li><li>second</li></ol>');
  });

  it('renders a lone "---" as <hr>', () => {
    expect(renderMarkdownToHtml('above\n\n---\n\nbelow')).toBe('<p>above</p>\n<hr>\n<p>below</p>');
  });

  it('groups blank-line-separated text into paragraphs', () => {
    const html = renderMarkdownToHtml('First paragraph.\n\nSecond paragraph.');
    expect(html).toBe('<p>First paragraph.</p>\n<p>Second paragraph.</p>');
  });
});

describe('renderPlainTextToHtml', () => {
  it('escapes and never interprets markdown constructs', () => {
    const html = renderPlainTextToHtml('**not bold** <script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<strong>');
    expect(html).toContain('**not bold**');
  });
});
