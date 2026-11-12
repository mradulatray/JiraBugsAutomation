// Atlassian Document Format (Jira v3 rich text) -> plain Markdown.
// Deliberately lossy: the goal is readable text for the agent, not a faithful render.
// Media is never fetched; it becomes a placeholder.

function marks(text, nodeMarks = []) {
  let out = text;
  for (const m of nodeMarks) {
    if (m?.type === 'code') out = `\`${out}\``;
    else if (m?.type === 'strong') out = `**${out}**`;
    else if (m?.type === 'em') out = `_${out}_`;
    else if (m?.type === 'strike') out = `~~${out}~~`;
    else if (m?.type === 'link' && typeof m.attrs?.href === 'string') out = `[${out}](${m.attrs.href})`;
  }
  return out;
}

function inline(nodes = []) {
  return nodes.map(inlineNode).join('');
}

function inlineNode(n) {
  if (!n || typeof n !== 'object') return '';
  switch (n.type) {
    case 'text':
      return marks(String(n.text ?? ''), n.marks);
    case 'hardBreak':
      return '\n';
    case 'mention':
      return `@${String(n.attrs?.text ?? 'user').replace(/^@/, '')}`;
    case 'emoji':
      return String(n.attrs?.text ?? n.attrs?.shortName ?? '');
    case 'inlineCard':
    case 'blockCard':
      return String(n.attrs?.url ?? '');
    case 'date':
      return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : '';
    case 'status':
      return `[${String(n.attrs?.text ?? '')}]`;
    case 'media':
    case 'mediaInline':
      return `[attachment${n.attrs?.alt ? `: ${n.attrs.alt}` : ''}]`;
    default:
      return Array.isArray(n.content) ? inline(n.content) : '';
  }
}

function indent(text, prefix) {
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? l : `${' '.repeat(prefix.length)}${l}`))
    .join('\n');
}

function block(n, depth = 0) {
  if (!n || typeof n !== 'object' || depth > 20) return '';
  const kids = (sep = '\n\n') => (n.content ?? []).map((c) => block(c, depth + 1)).filter(Boolean).join(sep);
  switch (n.type) {
    case 'doc':
      return kids();
    case 'paragraph':
      return inline(n.content);
    case 'heading':
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(n.attrs?.level) || 1)))} ${inline(n.content)}`;
    case 'bulletList':
      return (n.content ?? []).map((li) => `- ${indent(block(li, depth + 1), '- ')}`).join('\n');
    case 'orderedList': {
      const start = Number(n.attrs?.order) || 1;
      return (n.content ?? []).map((li, i) => `${start + i}. ${indent(block(li, depth + 1), `${start + i}. `)}`).join('\n');
    }
    case 'taskList':
      return (n.content ?? []).map((t) => `- [${t?.attrs?.state === 'DONE' ? 'x' : ' '}] ${inline(t?.content)}`).join('\n');
    case 'listItem':
      return kids('\n');
    case 'codeBlock':
      return `\`\`\`${n.attrs?.language ?? ''}\n${(n.content ?? []).map((t) => t?.text ?? '').join('')}\n\`\`\``;
    case 'blockquote':
      return kids()
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'panel':
      return `> **${String(n.attrs?.panelType ?? 'note').toUpperCase()}**\n${kids()
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')}`;
    case 'rule':
      return '---';
    case 'mediaSingle':
    case 'mediaGroup':
      return (n.content ?? []).map(inlineNode).join(' ');
    case 'expand':
    case 'nestedExpand':
      return `**${String(n.attrs?.title ?? 'Details')}**\n\n${kids()}`;
    case 'table':
      return (n.content ?? [])
        .map((row) => `| ${(row?.content ?? []).map((cell) => block(cell, depth + 1).replace(/\n+/g, ' ').replace(/\|/g, '\\|')).join(' | ')} |`)
        .join('\n');
    case 'tableCell':
    case 'tableHeader':
      return kids(' ');
    default:
      return Array.isArray(n.content) ? kids() : inlineNode(n);
  }
}

/** Accepts an ADF doc, a plain string (v2-style fields), or null. */
export function adfToMarkdown(doc) {
  if (doc == null) return '';
  if (typeof doc === 'string') return doc;
  return block(doc).replace(/\n{3,}/g, '\n\n').trim();
}
