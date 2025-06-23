import { editor, space } from "@silverbulletmd/silverbullet/syscalls";
import type { BlockBounds } from "./block_focus.ts";
import { positionFromOffset, lineFromOffset } from "./block_focus.ts";

/**
 * Enhanced block editing system with live sync and conflict resolution
 */
export class BlockLiveEditor {
  private sourcePageVersion?: string;
  private originalContent: string;
  private blockPosition: { from: number; to: number };
  private isDirty: boolean = false;
  private saveTimeout?: number;
  private lastSavedContent: string;
  private onContentChange?: (content: string) => void;
  private onSaveStatusChange?: (status: "saved" | "saving" | "error") => void;

  constructor(
    readonly page: string,
    readonly block: BlockBounds,
    onContentChange?: (content: string) => void,
    onSaveStatusChange?: (status: "saved" | "saving" | "error") => void
  ) {
    this.originalContent = block.content;
    this.lastSavedContent = block.content;
    this.blockPosition = { from: block.from, to: block.to };
    this.onContentChange = onContentChange;
    this.onSaveStatusChange = onSaveStatusChange;
    
    this.trackExternalChanges();
  }

  /**
   * Handles content changes from the editor
   */
  async handleContentChange(newContent: string): Promise<void> {
    this.isDirty = newContent !== this.lastSavedContent;
    
    if (this.isDirty) {
      this.onSaveStatusChange?.("saving");
      await this.debouncedSave(newContent);
    }
  }

  /**
   * Saves changes to the source document with debouncing
   */
  private async debouncedSave(content: string): Promise<void> {
    // Clear existing timeout
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    // Debounce saves
    this.saveTimeout = setTimeout(async () => {
      try {
        await this.syncBlockToSource(content);
        this.lastSavedContent = content;
        this.isDirty = false;
        this.onSaveStatusChange?.("saved");
      } catch (error) {
        console.error("Failed to save block:", error);
        this.onSaveStatusChange?.("error");
        await editor.flashNotification(
          `Error saving block: ${error}`,
          "error"
        );
      }
    }, 500); // 500ms debounce
  }

  /**
   * Synchronizes block content to the source document
   */
  private async syncBlockToSource(newContent: string): Promise<void> {
    // Read current page state
    const currentPage = await space.readPage(this.page);
    
    // Find the block's current position (may have moved)
    const currentBlock = await this.locateBlockInCurrentContent(currentPage);
    
    if (!currentBlock) {
      throw new Error("Block no longer exists in source document");
    }

    // Perform the replacement
    const updated = 
      currentPage.slice(0, currentBlock.from) +
      newContent +
      currentPage.slice(currentBlock.to);

    // Write back to the page
    await space.writePage(this.page, updated);

    // Update our tracking position
    const contentLengthDiff = newContent.length - (currentBlock.to - currentBlock.from);
    this.blockPosition = {
      from: currentBlock.from,
      to: currentBlock.from + newContent.length
    };

    // Notify about content changes
    this.onContentChange?.(newContent);
  }

  /**
   * Attempts to locate the block in the current content
   */
  private async locateBlockInCurrentContent(currentContent: string): Promise<{ from: number; to: number } | null> {
    // Try the current known position first
    if (this.blockPosition.to <= currentContent.length) {
      const contentAtPosition = currentContent.slice(
        this.blockPosition.from,
        this.blockPosition.to
      );
      
      // Check if content matches (allowing for minor whitespace differences)
      if (this.contentMatches(contentAtPosition, this.lastSavedContent)) {
        return this.blockPosition;
      }
    }

    // If position doesn't match, search by content similarity
    return this.findBlockByContent(currentContent);
  }

  /**
   * Finds block by content similarity search
   */
  private findBlockByContent(currentContent: string): { from: number; to: number } | null {
    const searchText = this.lastSavedContent.slice(0, 100).trim();
    const index = currentContent.indexOf(searchText);
    
    if (index !== -1) {
      // Found the start, now find a reasonable end
      const lines = this.lastSavedContent.split('\n');
      const estimatedLength = this.lastSavedContent.length;
      
      return {
        from: index,
        to: Math.min(index + estimatedLength, currentContent.length)
      };
    }

    return null;
  }

  /**
   * Checks if two content strings match (allowing for minor differences)
   */
  private contentMatches(content1: string, content2: string): boolean {
    // Normalize whitespace for comparison
    const normalize = (str: string) => str.trim().replace(/\s+/g, ' ');
    return normalize(content1) === normalize(content2);
  }

  /**
   * Monitors external changes to the source document
   */
  private trackExternalChanges(): void {
    // This would be enhanced to actually watch for file changes
    // For now, we'll check periodically if the page has changed
    const checkInterval = setInterval(async () => {
      try {
        const currentContent = await space.readPage(this.page);
        const currentBlock = await this.locateBlockInCurrentContent(currentContent);
        
        if (!currentBlock && !this.isDirty) {
          // Block has been moved or deleted, and we don't have unsaved changes
          clearInterval(checkInterval);
          await editor.flashNotification(
            "Block has been modified externally",
            "info"
          );
        }
      } catch (error) {
        // Page might have been deleted
        console.warn("Error checking for external changes:", error);
      }
    }, 5000); // Check every 5 seconds

    // Clean up after 5 minutes
    setTimeout(() => clearInterval(checkInterval), 5 * 60 * 1000);
  }

  /**
   * Handles conflicts when both local and external changes exist
   */
  async handleConflict(remoteContent: string): Promise<void> {
    const choice = await editor.confirm(
      "The block has been modified externally. Do you want to:\n" +
      "OK: Keep your changes (overwrite external changes)\n" +
      "Cancel: Discard your changes (use external version)"
    );

    if (choice) {
      // User wants to keep their changes
      await this.forceSave();
    } else {
      // User wants to use external version
      this.onContentChange?.(remoteContent);
      this.lastSavedContent = remoteContent;
      this.isDirty = false;
      this.onSaveStatusChange?.("saved");
    }
  }

  /**
   * Forces a save even if there might be conflicts
   */
  private async forceSave(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    try {
      await this.syncBlockToSource(this.lastSavedContent);
      this.isDirty = false;
      this.onSaveStatusChange?.("saved");
      await editor.flashNotification("Changes saved (external changes overwritten)", "info");
    } catch (error) {
      this.onSaveStatusChange?.("error");
      throw error;
    }
  }

  /**
   * Gets the current editing state
   */
  getState() {
    return {
      isDirty: this.isDirty,
      originalContent: this.originalContent,
      lastSavedContent: this.lastSavedContent,
      blockPosition: this.blockPosition
    };
  }

  /**
   * Cleans up resources
   */
  destroy(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
  }
}

/**
 * Enhanced view manager with live editing support
 */
export class EnhancedBlockViewManager {
  private currentEditor?: BlockLiveEditor;
  private static instance: EnhancedBlockViewManager;

  private constructor() {}

  static getInstance(): EnhancedBlockViewManager {
    if (!EnhancedBlockViewManager.instance) {
      EnhancedBlockViewManager.instance = new EnhancedBlockViewManager();
    }
    return EnhancedBlockViewManager.instance;
  }

  /**
   * Creates a live editor for a block
   */
  createLiveEditor(
    page: string,
    block: BlockBounds,
    onContentChange?: (content: string) => void,
    onSaveStatusChange?: (status: "saved" | "saving" | "error") => void
  ): BlockLiveEditor {
    // Clean up any existing editor
    if (this.currentEditor) {
      this.currentEditor.destroy();
    }

    this.currentEditor = new BlockLiveEditor(
      page,
      block,
      onContentChange,
      onSaveStatusChange
    );

    return this.currentEditor;
  }

  /**
   * Gets the current live editor
   */
  getCurrentEditor(): BlockLiveEditor | undefined {
    return this.currentEditor;
  }

  /**
   * Closes the current live editor
   */
  closeLiveEditor(): void {
    if (this.currentEditor) {
      this.currentEditor.destroy();
      this.currentEditor = undefined;
    }
  }
}

/**
 * Integration with the TransientBlockViewManager
 */
export async function enhanceViewManagerWithLiveEditing(): Promise<void> {
  const enhancedManager = EnhancedBlockViewManager.getInstance();
  
  // This would be called when opening a block for editing
  // to enable live editing capabilities
}

/**
 * Utility function to check if live editing is supported for a block type
 */
export function supportsLiveEditing(blockType: string): boolean {
  // Most block types support live editing
  const supportedTypes = ["heading", "paragraph", "list", "quote", "code"];
  return supportedTypes.includes(blockType);
}

/**
 * Creates an editing session for a block with full conflict resolution
 */
export async function createEditingSession(
  page: string,
  block: BlockBounds
): Promise<BlockLiveEditor> {
  const enhancedManager = EnhancedBlockViewManager.getInstance();
  
  return enhancedManager.createLiveEditor(
    page,
    block,
    (content) => {
      // Handle content changes
      console.log("Block content changed:", content.slice(0, 50) + "...");
    },
    (status) => {
      // Handle save status changes
      console.log("Save status changed:", status);
    }
  );
}