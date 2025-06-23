import { editor } from "@silverbulletmd/silverbullet/syscalls";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

export enum BlockType {
  Heading = "heading",
  List = "list",
  Paragraph = "paragraph",
  Code = "code",
  Table = "table",
  Quote = "quote",
  FrontMatter = "frontMatter",
}

export interface HeadingInfo {
  text: string;
  level: number;
  pos: number;
}

export interface BlockBounds {
  from: number;
  to: number;
  type: BlockType;
  level?: number;
  content: string;
  title?: string;
  headingHierarchy?: HeadingInfo[];
}

export interface BlockReference {
  page: string;
  blockBounds: BlockBounds;
  timestamp: number;
}

/**
 * Detects the block at the cursor position using CodeMirror's syntax tree
 */
export async function detectBlockAtCursor(pos?: number): Promise<BlockBounds> {
  const cursorPos = pos ?? await editor.getCursor();
  const text = await editor.getText();
  
  // For now, we'll use a simplified block detection approach
  // without relying on the syntax tree, as getEditorState is not available
  const blockBounds = detectBlockAtPositionSimple(text, cursorPos);
  
  // Add heading hierarchy to the block bounds
  blockBounds.headingHierarchy = findParentHeadings(text, blockBounds.from);
  
  return blockBounds;
}

/**
 * Core block detection algorithm using syntax tree
 */
export function detectBlockAtPosition(
  text: string,
  cursorPos: number,
  syntaxTree: any
): BlockBounds {
  const node = syntaxTree.resolveInner(cursorPos);
  
  // Find the closest block-level node
  let blockNode = findBlockNode(node);
  
  if (!blockNode) {
    // Fallback to paragraph detection
    return detectParagraphBlock(text, cursorPos);
  }
  
  // Detect specific block types
  switch (blockNode.name) {
    case "ATXHeading1":
    case "ATXHeading2":
    case "ATXHeading3":
    case "ATXHeading4":
    case "ATXHeading5":
    case "ATXHeading6":
      return detectHeadingBlock(text, blockNode);
      
    case "ListItem":
    case "BulletList":
    case "OrderedList":
      return detectListBlock(text, cursorPos);
      
    case "FencedCode":
    case "CodeBlock":
      return detectCodeBlock(text, blockNode);
      
    case "Table":
    case "TableHeader":
      return detectTableBlock(text, blockNode);
      
    case "Blockquote":
      return detectQuoteBlock(text, blockNode);
      
    case "FrontMatter":
      return detectFrontMatterBlock(text, blockNode);
      
    default:
      return detectParagraphBlock(text, cursorPos);
  }
}

/**
 * Find the closest block-level node in the syntax tree
 */
function findBlockNode(node: SyntaxNode): SyntaxNode | null {
  const blockTypes = [
    "ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6",
    "ListItem", "BulletList", "OrderedList",
    "FencedCode", "CodeBlock",
    "Table", "TableHeader",
    "Blockquote",
    "FrontMatter",
    "Document"
  ];
  
  let current: SyntaxNode | null = node;
  while (current) {
    if (blockTypes.includes(current.name)) {
      return current;
    }
    current = current.parent;
  }
  
  return null;
}

/**
 * Detect heading blocks and their content boundaries
 */
function detectHeadingBlock(text: string, headingNode: SyntaxNode): BlockBounds {
  const level = parseInt(headingNode.name.slice(-1));
  const from = headingNode.from;
  
  // Find next heading of same or higher level
  let to = text.length;
  const lines = text.slice(headingNode.to).split('\n');
  let lineOffset = headingNode.to;
  
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      const nextLevel = line.match(/^(#+)/)?.[1].length ?? 0;
      if (nextLevel <= level) {
        to = lineOffset;
        break;
      }
    }
    lineOffset += line.length + 1;
  }
  
  const content = text.slice(from, to);
  const title = content.split('\n')[0].replace(/^#+\s*/, '').trim();
  
  return {
    from,
    to,
    type: BlockType.Heading,
    level,
    content,
    title
  };
}

/**
 * Detect list blocks using existing determineItemBounds logic
 */
function detectListBlock(text: string, cursorPos: number): BlockBounds {
  // Use existing outline functionality for list detection
  try {
    const { determineItemBounds } = require("./outline.ts");
    const bounds = determineItemBounds(text, cursorPos);
    
    const content = text.slice(bounds.from, bounds.to);
    const title = content.split('\n')[0].replace(/^\s*[-*]\s*/, '').slice(0, 50).trim();
    
    return {
      from: bounds.from,
      to: bounds.to,
      type: BlockType.List,
      level: bounds.indentLevel,
      content,
      title
    };
  } catch {
    // Fallback to paragraph if not a valid list item
    return detectParagraphBlock(text, cursorPos);
  }
}

/**
 * Detect code blocks
 */
function detectCodeBlock(text: string, codeNode: SyntaxNode): BlockBounds {
  const from = codeNode.from;
  const to = codeNode.to;
  const content = text.slice(from, to);
  
  // Extract language from fenced code block
  let title = "Code Block";
  if (codeNode.name === "FencedCode") {
    const firstLine = content.split('\n')[0];
    const lang = firstLine.replace(/^```/, '').trim();
    if (lang) {
      title = `${lang} Code`;
    }
  }
  
  return {
    from,
    to,
    type: BlockType.Code,
    content,
    title
  };
}

/**
 * Detect table blocks
 */
function detectTableBlock(text: string, tableNode: SyntaxNode): BlockBounds {
  const from = tableNode.from;
  const to = tableNode.to;
  const content = text.slice(from, to);
  
  return {
    from,
    to,
    type: BlockType.Table,
    content,
    title: "Table"
  };
}

/**
 * Detect quote blocks
 */
function detectQuoteBlock(text: string, quoteNode: SyntaxNode): BlockBounds {
  const from = quoteNode.from;
  const to = quoteNode.to;
  const content = text.slice(from, to);
  const title = content.split('\n')[0].replace(/^\s*>\s*/, '').slice(0, 50).trim();
  
  return {
    from,
    to,
    type: BlockType.Quote,
    content,
    title: title || "Quote"
  };
}

/**
 * Detect front matter blocks
 */
function detectFrontMatterBlock(text: string, frontMatterNode: SyntaxNode): BlockBounds {
  const from = frontMatterNode.from;
  const to = frontMatterNode.to;
  const content = text.slice(from, to);
  
  return {
    from,
    to,
    type: BlockType.FrontMatter,
    content,
    title: "Front Matter"
  };
}

/**
 * Detect paragraph blocks (fallback)
 */
function detectParagraphBlock(text: string, cursorPos: number): BlockBounds {
  const lines = text.split('\n');
  let lineStart = 0;
  let currentLine = 0;
  
  // Find which line the cursor is on
  for (let i = 0; i < lines.length; i++) {
    if (cursorPos <= lineStart + lines[i].length) {
      currentLine = i;
      break;
    }
    lineStart += lines[i].length + 1;
  }
  
  // Find paragraph boundaries (empty lines)
  let from = currentLine;
  let to = currentLine;
  
  // Go backwards to find start of paragraph
  while (from > 0 && lines[from - 1].trim() !== '') {
    from--;
  }
  
  // Go forwards to find end of paragraph
  while (to < lines.length - 1 && lines[to + 1].trim() !== '') {
    to++;
  }
  
  // Convert line numbers to character positions
  let fromPos = 0;
  for (let i = 0; i < from; i++) {
    fromPos += lines[i].length + 1;
  }
  
  let toPos = fromPos;
  for (let i = from; i <= to; i++) {
    toPos += lines[i].length;
    if (i < to) toPos += 1; // Add newline except for last line
  }
  
  const content = text.slice(fromPos, toPos);
  const title = content.split('\n')[0].slice(0, 50).trim();
  
  return {
    from: fromPos,
    to: toPos,
    type: BlockType.Paragraph,
    content,
    title: title || "Paragraph"
  };
}

/**
 * Get position information from character offset
 */
export function positionFromOffset(text: string, offset: number): { line: number; column: number } {
  const lines = text.slice(0, offset).split('\n');
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1
  };
}

/**
 * Get line number from character offset
 */
export function lineFromOffset(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

/**
 * Simplified block detection using regex patterns
 */
function detectBlockAtPositionSimple(text: string, cursorPos: number): BlockBounds {
  const lines = text.split('\n');
  let lineStart = 0;
  let currentLine = 0;
  
  // Find which line the cursor is on
  for (let i = 0; i < lines.length; i++) {
    if (cursorPos <= lineStart + lines[i].length) {
      currentLine = i;
      break;
    }
    lineStart += lines[i].length + 1;
  }
  
  const line = lines[currentLine];
  
  // Check for different block types
  
  // Heading detection
  const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    return detectHeadingBlockSimple(text, lines, currentLine, headingMatch[1].length);
  }
  
  // List item detection
  const listMatch = line.match(/^(\s*)([-*])\s+(.*)$/);
  if (listMatch) {
    return detectListBlockSimple(text, lines, currentLine, listMatch[1].length);
  }
  
  // Code block detection
  if (line.trim().startsWith('```')) {
    return detectCodeBlockSimple(text, lines, currentLine);
  }
  
  // Quote detection
  if (line.trim().startsWith('>')) {
    return detectQuoteBlockSimple(text, lines, currentLine);
  }
  
  // Fallback to paragraph
  return detectParagraphBlockSimple(text, lines, currentLine);
}

function detectHeadingBlockSimple(text: string, lines: string[], lineIndex: number, level: number): BlockBounds {
  const from = lines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0);
  
  // Find next heading of same or higher level
  let to = text.length;
  for (let i = lineIndex + 1; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^(#{1,6})\s+/);
    if (headingMatch && headingMatch[1].length <= level) {
      to = lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
      break;
    }
  }
  
  const content = text.slice(from, to);
  const title = lines[lineIndex].replace(/^#+\s*/, '').trim();
  
  return {
    from,
    to,
    type: BlockType.Heading,
    level,
    content,
    title
  };
}

function detectListBlockSimple(text: string, lines: string[], lineIndex: number, indentLevel: number): BlockBounds {
  // Use existing determineItemBounds logic
  try {
    const { determineItemBounds } = require("./outline.ts");
    const cursorPos = lines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0);
    const bounds = determineItemBounds(text, cursorPos);
    
    const content = text.slice(bounds.from, bounds.to);
    const title = content.split('\n')[0].replace(/^\s*[-*]\s*/, '').slice(0, 50).trim();
    
    return {
      from: bounds.from,
      to: bounds.to,
      type: BlockType.List,
      level: bounds.indentLevel,
      content,
      title
    };
  } catch {
    // Fallback to simple detection
    const from = lines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0);
    const to = from + lines[lineIndex].length;
    const content = lines[lineIndex];
    const title = content.replace(/^\s*[-*]\s*/, '').slice(0, 50).trim();
    
    return {
      from,
      to,
      type: BlockType.List,
      level: indentLevel,
      content,
      title
    };
  }
}

function detectCodeBlockSimple(text: string, lines: string[], lineIndex: number): BlockBounds {
  const from = lines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0);
  
  // Find closing code fence
  let to = text.length;
  for (let i = lineIndex + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) {
      to = lines.slice(0, i + 1).join('\n').length;
      break;
    }
  }
  
  const content = text.slice(from, to);
  const firstLine = lines[lineIndex];
  const lang = firstLine.replace(/^```/, '').trim();
  const title = lang ? `${lang} Code` : "Code Block";
  
  return {
    from,
    to,
    type: BlockType.Code,
    content,
    title
  };
}

function detectQuoteBlockSimple(text: string, lines: string[], lineIndex: number): BlockBounds {
  // Find start and end of quote block
  let from = lineIndex;
  let to = lineIndex;
  
  // Go backwards to find start
  while (from > 0 && lines[from - 1].trim().startsWith('>')) {
    from--;
  }
  
  // Go forwards to find end
  while (to < lines.length - 1 && lines[to + 1].trim().startsWith('>')) {
    to++;
  }
  
  const fromPos = lines.slice(0, from).join('\n').length + (from > 0 ? 1 : 0);
  const toPos = lines.slice(0, to + 1).join('\n').length;
  
  const content = text.slice(fromPos, toPos);
  const title = lines[lineIndex].replace(/^\s*>\s*/, '').slice(0, 50).trim();
  
  return {
    from: fromPos,
    to: toPos,
    type: BlockType.Quote,
    content,
    title: title || "Quote"
  };
}

function detectParagraphBlockSimple(text: string, lines: string[], lineIndex: number): BlockBounds {
  // Find paragraph boundaries (empty lines)
  let from = lineIndex;
  let to = lineIndex;
  
  // Go backwards to find start of paragraph
  while (from > 0 && lines[from - 1].trim() !== '') {
    from--;
  }
  
  // Go forwards to find end of paragraph
  while (to < lines.length - 1 && lines[to + 1].trim() !== '') {
    to++;
  }
  
  const fromPos = lines.slice(0, from).join('\n').length + (from > 0 ? 1 : 0);
  const toPos = lines.slice(0, to + 1).join('\n').length;
  
  const content = text.slice(fromPos, toPos);
  const title = content.split('\n')[0].slice(0, 50).trim();
  
  return {
    from: fromPos,
    to: toPos,
    type: BlockType.Paragraph,
    content,
    title: title || "Paragraph"
  };
}

/**
 * Finds all parent headings above a given position in the document
 * Returns them in hierarchical order (top-level to immediate parent)
 */
export function findParentHeadings(text: string, blockPos: number): HeadingInfo[] {
  const lines = text.split('\n');
  const headings: HeadingInfo[] = [];
  let currentPos = 0;
  
  // Track the hierarchy - only include headings that are actually parents
  const hierarchyStack: HeadingInfo[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = currentPos;
    currentPos += line.length + 1; // +1 for newline
    
    // Stop if we've passed the block position
    if (lineStart >= blockPos) {
      break;
    }
    
    // Check if this line is a heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      
      const headingInfo: HeadingInfo = {
        text,
        level,
        pos: lineStart
      };
      
      // Pop from stack until we find a parent (lower level number = higher in hierarchy)
      while (hierarchyStack.length > 0 && hierarchyStack[hierarchyStack.length - 1].level >= level) {
        hierarchyStack.pop();
      }
      
      // Add to stack
      hierarchyStack.push(headingInfo);
    }
  }
  
  // Return the current hierarchy stack (these are the parent headings)
  return [...hierarchyStack];
}