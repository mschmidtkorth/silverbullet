import { editor } from "@silverbulletmd/silverbullet/syscalls";
import { detectBlockAtCursor } from "./block_focus.ts";
import { TransientBlockViewManager } from "./block_view_manager.ts";
import { 
  BlockNavigationHistory, 
  navigateBack, 
  navigateForward, 
  recordCurrentBlock 
} from "./block_navigation.ts";

/**
 * Event handler for block-focus messages from iframe widgets
 * This is called automatically by the SilverBullet event system
 */
export async function handleBlockFocusEvent(data: any): Promise<void> {
  console.log("DEBUG: Block-focus event received:", data);
  if (data?.type === "block-focus") {
    const { action, title, content, blockId } = data;
    console.log("DEBUG: Processing block-focus message:", { action, title, content, blockId });
    const viewManager = await TransientBlockViewManager.getInstance();
    
    switch (action) {
      case "close":
        viewManager.closeSidebar(blockId);
        if (viewManager.getAllSidebarViews().length === 0) {
          await editor.hidePanel("rhs");
        }
        break;
        
      case "close-all":
        viewManager.closeSidebar();
        await editor.hidePanel("rhs");
        break;
        
      case "pin": {
        const currentSidebar = blockId 
          ? viewManager.getAllSidebarViews().find(v => v.id === blockId)
          : viewManager.getCurrentSidebar();
        if (currentSidebar) {
          await viewManager.pinBlock(
            currentSidebar.blockBounds, 
            currentSidebar.sourcePage, 
            title
          );
        }
        break;
      }
        
      case "toggle-edit":
        await viewManager.toggleEditMode(blockId);
        break;
        
      case "navigate-to-source": {
        const sidebar = blockId 
          ? viewManager.getAllSidebarViews().find(v => v.id === blockId)
          : viewManager.getCurrentSidebar();
        if (sidebar) {
          viewManager.closeSidebar();
          await editor.navigate({ kind: "page", page: sidebar.sourcePage });
          await editor.moveCursor(sidebar.blockBounds.from, true);
        }
        break;
      }
      
      case "navigate-to-source-keep-open": {
        const sidebar = blockId 
          ? viewManager.getAllSidebarViews().find(v => v.id === blockId)
          : viewManager.getCurrentSidebar();
        if (sidebar) {
          // Don't close sidebar, just navigate
          await editor.navigate({ kind: "page", page: sidebar.sourcePage });
          await editor.moveCursor(sidebar.blockBounds.from, true);
        }
        break;
      }
      
      case "navigate-to-page": {
        const { pageName } = data;
        viewManager.closeSidebar();
        await editor.navigate({ kind: "page", page: pageName });
        // Scroll to top of page
        await editor.moveCursor(0, true);
        break;
      }
      
      case "navigate-to-heading": {
        const { pageName, position } = data;
        await editor.navigate({ kind: "page", page: pageName });
        await editor.moveCursor(position, true);
        break;
      }
        
      case "set-active":
        if (blockId) {
          viewManager.setActiveBlock(blockId);
        }
        break;
        
      case "save-content":
        await viewManager.handleBlockEdit(content, blockId);
        break;
        
      case "reorder": {
        const { fromIndex, toIndex } = data;
        if (typeof fromIndex === 'number' && typeof toIndex === 'number') {
          viewManager.reorderSidebarBlocks(fromIndex, toIndex);
        }
        break;
      }
      
      case "toggle-minimize":
        if (blockId) {
          viewManager.toggleMinimize(blockId);
        }
        break;
    }
  }
}

/**
 * Command: Block Zoom In
 * Opens the current block in a modal view for focused editing
 */
export async function blockZoomIn(): Promise<void> {
  try {
    const currentPage = await editor.getCurrentPage();
    const block = await detectBlockAtCursor();
    
    // Record current position in navigation history
    await recordCurrentBlock();
    
    const viewManager = await TransientBlockViewManager.getInstance();
    await viewManager.openBlockSidebar(block, currentPage);
  } catch (error) {
    await editor.flashNotification(
      `Error opening block: ${error}`,
      "error"
    );
  }
}

/**
 * Command: Block Pin Current
 * Pins the current block for persistent access
 */
export async function blockPinCurrent(): Promise<void> {
  try {
    const currentPage = await editor.getCurrentPage();
    const block = await detectBlockAtCursor();
    
    // Prompt user for a custom title
    const title = await editor.prompt(
      "Pin block as:",
      block.title || block.content.slice(0, 50).trim()
    );
    
    if (title !== undefined) { // User didn't cancel
      const viewManager = await TransientBlockViewManager.getInstance();
      await viewManager.pinBlock(block, currentPage, title || undefined);
    }
  } catch (error) {
    await editor.flashNotification(
      `Error pinning block: ${error}`,
      "error"
    );
  }
}

/**
 * Command: Block Navigate Back
 * Navigates to the previous block in navigation history
 */
export async function blockNavigateBack(): Promise<void> {
  await navigateBack();
}

/**
 * Command: Block Navigate Forward
 * Navigates to the next block in navigation history
 */
export async function blockNavigateForward(): Promise<void> {
  await navigateForward();
}

/**
 * Command: Block Show Pinned
 * Shows a list of all pinned blocks for selection
 */
export async function blockShowPinned(): Promise<void> {
  try {
    const viewManager = await TransientBlockViewManager.getInstance();
    const pinnedBlocks = viewManager.getPinnedBlocks();
    
    if (pinnedBlocks.length === 0) {
      await editor.flashNotification("No pinned blocks found", "info");
      return;
    }
    
    // Create options for the picker
    const options = pinnedBlocks.map(block => ({
      name: `${block.title} (${block.page})`,
      value: block.id,
      description: `${block.preview} • ${formatTimestamp(block.lastAccessed)}`
    }));
    
    // Show picker dialog
    const selected = await editor.filterBox(
      "Select pinned block",
      options,
      "Select a pinned block to navigate to"
    );
    
    const selectedId = selected?.value;
    
    if (selectedId) {
      await viewManager.navigateToPinnedBlock(selectedId);
    }
  } catch (error) {
    await editor.flashNotification(
      `Error showing pinned blocks: ${error}`,
      "error"
    );
  }
}

/**
 * Command: Block Close Sidebar
 * Closes the current block focus sidebar
 */
export async function blockCloseSidebar(): Promise<void> {
  const viewManager = await TransientBlockViewManager.getInstance();
  const currentSidebar = viewManager.getCurrentSidebar();
  
  if (currentSidebar) {
    viewManager.closeSidebar();
    await editor.flashNotification("Block sidebar closed", "info");
  } else {
    await editor.flashNotification("No block sidebar open", "info");
  }
}

/**
 * Command: Block Toggle Edit Mode
 * Toggles between view and edit mode in the current sidebar
 */
export async function blockToggleEditMode(): Promise<void> {
  const viewManager = await TransientBlockViewManager.getInstance();
  const currentSidebar = viewManager.getCurrentSidebar();
  
  if (currentSidebar) {
    await viewManager.toggleEditMode();
    const mode = currentSidebar.isEditing ? "editing" : "viewing";
    await editor.flashNotification(`Switched to ${mode} mode`, "info");
  } else {
    await editor.flashNotification("No block sidebar open", "info");
  }
}

/**
 * Command: Block Clear Pinned
 * Clears all pinned blocks after confirmation
 */
export async function blockClearPinned(): Promise<void> {
  const viewManager = await TransientBlockViewManager.getInstance();
  const pinnedBlocks = viewManager.getPinnedBlocks();
  
  if (pinnedBlocks.length === 0) {
    await editor.flashNotification("No pinned blocks to clear", "info");
    return;
  }
  
  const confirmed = await editor.confirm(
    `Clear all ${pinnedBlocks.length} pinned blocks?`
  );
  
  if (confirmed) {
    await viewManager.clearAllPinnedBlocks();
  }
}

/**
 * Command: Block Clear History
 * Clears the block navigation history after confirmation
 */
export async function blockClearHistory(): Promise<void> {
  const history = BlockNavigationHistory.getInstance();
  const historyItems = history.getHistory();
  
  if (historyItems.length === 0) {
    await editor.flashNotification("No navigation history to clear", "info");
    return;
  }
  
  const confirmed = await editor.confirm(
    `Clear navigation history with ${historyItems.length} items?`
  );
  
  if (confirmed) {
    await history.clearHistory();
  }
}

/**
 * Command: Block Focus Info
 * Shows information about the current block focus state
 */
export async function blockFocusInfo(): Promise<void> {
  try {
    const viewManager = await TransientBlockViewManager.getInstance();
    const history = BlockNavigationHistory.getInstance();
    
    const pinnedCount = viewManager.getPinnedBlocks().length;
    const historyCount = history.getHistory().length;
    const currentIndex = history.getCurrentIndex();
    const canGoBack = history.canGoBack();
    const canGoForward = history.canGoForward();
    const hasSidebar = !!viewManager.getCurrentSidebar();
    
    const info = [
      `**Block Focus Status:**`,
      `• Pinned blocks: ${pinnedCount}`,
      `• Navigation history: ${historyCount} items`,
      `• Current position: ${currentIndex + 1}/${historyCount}`,
      `• Can go back: ${canGoBack ? 'Yes' : 'No'}`,
      `• Can go forward: ${canGoForward ? 'Yes' : 'No'}`,
      `• Sidebar open: ${hasSidebar ? 'Yes' : 'No'}`
    ].join('\n');
    
    await editor.flashNotification(info, "info");
  } catch (error) {
    await editor.flashNotification(
      `Error getting block focus info: ${error}`,
      "error"
    );
  }
}

/**
 * Helper function to format timestamps
 */
function formatTimestamp(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}