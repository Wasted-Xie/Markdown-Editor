import { slugify } from "./renderer";

export interface OutlineHeading {
  /** 标题级别 1-6 */
  level: number;
  /** 纯文本标题（已去掉行内标记） */
  text: string;
  /** 与 markdown-it 生成的锚点 id 一致 */
  id: string;
  /** 源码行号（从 1 开始） */
  line: number;
}

/** 去掉标题里的行内 Markdown 标记，得到用于展示的纯文本 */
function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/**
 * 从 Markdown 源码提取大纲。
 *
 * 使用与 renderer 相同的 [`slugify`] 规则并做重复计数，
 * 因此生成的 id 与 markdown-it 标题锚点一一对应，可直接跳转。
 */
export function extractOutline(source: string): OutlineHeading[] {
  const lines = source.split(/\r\n|\r|\n/);
  const headings: OutlineHeading[] = [];
  const used = new Map<string, number>();

  let fence: string | null = null;
  let inFrontMatter = lines.length > 0 && lines[0].trim() === "---";

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];

    // 跳过 YAML front matter
    if (inFrontMatter && i > 0) {
      if (raw.trim() === "---" || raw.trim() === "...") inFrontMatter = false;
      continue;
    }

    const fenceMatch = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const m = raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m) continue;

    const level = m[1].length;
    const text = stripInline(m[2]);
    if (!text) continue;

    let id = slugify(text);
    const count = used.get(id) ?? 0;
    used.set(id, count + 1);
    if (count > 0) id = `${id}-${count}`;

    headings.push({ level, text, id, line: i + 1 });
  }

  return headings;
}

/** 统计正文字数（中文按字计，英文按词计） */
export function countWords(text: string): number {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const latin =
    text
      .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, " ")
      .match(/[A-Za-z0-9_'-]+/g)?.length ?? 0;
  return cjk + latin;
}
