import { clientStore, editor } from "@silverbulletmd/silverbullet/syscalls";
import type { BlockReference } from "./block_focus.ts";
import { detectBlockAtCursor } from "./block_focus.ts";
import { TransientBlockViewManager } from "./block_view_manager.ts";

export class BlockNavigationHistory {
  private history: BlockReference[] = [];
  private currentIndex: number = -1;
  private static instance: BlockNavigationHistory;
  private maxHistorySize = 50;

  private constructor() {
    this.loadHistory();
  }

  static getInstance(): BlockNavigationHistory {
    if (!BlockNavigationHistory.instance) {
      BlockNavigationHistory.instance = new BlockNavigationHistory();
    }
    return BlockNavigationHistory.instance;
  }

  /**
   * Adds a new block reference to the navigation history
   */
  async push(blockRef: BlockReference): Promise<void> {
    // Remove forward history on new navigation
    this.history = this.history.slice(0, this.currentIndex + 1);
    this.history.push(blockRef);
    this.currentIndex++;

    // Limit history size
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
      this.currentIndex--;
    }

    await this.persistHistory();
  }

  /**
   * Navigates to the previous block in history
   */
  async back(): Promise<BlockReference | null> {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      const blockRef = this.history[this.currentIndex];
      await this.navigateToBlock(blockRef);
      return blockRef;
    }
    return null;
  }

  /**
   * Navigates to the next block in history
   */
  async forward(): Promise<BlockReference | null> {
    if (this.currentIndex < this.history.length - 1) {
      this.currentIndex++;
      const blockRef = this.history[this.currentIndex];
      await this.navigateToBlock(blockRef);
      return blockRef;
    }
    return null;
  }

  /**
   * Records the current block position in history
   */
  async recordCurrentPosition(): Promise<void> {
    try {
      const currentPage = await editor.getCurrentPage();
      const currentBlock = await detectBlockAtCursor();
      
      const blockRef: BlockReference = {
        page: currentPage,
        blockBounds: currentBlock,
        timestamp: Date.now()
      };

      await this.push(blockRef);
    } catch (error) {
      console.error("Failed to record current position:", error);
    }
  }

  /**
   * Navigates to a specific block reference
   */
  private async navigateToBlock(blockRef: BlockReference): Promise<void> {
    try {
      // Navigate to the page first
      await editor.navigate({ kind: "page", page: blockRef.page });
      
      // Wait a bit for the page to load
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Try to find the block in the current content
      const currentText = await editor.getText();
      const updatedBlock = await this.findBlockInCurrentContent(
        blockRef.blockBounds,
        currentText
      );
      
      if (updatedBlock) {
        // Move cursor to the block
        await editor.moveCursor(updatedBlock.from);
        
        // Open the block in sidebar view
        const viewManager = await TransientBlockViewManager.getInstance();
        await viewManager.openBlockSidebar(updatedBlock, blockRef.page);
      } else {
        await editor.flashNotification(
          `Block "${blockRef.blockBounds.title}" may have been modified`,
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
   * Attempts to find a block in the current content
   */
  private async findBlockInCurrentContent(
    originalBlock: any,
    currentContent: string
  ): Promise<any | null> {
    try {
      const { detectBlockAtCursor } = await import("./block_focus.ts");
      
      // Try the original position first
      if (originalBlock.from < currentContent.length) {
        const blockAtOriginalPos = await detectBlockAtCursor(originalBlock.from);
        
        if (this.blocksAreSimilar(originalBlock, blockAtOriginalPos)) {
          return blockAtOriginalPos;
        }
      }
      
      // If original position doesn't work, search by content similarity
      return this.findByContentSimilarity(originalBlock, currentContent);
    } catch (error) {
      console.error("Error finding block in current content:", error);
      return null;
    }
  }

  /**
   * Finds a block by content similarity
   */
  private async findByContentSimilarity(
    originalBlock: any,
    currentContent: string
  ): Promise<any | null> {
    const originalPreview = originalBlock.content.slice(0, 100).trim();
    const lines = currentContent.split('\n');
    
    // Search through the content for similar text
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(originalPreview.slice(0, 30))) {
        try {
          // Calculate position
          let pos = 0;
          for (let j = 0; j < i; j++) {
            pos += lines[j].length + 1;
          }
          
          const { detectBlockAtCursor } = require("./block_focus.ts");
          return await detectBlockAtCursor(pos);
        } catch {
          continue;
        }
      }
    }
    
    return null;
  }

  /**
   * Checks if two blocks are similar
   */
  private blocksAreSimilar(block1: any, block2: any): boolean {
    if (block1.type !== block2.type) return false;
    
    const preview1 = block1.content.slice(0, 50).trim();
    const preview2 = block2.content.slice(0, 50).trim();
    
    // Simple similarity check - could be made more sophisticated
    return preview1 === preview2 || 
           preview1.includes(preview2) || 
           preview2.includes(preview1);
  }

  /**
   * Gets the current history for debugging
   */
  getHistory(): BlockReference[] {
    return [...this.history];
  }

  /**
   * Gets the current position in history
   */
  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /**
   * Checks if back navigation is possible
   */
  canGoBack(): boolean {
    return this.currentIndex > 0;
  }

  /**
   * Checks if forward navigation is possible
   */
  canGoForward(): boolean {
    return this.currentIndex < this.history.length - 1;
  }

  /**
   * Clears the navigation history
   */
  async clearHistory(): Promise<void> {
    this.history = [];
    this.currentIndex = -1;
    await this.persistHistory();
    await editor.flashNotification("Navigation history cleared", "info");
  }

  /**
   * Persists the navigation history to client storage
   */
  private async persistHistory(): Promise<void> {
    try {
      await clientStore.set("block-focus:navigationHistory", {
        history: this.history,
        currentIndex: this.currentIndex
      });
    } catch (error) {
      console.error("Failed to persist navigation history:", error);
    }
  }

  /**
   * Loads the navigation history from client storage
   */
  private async loadHistory(): Promise<void> {
    try {
      const saved = await clientStore.get("block-focus:navigationHistory");
      if (saved) {
        this.history = saved.history || [];
        this.currentIndex = saved.currentIndex ?? -1;
        
        // Clean up old entries (older than 30 days)
        const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
        const now = Date.now();
        
        this.history = this.history.filter(ref => 
          now - ref.timestamp < maxAge
        );
        
        // Adjust current index if needed
        if (this.currentIndex >= this.history.length) {
          this.currentIndex = this.history.length - 1;
        }
        
        // Persist cleaned up history
        await this.persistHistory();
      }
    } catch (error) {
      console.error("Failed to load navigation history:", error);
      this.history = [];
      this.currentIndex = -1;
    }
  }
}

/**
 * Convenience functions for command integration
 */
export async function navigateBack(): Promise<void> {
  const history = BlockNavigationHistory.getInstance();
  const result = await history.back();
  
  if (!result) {
    await editor.flashNotification("No previous block in history", "info");
  }
}

export async function navigateForward(): Promise<void> {
  const history = BlockNavigationHistory.getInstance();
  const result = await history.forward();
  
  if (!result) {
    await editor.flashNotification("No next block in history", "info");
  }
}

export async function recordCurrentBlock(): Promise<void> {
  const history = BlockNavigationHistory.getInstance();
  await history.recordCurrentPosition();
}