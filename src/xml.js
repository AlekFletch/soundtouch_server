// Минимальные XML-утилиты: API колонки отдаёт простой XML, парсер не нужен

export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXml(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Текст первого тега <name>...</name> (без учёта префикса пространства имён)
export function tagText(xml, name) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? unescapeXml(m[1].trim()) : '';
}

// Значение атрибута первого тега
export function tagAttr(xml, name, attr) {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*\\s${attr}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : '';
}

// Все блоки <name>...</name>
export function tagBlocks(xml, name) {
  return xml.match(new RegExp(`<(?:\\w+:)?${name}[\\s>][\\s\\S]*?</(?:\\w+:)?${name}>`, 'g')) || [];
}
