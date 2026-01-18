import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export interface SessionInfo {
  sessionId: string;
  timestamp: Date;
  firstMessage: string;
  messageCount: number;
  filePath: string;
  context?: string;
  namespace?: string;
  name?: string;
}

export interface SessionMetadata {
  context: string;
  namespace: string;
  updatedAt: string;
  name?: string;
}

// All session metadata in one file, keyed by sessionId
interface MetadataStore {
  [sessionId: string]: SessionMetadata;
}

const MAX_METADATA_ENTRIES = 50;

/**
 * Get the Claude projects directory for the current working directory
 */
function getProjectDir(): string {
  const cwd = process.cwd();
  // Claude uses path with dashes instead of slashes
  const projectHash = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', projectHash);
}

/**
 * Get the unified metadata file path
 */
function getMetadataStorePath(): string {
  return join(getProjectDir(), 'heimdall-sessions.json');
}

/**
 * Load the metadata store
 */
async function loadMetadataStore(): Promise<MetadataStore> {
  try {
    const content = await readFile(getMetadataStorePath(), 'utf-8');
    return JSON.parse(content) as MetadataStore;
  } catch {
    return {};
  }
}

/**
 * Save the metadata store
 */
async function saveMetadataStore(store: MetadataStore): Promise<void> {
  await writeFile(getMetadataStorePath(), JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Get list of existing session IDs (from .jsonl files)
 */
async function getExistingSessionIds(): Promise<Set<string>> {
  try {
    const files = await readdir(getProjectDir());
    const sessionIds = files
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''));
    return new Set(sessionIds);
  } catch {
    return new Set();
  }
}

/**
 * Prune metadata store - remove orphaned entries and cap at MAX_METADATA_ENTRIES
 */
async function pruneMetadataStore(store: MetadataStore): Promise<MetadataStore> {
  const existingIds = await getExistingSessionIds();
  
  // Filter to only sessions that still exist
  const entries = Object.entries(store)
    .filter(([id]) => existingIds.has(id))
    .sort((a, b) => {
      // Sort by updatedAt descending (most recent first)
      const dateA = new Date(a[1].updatedAt).getTime();
      const dateB = new Date(b[1].updatedAt).getTime();
      return dateB - dateA;
    })
    .slice(0, MAX_METADATA_ENTRIES);
  
  return Object.fromEntries(entries);
}

/**
 * Get the file path for a session
 */
export function getSessionFilePath(sessionId: string): string {
  return join(getProjectDir(), `${sessionId}.jsonl`);
}

/**
 * Read raw session file content
 */
export async function readSessionFile(sessionId: string): Promise<string | null> {
  try {
    const filePath = getSessionFilePath(sessionId);
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Save session metadata (context, namespace)
 * Automatically prunes old/orphaned entries
 */
export async function saveSessionMetadata(
  sessionId: string,
  context: string,
  namespace: string
): Promise<void> {
  try {
    let store = await loadMetadataStore();
    
    // Preserve existing name if present
    const existingName = store[sessionId]?.name;
    
    // Add/update this session's metadata
    store[sessionId] = {
      context,
      namespace,
      updatedAt: new Date().toISOString(),
      ...(existingName && { name: existingName }),
    };
    
    // Prune old entries periodically (every 10 saves or so)
    // We check by counting - if over limit, prune
    if (Object.keys(store).length > MAX_METADATA_ENTRIES) {
      store = await pruneMetadataStore(store);
    }
    
    await saveMetadataStore(store);
  } catch {
    // Silently fail - metadata is nice-to-have
  }
}

/**
 * Rename a session
 */
export async function renameSession(sessionId: string, name: string): Promise<boolean> {
  try {
    const store = await loadMetadataStore();
    
    if (!store[sessionId]) {
      // Create minimal entry if doesn't exist
      store[sessionId] = {
        context: '',
        namespace: '',
        updatedAt: new Date().toISOString(),
        name,
      };
    } else {
      store[sessionId].name = name;
      store[sessionId].updatedAt = new Date().toISOString();
    }
    
    await saveMetadataStore(store);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get session name
 */
export async function getSessionName(sessionId: string): Promise<string | null> {
  const metadata = await readSessionMetadata(sessionId);
  return metadata?.name || null;
}

/**
 * Read session metadata
 */
export async function readSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
  try {
    const store = await loadMetadataStore();
    return store[sessionId] || null;
  } catch {
    return null;
  }
}

/**
 * List all sessions for the current project
 */
export async function listSessions(limit = 10): Promise<SessionInfo[]> {
  const projectDir = getProjectDir();
  
  try {
    const files = await readdir(projectDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    
    // Get file stats and parse first message for each session
    const sessions: SessionInfo[] = [];
    
    for (const file of jsonlFiles) {
      const filePath = join(projectDir, file);
      const sessionId = file.replace('.jsonl', '');
      
      try {
        const fileStat = await stat(filePath);
        const content = await readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n');
        
        // Find first user message
        let firstMessage = '(no message)';
        let messageCount = 0;
        
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message?.content) {
              messageCount++;
              if (firstMessage === '(no message)') {
                const textContent = entry.message.content.find(
                  (c: { type: string; text?: string }) => c.type === 'text'
                );
                if (textContent?.text) {
                  firstMessage = textContent.text.slice(0, 50);
                  if (textContent.text.length > 50) firstMessage += '...';
                }
              }
            } else if (entry.type === 'assistant') {
              messageCount++;
            }
          } catch {
            // Skip malformed lines
          }
        }
        
        // Read metadata if available
        const metadata = await readSessionMetadata(sessionId);
        
        sessions.push({
          sessionId,
          timestamp: fileStat.mtime,
          firstMessage,
          messageCount,
          filePath,
          context: metadata?.context,
          namespace: metadata?.namespace,
          name: metadata?.name,
        });
      } catch {
        // Skip files we can't read
      }
    }
    
    // Sort by timestamp descending (most recent first)
    sessions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    
    return sessions.slice(0, limit);
  } catch {
    // Project directory doesn't exist yet
    return [];
  }
}

/**
 * Get the most recent session ID
 */
export async function getMostRecentSessionId(): Promise<string | null> {
  const sessions = await listSessions(1);
  return sessions.length > 0 ? sessions[0].sessionId : null;
}

/**
 * Format session list for display
 */
export function formatSessionList(sessions: SessionInfo[]): string {
  if (sessions.length === 0) {
    return 'No saved sessions found.';
  }
  
  const lines = ['📋 Recent Sessions', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'];
  
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const timeStr = formatRelativeTime(s.timestamp);
    const displayName = s.name || s.firstMessage.replace(/\n/g, ' ');
    const ctxInfo = s.context ? ` [${s.context}/${s.namespace || 'default'}]` : '';
    const nameTag = s.name ? '📌 ' : '';
    lines.push(`${i + 1}. ${nameTag}[${timeStr}]${ctxInfo} ${displayName}`);
    lines.push(`   ID: ${s.sessionId.slice(0, 8)}... (${s.messageCount} messages)`);
  }
  
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('💡 /resume N to continue | /rename <name> to name current session');
  
  return lines.join('\n');
}

/**
 * Format relative time
 */
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Find session by index (1-based) or partial ID
 */
export async function findSession(query: string): Promise<SessionInfo | null> {
  const sessions = await listSessions(20);
  
  // Try as 1-based index
  const index = parseInt(query, 10);
  if (!isNaN(index) && index >= 1 && index <= sessions.length) {
    return sessions[index - 1];
  }
  
  // Try as partial session ID
  const match = sessions.find(s => s.sessionId.startsWith(query));
  return match || null;
}
