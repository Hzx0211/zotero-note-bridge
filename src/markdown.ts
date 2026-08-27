import MarkdownIt from 'markdown-it';
import {htmlToMarkdown} from 'obsidian';
import {normalizeNoteMarkdown} from './core';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false
});

const ALLOWED_TAGS = new Set([
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 's', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'
]);
const DROP_CONTENT_TAGS = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed']);

function safeHref(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(https?:|mailto:|zotero:)/i.test(trimmed)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith('//');
}

function sanitizeHtml(rendered: string): string {
  const doc = new DOMParser().parseFromString(rendered, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  let comment: Node | null;
  while ((comment = walker.nextNode())) comments.push(comment);
  for (const node of comments) node.parentNode?.removeChild(node);

  const elements = Array.from(doc.body.querySelectorAll('*')).reverse();
  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (DROP_CONTENT_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }

    const originalHref = tag === 'a' ? element.getAttribute('data-znb-href') ?? '' : '';
    for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name);
    if (tag === 'a') {
      const source = element as HTMLAnchorElement;
      if (safeHref(originalHref)) source.setAttribute('href', originalHref);
    }
  }
  return doc.body.innerHTML;
}

function preserveLinkTargets(rendered: string): string {
  const doc = new DOMParser().parseFromString(rendered, 'text/html');
  for (const anchor of Array.from(doc.body.querySelectorAll('a[href]'))) {
    anchor.setAttribute('data-znb-href', anchor.getAttribute('href') ?? '');
  }
  return doc.body.innerHTML;
}

export function markdownToZoteroHtml(value: string): string {
  const rendered = markdown.render(normalizeNoteMarkdown(value));
  const sanitized = sanitizeHtml(preserveLinkTargets(rendered));
  return `<div data-schema-version="9">${sanitized}</div>`;
}

export function zoteroHtmlToMarkdown(value: string): string {
  return normalizeNoteMarkdown(htmlToMarkdown(String(value ?? '')));
}
