import { clientStore, editor, markdown, space } from "@silverbulletmd/silverbullet/syscalls";
import type { BlockBounds, BlockReference } from "./block_focus.ts";
import { positionFromOffset, lineFromOffset } from "./block_focus.ts";

export interface PinnedBlock {
  id: string;
  page: string;
  fromLine: number;
  toLine: number;
  preview: string;
  title?: string;
  pinnedAt: number;
  lastAccessed: number;
  blockBounds: BlockBounds;
}

export interface SidebarBlockView {
  id: string;
  mode: "sidebar";
  blockBounds: BlockBounds;
  sourcePage: string;
  sourcePosition: { line: number; column: number };
  showBreadcrumb: boolean;
  showActions: boolean;
  isEditing: boolean;
  isMinimized?: boolean;
  addedAt: number;
}

export interface BlockFocusState {
  pinnedBlocks: PinnedBlock[];
  navigationHistory: BlockReference[];
  viewPreferences: {
    defaultMode: "sidebar" | "split";
    splitPosition: "right" | "bottom";
    splitSize: number;
  };
}

export class TransientBlockViewManager {
  private sidebarViews: Map<string, SidebarBlockView> = new Map();
  private sidebarOrder: string[] = []; // Track visual order of sidebar blocks
  private activeBlockId?: string;
  private pinnedBlocks: Map<string, PinnedBlock> = new Map();
  private static instance: TransientBlockViewManager;

  private constructor() {
    // State loading now handled in getInstance()
  }

  static async getInstance(): Promise<TransientBlockViewManager> {
    if (!TransientBlockViewManager.instance) {
      TransientBlockViewManager.instance = new TransientBlockViewManager();
      await TransientBlockViewManager.instance.loadState();
    }
    return TransientBlockViewManager.instance;
  }

  /**
   * Opens a block in a sidebar view
   */
  async openBlockSidebar(block: BlockBounds, page: string): Promise<void> {
    const blockId = `${page}:${block.from}:${Date.now()}`;

    // Check if this block is already open
    const existingId = this.findExistingBlock(block, page);
    if (existingId) {
      this.activeBlockId = existingId;
      await this.renderSidebar();
      return;
    }

    const sidebarView: SidebarBlockView = {
      id: blockId,
      mode: "sidebar",
      blockBounds: block,
      sourcePage: page,
      sourcePosition: positionFromOffset(block.content, block.from),
      showBreadcrumb: true,
      showActions: true,
      isEditing: false,
      addedAt: Date.now()
    };

    this.sidebarViews.set(blockId, sidebarView);
    this.sidebarOrder.push(blockId); // Add to order tracking
    this.activeBlockId = blockId;
    await this.renderSidebar();
  }

  /**
   * Pins a block for persistent access
   */
  async pinBlock(block: BlockBounds, page: string, title?: string): Promise<void> {
    const id = `${page}:${block.from}:${Date.now()}`;
    const pinned: PinnedBlock = {
      id,
      page,
      fromLine: lineFromOffset(block.content, block.from),
      toLine: lineFromOffset(block.content, block.to),
      preview: block.content.slice(0, 100),
      title: title || this.detectTitle(block),
      pinnedAt: Date.now(),
      lastAccessed: Date.now(),
      blockBounds: block
    };

    this.pinnedBlocks.set(id, pinned);
    await this.persistPinnedBlocks();
    await editor.flashNotification(`Block pinned: ${pinned.title}`, "info");
  }

  /**
   * Unpins a block
   */
  async unpinBlock(id: string): Promise<void> {
    this.pinnedBlocks.delete(id);
    await this.persistPinnedBlocks();
  }

  /**
   * Gets all pinned blocks
   */
  getPinnedBlocks(): PinnedBlock[] {
    return Array.from(this.pinnedBlocks.values())
      .sort((a, b) => b.lastAccessed - a.lastAccessed);
  }

  /**
   * Navigates to a pinned block
   */
  async navigateToPinnedBlock(id: string): Promise<void> {
    const pinned = this.pinnedBlocks.get(id);
    if (!pinned) {
      await editor.flashNotification("Pinned block not found", "error");
      return;
    }

    try {
      // Update last accessed time
      pinned.lastAccessed = Date.now();
      await this.persistPinnedBlocks();

      // Navigate to the page and position
      await editor.navigate({ kind: "page", page: pinned.page });

      // Try to find the block content in the current page
      const currentText = await editor.getText();
      const updatedBlock = await this.findBlockInContent(pinned, currentText);

      if (updatedBlock) {
        // Update the pinned block with current position
        pinned.blockBounds = updatedBlock;
        await editor.moveCursor(updatedBlock.from);
        await this.openBlockSidebar(updatedBlock, pinned.page);
      } else {
        await editor.flashNotification(
          `Block "${pinned.title}" may have been modified`,
          "info"
        );
      }
    } catch (error) {
      await editor.flashNotification(
        `Error navigating to block: ${error}`,
        "error"
      );
    }
  }

  /**
   * Toggles the minimize state of a specific block
   */
  toggleMinimize(blockId: string): void {
    const view = this.sidebarViews.get(blockId);
    if (view) {
      view.isMinimized = !view.isMinimized;
      this.renderSidebar();
    }
  }

  /**
   * Closes a specific block or all blocks if no ID provided
   */
  closeSidebar(blockId?: string): void {
    if (blockId) {
      this.sidebarViews.delete(blockId);
      // Remove from order tracking
      const index = this.sidebarOrder.indexOf(blockId);
      if (index > -1) {
        this.sidebarOrder.splice(index, 1);
      }
      if (this.activeBlockId === blockId) {
        // Set active to the most recently added block
        const remaining = Array.from(this.sidebarViews.values());
        this.activeBlockId = remaining.length > 0
          ? remaining.sort((a, b) => b.addedAt - a.addedAt)[0].id
          : undefined;
      }
      if (this.sidebarViews.size > 0) {
        this.renderSidebar();
      } else {
        this.closeEntireSidebar().catch(console.error);
      }
    } else {
      this.closeEntireSidebar().catch(console.error);
    }
  }

  /**
   * Closes the entire sidebar (all blocks)
   */
  private async closeEntireSidebar(): Promise<void> {
    this.sidebarViews.clear();
    this.sidebarOrder = []; // Clear order tracking
    this.activeBlockId = undefined;
    // Use SilverBullet's panel system to hide the sidebar instead of direct DOM manipulation
    await editor.hidePanel("rhs");
  }

  /**
   * Toggles edit mode for the active sidebar block
   */
  async toggleEditMode(blockId?: string): Promise<void> {
    const targetId = blockId || this.activeBlockId;
    if (!targetId) return;

    const sidebarView = this.sidebarViews.get(targetId);
    if (!sidebarView) return;

    sidebarView.isEditing = !sidebarView.isEditing;
    await this.renderSidebar();
  }

  /**
   * Handles block content changes during editing
   */
  async handleBlockEdit(newContent: string, blockId?: string): Promise<void> {
    const targetId = blockId || this.activeBlockId;
    if (!targetId) return;

    const sidebarView = this.sidebarViews.get(targetId);
    if (!sidebarView) return;

    const { sourcePage, blockBounds } = sidebarView;

    try {
      // Update the source document
      await this.updateSourceBlock(sourcePage, blockBounds, newContent);

      // Update the block bounds with new content
      sidebarView.blockBounds.content = newContent;

      await editor.flashNotification("Block updated", "info");
    } catch (error) {
      await editor.flashNotification(
        `Error updating block: ${error}`,
        "error"
      );
    }
  }

  /**
   * Updates the source document with new block content
   */
  private async updateSourceBlock(
    page: string,
    oldBounds: BlockBounds,
    newContent: string
  ): Promise<void> {
    // Read the current page content
    const pageContent = await space.readPage(page);

    // Replace the old block content with new content
    const before = pageContent.slice(0, oldBounds.from);
    const after = pageContent.slice(oldBounds.to);
    const updatedContent = before + newContent + after;

    // Write back to the page
    await space.writePage(page, updatedContent);

    // Update block bounds for position changes
    oldBounds.to = oldBounds.from + newContent.length;
    oldBounds.content = newContent;
  }

  /**
   * Renders the sidebar UI using SilverBullet's panel system
   */
  private async renderSidebar(): Promise<void> {
    if (this.sidebarViews.size === 0) return;

    // Message handler is now set up automatically via the SilverBullet event system

    // Use SilverBullet's panel system to show the sidebar
    const html = await this.generateSidebarHTML();
    const script = this.generateSidebarScript();


    await editor.showPanel("rhs", 1, html, script);
  }

  /**
   * Generates the HTML for the block focus sidebar
   */
  private async generateSidebarHTML(): Promise<string> {
    if (this.sidebarViews.size === 0) return "";

    // Use sidebar order for consistent visual ordering
    const sidebarViews = this.sidebarOrder
      .map(id => this.sidebarViews.get(id))
      .filter(view => view !== undefined) as SidebarBlockView[];

    const blockPromises = sidebarViews.map((view, index) =>
      this.generateSingleBlockHTML(view, index, index === sidebarViews.length - 1)
    );
    const blocksHTML = (await Promise.all(blockPromises)).join('');

    return `
      <style>
        /* CSS Variables for iframe - extracted from theme.scss */
        html {
          --ui-accent-color: #464cfc;

          /* Block Focus Icons */
          --close-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>');
          --pin-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9 6 6M9 9h8.5a1 1 0 0 1 1 1v1.5M9 9V4.4c0-.9.7-1.6 1.6-1.6h1.8c.9 0 1.6.7 1.6 1.6v3.1M18.5 19.5 21 22M12 12l4.5 4.5"></path></svg>');
          --edit-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 21 1.9-5.7a8.5 8.5 0 1 1 3.8 3.8z"></path><path d="m21 12-1-1"></path></svg>');
          --view-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>');
          --location-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg>');
          --drag-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="1"></circle><circle cx="9" cy="5" r="1"></circle><circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="15" cy="5" r="1"></circle><circle cx="15" cy="19" r="1"></circle></svg>');
          --minimize-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path></svg>');
          --maximize-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path></svg>');
          --ui-accent-contrast-color: #eee;
          --meta-subtle-color: #959595;
          --modal-color: inherit;
          --modal-background-color: #fff;
          --modal-border-color: rgb(108, 108, 108);
          --modal-selected-option-background-color: var(--ui-accent-color);
          --button-background-color: #eee;
          --button-hover-background-color: inherit;
          --button-color: black;
          --button-border-color: #6c6c6c;
          --primary-button-background-color: var(--ui-accent-color);
          --primary-button-hover-background-color: color-mix(in srgb, var(--ui-accent-color), black 35%);
          --primary-button-color: var(--ui-accent-contrast-color);
          --primary-button-border-color: transparent;
          --panel-border-color: #fff;
          --editor-border-color: #cacaca;
          --editor-code-background-color: rgba(72, 72, 72, 0.1);
          --editor-heading-color: #333;
          --editor-font: "iA-Mono", "Menlo";
          --ui-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
        }

        html[data-theme="dark"] {
          --ui-accent-color: #464cfc;

          /* Block Focus Icons */
          --close-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>');
          --pin-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9 6 6M9 9h8.5a1 1 0 0 1 1 1v1.5M9 9V4.4c0-.9.7-1.6 1.6-1.6h1.8c.9 0 1.6.7 1.6 1.6v3.1M18.5 19.5 21 22M12 12l4.5 4.5"></path></svg>');
          --edit-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 21 1.9-5.7a8.5 8.5 0 1 1 3.8 3.8z"></path><path d="m21 12-1-1"></path></svg>');
          --view-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>');
          --location-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg>');
          --drag-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="1"></circle><circle cx="9" cy="5" r="1"></circle><circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="15" cy="5" r="1"></circle><circle cx="15" cy="19" r="1"></circle></svg>');
          --minimize-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path></svg>');
          --maximize-icon: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path></svg>');
          --ui-accent-contrast-color: #eee;
          --meta-subtle-color: #959595;
          --modal-color: #ccc;
          --modal-background-color: #262626;
          --modal-border-color: #6c6c6c;
          --modal-selected-option-background-color: var(--ui-accent-color);
          --button-background-color: #555;
          --button-hover-background-color: #777;
          --button-color: white;
          --button-border-color: #666;
          --primary-button-background-color: var(--ui-accent-color);
          --primary-button-hover-background-color: color-mix(in srgb, var(--ui-accent-color), black 35%);
          --primary-button-color: var(--ui-accent-contrast-color);
          --primary-button-border-color: transparent;
          --panel-border-color: rgb(62, 62, 62);
          --editor-border-color: rgb(62, 62, 62);
          --editor-code-background-color: rgba(105, 105, 105, 0.1);
          --editor-heading-color: #ccc;
        }

        /* Block Focus Sidebar Styles - moved from block_focus.scss for iframe */
        .sb-block-focus-sidebar-container {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 1000;
          pointer-events: none;
        }

        .sb-sidebar-header {
          padding: 12px 16px;
          background-color: var(--modal-background-color);
          border-bottom: 1px solid var(--modal-border-color);
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 14px;
          font-weight: 500;
        }

        .sb-sidebar-header h3 {
          margin: 0;
          color: var(--modal-color);
          font-family: var(--ui-font);
          font-size: 14px;
          font-weight: 500;
        }

        .sb-block-item {
          border-bottom: 1px solid var(--modal-border-color);
          transition: background-color 0.2s ease;
          position: relative;
        }

        .sb-block-item.sb-dragging {
          opacity: 0.5;
          transform: rotate(5deg);
        }

        .sb-block-item.sb-drag-over {
          border-top: 3px solid var(--ui-accent-color);
        }

        .sb-block-item.sb-active {
          background-color: var(--modal-selected-option-background-color);
          border-left: 3px solid var(--ui-accent-color);
        }

        .sb-block-item:last-child {
          border-bottom: none;
        }

        .sb-block-breadcrumb {
          padding: 10px 16px;
          background-color: var(--modal-background-color);
          border-bottom: 1px solid var(--modal-border-color);
          font-size: 12px;
          color: var(--meta-subtle-color);
          display: flex;
          align-items: center;
          gap: 6px;
          font-family: var(--ui-font);
          position: relative;
        }
        
        .sb-breadcrumb-wrapper {
          display: flex;
          align-items: center;
          gap: 6px;
          overflow-x: auto;
          scrollbar-width: thin;
          scrollbar-color: var(--meta-subtle-color) transparent;
          margin-left: 20px; /* Space for drag handle */
          margin-right: 56px; /* Space for minimize and close buttons */
          flex: 1;
        }
        
        .sb-breadcrumb-wrapper::-webkit-scrollbar {
          height: 4px;
        }
        
        .sb-breadcrumb-wrapper::-webkit-scrollbar-track {
          background: transparent;
        }
        
        .sb-breadcrumb-wrapper::-webkit-scrollbar-thumb {
          background-color: var(--meta-subtle-color);
          border-radius: 2px;
        }
        
        .sb-breadcrumb-item {
          white-space: nowrap;
          cursor: pointer;
          transition: color 0.2s ease;
        }
        
        .sb-breadcrumb-item:hover {
          color: var(--ui-accent-color);
          text-decoration: underline;
        }
        
        .sb-breadcrumb-item.sb-current {
          color: var(--modal-color);
          cursor: pointer;
          font-weight: 500;
        }
        
        .sb-breadcrumb-item.sb-current:hover {
          color: var(--ui-accent-color);
          text-decoration: underline;
        }
        
        .sb-breadcrumb-toggle {
          background: none;
          border: 1px solid var(--button-border-color);
          border-radius: 3px;
          padding: 2px 6px;
          color: var(--button-color);
          font-size: 11px;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        
        .sb-breadcrumb-toggle:hover {
          background-color: var(--button-hover-background-color);
          border-color: var(--ui-accent-color);
        }
        
        .sb-breadcrumb-separator {
          color: var(--meta-subtle-color);
          margin: 0 4px;
        }
        
        .sb-breadcrumb-ellipsis {
          color: var(--meta-subtle-color);
          cursor: default;
        }

        .sb-drag-handle {
          position: absolute;
          left: 8px;
          top: 50%;
          transform: translateY(-50%);
          cursor: grab;
          color: var(--meta-subtle-color);
          padding: 4px;
          border-radius: 3px;
          transition: all 0.2s ease;
        }

        .sb-drag-handle:hover {
          background-color: var(--modal-selected-option-background-color);
          color: var(--modal-color);
        }

        .sb-drag-handle:active {
          cursor: grabbing;
        }


        .sb-block-close-btn {
          position: absolute;
          right: 8px;
          top: 50%;
          transform: translateY(-50%);
          background: none;
          border: none;
          color: var(--meta-subtle-color);
          cursor: pointer;
          padding: 4px;
          border-radius: 3px;
          font-size: 12px;
          transition: all 0.2s ease;
        }

        .sb-block-close-btn:hover {
          background-color: var(--modal-selected-option-background-color);
          color: var(--modal-color);
        }

        .sb-block-minimize-btn {
          position: absolute;
          right: 32px;
          top: 50%;
          transform: translateY(-50%);
          background: none;
          border: none;
          color: var(--meta-subtle-color);
          cursor: pointer;
          padding: 4px;
          border-radius: 3px;
          font-size: 12px;
          transition: all 0.2s ease;
        }

        .sb-block-minimize-btn:hover {
          background-color: var(--modal-selected-option-background-color);
          color: var(--modal-color);
        }

        .sb-block-focus-sidebar-overlay {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(0, 0, 0, 0.02);
          pointer-events: all;
          cursor: pointer;
        }

        .sb-block-focus-sidebar-wrapper {
          position: absolute;
          top: 0;
          right: 0;
          bottom: 0;
          width: 400px;
          max-width: 90%;
          background-color: var(--modal-background-color);
          border-left: 1px solid var(--panel-border-color);
          box-shadow: -2px 0 8px rgba(0, 0, 0, 0.1);
          pointer-events: all;
          transform: translateX(100%);
          transition: transform 0.3s ease-out;
          animation: sb-sidebar-slide-in 0.3s ease-out forwards;
        }

        @keyframes sb-sidebar-slide-in {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }

        .sb-block-focus-sidebar {
          height: 100%;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .sb-block-content {
          padding: 16px;
          flex: 1;
          overflow-y: auto;
          line-height: 1.6;
          font-family: var(--ui-font);
          color: var(--modal-color);
          background-color: var(--modal-background-color);
          cursor: pointer;
          transition: background-color 0.2s ease;
        }

        .sb-block-content:hover {
          background-color: var(--modal-selected-option-background-color);
        }

        .sb-block-content.sb-editing {
          padding: 0;
        }

        .sb-block-editor {
          padding: 16px;
          min-height: 200px;
          border: none;
          outline: none;
          background-color: transparent;
        }

        .sb-block-editor-textarea {
          width: 100%;
          min-height: 200px;
          padding: 16px;
          border: none;
          outline: none;
          font-family: inherit;
          background: transparent;
          resize: vertical;
          color: var(--modal-color);
        }

        .sb-block-actions {
          padding: 12px 16px;
          background-color: var(--modal-background-color);
          border-top: 1px solid var(--modal-border-color);
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
        }

        .sb-block-actions-left {
          display: flex;
          gap: 8px;
        }

        .sb-block-action-btn {
          padding: 6px 12px;
          border: 1px solid var(--button-border-color);
          border-radius: 4px;
          background-color: var(--button-background-color);
          color: var(--button-color);
          cursor: pointer;
          font-size: 12px;
          font-family: var(--ui-font);
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .sb-block-action-btn:hover {
          background-color: var(--button-hover-background-color);
          border-color: var(--ui-accent-color);
        }

        .sb-block-action-btn.sb-primary {
          background-color: var(--primary-button-background-color);
          color: var(--primary-button-color);
          border-color: var(--primary-button-border-color);
        }

        .sb-block-action-btn.sb-primary:hover {
          background-color: var(--primary-button-hover-background-color);
        }

        .sb-icon {
          font-size: 14px;
        }

        /* Icon styles using CSS mask for SVG icons */
        .sb-close-icon,
        .sb-pin-icon,
        .sb-edit-icon,
        .sb-view-icon,
        .sb-location-icon,
        .sb-drag-icon,
        .sb-minimize-icon,
        .sb-maximize-icon {
          display: inline-block;
          width: 14px;
          height: 14px;
          background-color: currentColor;
          -webkit-mask-size: contain;
          mask-size: contain;
        }

        .sb-close-icon {
          -webkit-mask: var(--close-icon) no-repeat center;
          mask: var(--close-icon) no-repeat center;
        }

        .sb-pin-icon {
          -webkit-mask: var(--pin-icon) no-repeat center;
          mask: var(--pin-icon) no-repeat center;
        }

        .sb-edit-icon {
          -webkit-mask: var(--edit-icon) no-repeat center;
          mask: var(--edit-icon) no-repeat center;
        }

        .sb-view-icon {
          -webkit-mask: var(--view-icon) no-repeat center;
          mask: var(--view-icon) no-repeat center;
        }

        .sb-location-icon {
          -webkit-mask: var(--location-icon) no-repeat center;
          mask: var(--location-icon) no-repeat center;
        }

        .sb-drag-icon {
          -webkit-mask: var(--drag-icon) no-repeat center;
          mask: var(--drag-icon) no-repeat center;
        }

        .sb-minimize-icon {
          -webkit-mask: var(--minimize-icon) no-repeat center;
          mask: var(--minimize-icon) no-repeat center;
        }

        .sb-maximize-icon {
          -webkit-mask: var(--maximize-icon) no-repeat center;
          mask: var(--maximize-icon) no-repeat center;
        }

        /* Block type specific styling */
        .sb-block-code {
          font-family: var(--editor-font);
          background-color: var(--editor-code-background-color);
          padding: 12px;
          border-radius: 4px;
          border: 1px solid var(--modal-border-color);
        }

        .sb-block-code pre {
          margin: 0;
          padding: 0;
          white-space: pre-wrap;
          word-wrap: break-word;
        }

        .sb-block-quote {
          border-left: 3px solid var(--ui-accent-color);
          padding-left: 12px;
          margin-left: 0;
          color: var(--meta-subtle-color);
          font-style: italic;
        }

        .sb-block-heading h1,
        .sb-block-heading h2,
        .sb-block-heading h3,
        .sb-block-heading h4,
        .sb-block-heading h5,
        .sb-block-heading h6 {
          margin-top: 0;
          color: var(--editor-heading-color);
        }

        .sb-block-separator {
          height: 1px;
          background-color: var(--editor-border-color);
          margin: 8px 0;
        }
      </style>
      <div class="sb-block-focus-sidebar-container">
        <div class="sb-block-focus-sidebar-overlay" onclick="closeSidebar()"></div>
        <div class="sb-block-focus-sidebar-wrapper">
          <div class="sb-block-focus-sidebar">
            <div class="sb-sidebar-header">
              <h3>Focus Sections (${this.sidebarViews.size} block${this.sidebarViews.size === 1 ? '' : 's'})</h3>
              <button class="sb-block-action-btn" onclick="closeSidebar()">
                <span class="sb-close-icon"></span> Close All
              </button>
            </div>
            ${blocksHTML}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Generates HTML for a single block in the sidebar
   */
  private async generateSingleBlockHTML(view: SidebarBlockView, index: number, isLast: boolean): Promise<string> {
    const { id, blockBounds, sourcePage, isEditing } = view;
    
    // Build breadcrumb HTML with clickable segments
    const breadcrumbParts: string[] = [];
    
    // Add page name as first breadcrumb
    breadcrumbParts.push(`<span class="sb-breadcrumb-item" onclick="navigateToPage('${sourcePage}')">${sourcePage}</span>`);
    
    // Add heading hierarchy if available
    if (blockBounds.headingHierarchy && blockBounds.headingHierarchy.length > 0) {
      // Limit to 4 levels, show ellipsis if more
      const hierarchy = blockBounds.headingHierarchy;
      const showEllipsis = hierarchy.length > 4;
      const displayHierarchy = showEllipsis ? [
        ...hierarchy.slice(0, 2),
        { text: '...', level: 0, pos: -1 },
        ...hierarchy.slice(-2)
      ] : hierarchy;
      
      for (const heading of displayHierarchy) {
        if (heading.pos === -1) {
          // Ellipsis
          breadcrumbParts.push(`<span class="sb-breadcrumb-ellipsis">${heading.text}</span>`);
        } else {
          breadcrumbParts.push(`<span class="sb-breadcrumb-item" onclick="navigateToHeading('${sourcePage}', ${heading.pos})">${heading.text}</span>`);
        }
      }
    }
    
    // Add current block title (make it clickable but keep sidebar open)
    breadcrumbParts.push(`<span class="sb-breadcrumb-item sb-current" onclick="navigateToSourceKeepOpen('${id}')" title="Jump to source">${blockBounds.title || `${blockBounds.type} block`}</span>`);
    
    const breadcrumbHtml = breadcrumbParts.join('<span class="sb-breadcrumb-separator">›</span>');

    const contentHtml = isEditing ? this.generateEditorHTML(view) : await this.generateContentHTML(view);

    return `
      <div class="sb-block-item ${view.id === this.activeBlockId ? 'sb-active' : ''}" data-block-id="${id}" data-index="${index}"
           ondragover="handleDragOver(event)"
           ondragleave="handleDragLeave(event)"
           ondrop="handleDrop(event, ${index})">
        <div class="sb-block-breadcrumb">
          <div class="sb-drag-handle" draggable="true"
               ondragstart="handleDragStart(event, ${index})"
               ondragend="handleDragEnd(event)">
            <span class="sb-drag-icon"></span>
          </div>
          <div class="sb-breadcrumb-wrapper">
            ${breadcrumbHtml}
          </div>
          <button class="sb-block-minimize-btn" onclick="toggleMinimize('${id}')" title="${view.isMinimized ? 'Maximize block' : 'Minimize block'}">
            <span class="${view.isMinimized ? 'sb-maximize-icon' : 'sb-minimize-icon'}"></span>
          </button>
          <button class="sb-block-close-btn" onclick="closeBlock('${id}')">
            <span class="sb-close-icon"></span>
          </button>
        </div>

        ${!view.isMinimized ? `
        <div class="sb-block-content sb-block-${blockBounds.type} ${isEditing ? 'sb-editing' : ''}" onclick="setActiveBlock('${id}')">
          ${contentHtml}
        </div>

        <div class="sb-block-actions">
          <div class="sb-block-actions-left">
            <button class="sb-block-action-btn" onclick="pinCurrentBlock('${id}')">
              <span class="sb-pin-icon"></span> Pin
            </button>
            <button class="sb-block-action-btn ${isEditing ? 'sb-primary' : ''}" onclick="toggleEditMode('${id}')">
              <span class="${isEditing ? 'sb-view-icon' : 'sb-edit-icon'}"></span>
              ${isEditing ? 'View' : 'Edit'}
            </button>
          </div>
        </div>
        ` : ''}
        ${!isLast ? '<div class="sb-block-separator"></div>' : ''}
      </div>
    `;
  }

  /**
   * Generates the HTML for viewing mode
   */
  private async generateContentHTML(view: SidebarBlockView): Promise<string> {
    const content = view.blockBounds.content;

    // Handle code blocks with special formatting
    if (view.blockBounds.type === 'code') {
      return `<pre><code>${content}</code></pre>`;
    }

    try {
      // Use SilverBullet's markdown rendering system for proper formatting
      const html = await markdown.markdownToHtml(content);
      return html;
    } catch (error) {
      console.error("Error rendering markdown:", error);
      // Fall back to plain text if markdown rendering fails
      return `<div>${content.replace(/\n/g, '<br>')}</div>`;
    }
  }

  /**
   * Generates the HTML for editing mode
   */
  private generateEditorHTML(view: SidebarBlockView): string {
    const content = view.blockBounds.content;

    return `
      <div class="sb-block-editor">
        <textarea
          id="block-editor-textarea-${view.id}"
          data-block-id="${view.id}"
          class="sb-block-editor-textarea"
        >${content}</textarea>
      </div>
    `;
  }

  /**
   * Generates the JavaScript for sidebar interactions
   */
  private generateSidebarScript(): string {
    return `
      console.log("DEBUG: Script loaded, checking environment");
      console.log("DEBUG: window.parent exists:", !!window.parent);
      console.log("DEBUG: api function exists:", typeof api);
      console.log("DEBUG: globalThis:", typeof globalThis);

      window.closeSidebar = function() {
        console.log("DEBUG: closeSidebar called");
        console.log("DEBUG: api function exists:", typeof api);
        const message = { type: "block-focus", action: "close-all" };
        console.log("DEBUG: Sending message:", message);
        api(message);
        console.log("DEBUG: api() call completed");
      };

      window.closeBlock = function(blockId) {
        console.log("DEBUG: closeBlock called with:", blockId);
        api({ type: "block-focus", action: "close", blockId: blockId });
      };

      window.pinCurrentBlock = function(blockId) {
        console.log("DEBUG: pinCurrentBlock called with:", blockId);
        const title = prompt("Pin block as:", "");
        if (title !== null) {
          console.log("DEBUG: pinCurrentBlock sending API call with title:", title);
          api({ type: "block-focus", action: "pin", blockId: blockId, title: title });
        }
      };

      window.toggleEditMode = function(blockId) {
        console.log("DEBUG: toggleEditMode called with:", blockId);
        api({ type: "block-focus", action: "toggle-edit", blockId: blockId });
      };

      window.navigateToSource = function(blockId) {
        console.log("DEBUG: navigateToSource called with:", blockId);
        api({ type: "block-focus", action: "navigate-to-source", blockId: blockId });
      };

      window.toggleMinimize = function(blockId) {
        console.log("DEBUG: toggleMinimize called with:", blockId);
        api({ type: "block-focus", action: "toggle-minimize", blockId: blockId });
      };

      window.navigateToSourceKeepOpen = function(blockId) {
        console.log("DEBUG: navigateToSourceKeepOpen called with:", blockId);
        api({ type: "block-focus", action: "navigate-to-source-keep-open", blockId: blockId });
      };

      window.navigateToPage = function(pageName) {
        console.log("DEBUG: navigateToPage called with:", pageName);
        api({ type: "block-focus", action: "navigate-to-page", pageName: pageName });
      };

      window.navigateToHeading = function(pageName, position) {
        console.log("DEBUG: navigateToHeading called with:", pageName, position);
        api({ type: "block-focus", action: "navigate-to-heading", pageName: pageName, position: position });
      };

      window.setActiveBlock = function(blockId) {
        console.log("DEBUG: setActiveBlock called with:", blockId);
        // Update visual active state
        document.querySelectorAll('.sb-block-item').forEach(item => {
          item.classList.remove('sb-active');
        });
        const targetBlock = document.querySelector('[data-block-id="' + blockId + '"]');
        if (targetBlock) {
          targetBlock.classList.add('sb-active');
        }
        api({ type: "block-focus", action: "set-active", blockId: blockId });
      };

      // Auto-save functionality for edit mode - handle multiple textareas
      const textareas = document.querySelectorAll('[id^="block-editor-textarea-"]');
      textareas.forEach(textarea => {
        let saveTimeout;
        textarea.addEventListener('input', () => {
          clearTimeout(saveTimeout);
          const blockId = textarea.getAttribute('data-block-id');
          saveTimeout = setTimeout(() => {
            api({
              type: "block-focus",
              action: "save-content",
              blockId: blockId,
              content: textarea.value
            });
          }, 500);
        });
      });

      // Handle ESC key to close sidebar
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeSidebar();
        }
      });

      // Drag and drop functionality using global functions
      let draggedIndex = -1;
      let scriptLoadTime = Date.now();
      let dragOverThrottle = false;
      let lastDragOverTarget: Element | null = null;

      window.handleDragStart = function(event, index) {
        draggedIndex = index;
        const blockItem = event.target.closest('.sb-block-item');
        
        if (blockItem) {
          blockItem.classList.add('sb-dragging');
        }
        
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', 'block-drag-' + index);
          event.dataTransfer.setData('text/html', blockItem ? blockItem.outerHTML : '');
        }
      };

      window.handleDragEnd = function(event) {
        const timeSinceLoad = Date.now() - scriptLoadTime;
        
        // Ignore dragEnd events that happen immediately after script load
        if (timeSinceLoad < 100) {
          return;
        }
        
        const blockItem = event.target.closest('.sb-block-item');
        if (blockItem) {
          blockItem.classList.remove('sb-dragging');
        }
        document.querySelectorAll('.sb-block-item').forEach(el => {
          el.classList.remove('sb-drag-over');
        });
        
        // Reset drag state
        draggedIndex = -1;
        lastDragOverTarget = null;
        dragOverThrottle = false;
      };

      window.handleDragOver = function(event) {
        event.preventDefault();
        
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'move';
        }
        
        // Throttle dragOver events to improve performance
        if (dragOverThrottle) {
          return;
        }
        
        dragOverThrottle = true;
        setTimeout(() => {
          dragOverThrottle = false;
        }, 16); // ~60fps throttling
        
        const targetItem = event.currentTarget;
        const targetIndex = parseInt(targetItem.getAttribute('data-index'));
        
        // Only update visual feedback if target changed
        if (targetItem !== lastDragOverTarget) {
          // Remove drag-over class from previous target
          if (lastDragOverTarget) {
            lastDragOverTarget.classList.remove('sb-drag-over');
          }
          
          // Add drag-over class to current target
          if (targetIndex !== draggedIndex && draggedIndex !== -1) {
            targetItem.classList.add('sb-drag-over');
          }
          
          lastDragOverTarget = targetItem;
        }
      };

      window.handleDragLeave = function(event) {
        // Only remove drag-over if we're actually leaving the element boundary
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX;
        const y = event.clientY;
        
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
          event.currentTarget.classList.remove('sb-drag-over');
          if (lastDragOverTarget === event.currentTarget) {
            lastDragOverTarget = null;
          }
        }
      };

      window.handleDrop = function(event, targetIndex) {
        event.preventDefault();
        const targetItem = event.currentTarget;

        if (draggedIndex !== targetIndex && draggedIndex !== -1) {
          api({
            type: 'block-focus',
            action: 'reorder',
            fromIndex: draggedIndex,
            toIndex: targetIndex
          });
        }

        targetItem.classList.remove('sb-drag-over');
        draggedIndex = -1;
        lastDragOverTarget = null;
      };
    `;
  }

  /**
   * Detects a suitable title for a block
   */
  private detectTitle(block: BlockBounds): string {
    if (block.title) return block.title;

    switch (block.type) {
      case "heading":
        return block.content.split('\n')[0].replace(/^#+\s*/, '').trim();
      case "list":
        return block.content.split('\n')[0].replace(/^\s*[-*]\s*/, '').slice(0, 50).trim();
      case "code": {
        const firstLine = block.content.split('\n')[0];
        const lang = firstLine.replace(/^```/, '').trim();
        return lang ? `${lang} Code` : "Code Block";
      }
      case "quote":
        return block.content.split('\n')[0].replace(/^\s*>\s*/, '').slice(0, 50).trim();
      default:
        return block.content.split('\n')[0].slice(0, 50).trim() || "Block";
    }
  }

  /**
   * Finds a block in current content based on similarity
   */
  private async findBlockInContent(
    pinned: PinnedBlock,
    currentContent: string
  ): Promise<BlockBounds | null> {
    // Simple similarity search - in practice, this could be more sophisticated
    const lines = currentContent.split('\n');
    const preview = pinned.preview.trim();

    // Look for lines containing the preview text
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(preview.slice(0, 30))) {
        // Found a potential match, try to reconstruct the block
        try {
          const { detectBlockAtCursor } = await import("./block_focus.ts");

          // Calculate approximate position
          let pos = 0;
          for (let j = 0; j < i; j++) {
            pos += lines[j].length + 1;
          }

          return await detectBlockAtCursor(pos);
        } catch {
          // Fallback to original bounds if detection fails
          return pinned.blockBounds;
        }
      }
    }

    return null;
  }

  /**
   * Persists pinned blocks to client storage
   */
  private async persistPinnedBlocks(): Promise<void> {
    const blocks = Array.from(this.pinnedBlocks.values());
    await clientStore.set("block-focus:pinnedBlocks", blocks);
  }

  /**
   * Loads state from client storage
   */
  private async loadState(): Promise<void> {
    try {
      const blocks = await clientStore.get("block-focus:pinnedBlocks") || [];
      this.pinnedBlocks.clear();

      for (const block of blocks) {
        // Clean up expired blocks (older than 7 days)
        const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
        if (Date.now() - block.pinnedAt < maxAge) {
          this.pinnedBlocks.set(block.id, block);
        }
      }

      // Persist cleaned up blocks
      if (blocks.length !== this.pinnedBlocks.size) {
        await this.persistPinnedBlocks();
      }
    } catch (error) {
      console.error("Failed to load block focus state:", error);
    }
  }

  /**
   * Clears all pinned blocks
   */
  async clearAllPinnedBlocks(): Promise<void> {
    this.pinnedBlocks.clear();
    await this.persistPinnedBlocks();
    await editor.flashNotification("All pinned blocks cleared", "info");
  }

  /**
   * Gets the active sidebar view
   */
  getCurrentSidebar(): SidebarBlockView | undefined {
    return this.activeBlockId ? this.sidebarViews.get(this.activeBlockId) : undefined;
  }

  /**
   * Gets all sidebar views
   */
  getAllSidebarViews(): SidebarBlockView[] {
    return Array.from(this.sidebarViews.values());
  }

  /**
   * Sets the active block
   */
  setActiveBlock(blockId: string): void {
    if (this.sidebarViews.has(blockId)) {
      this.activeBlockId = blockId;
    }
  }

  /**
   * Finds existing block with same content and page
   */
  private findExistingBlock(block: BlockBounds, page: string): string | undefined {
    for (const [id, view] of this.sidebarViews) {
      if (view.sourcePage === page &&
          view.blockBounds.from === block.from &&
          view.blockBounds.to === block.to) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * Reorders sidebar blocks based on drag & drop
   */
  reorderSidebarBlocks(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= this.sidebarOrder.length || toIndex >= this.sidebarOrder.length) {
      return;
    }

    const [moved] = this.sidebarOrder.splice(fromIndex, 1);
    this.sidebarOrder.splice(toIndex, 0, moved);

    // Re-render to reflect the new order
    this.renderSidebar().catch(console.error);
  }
}