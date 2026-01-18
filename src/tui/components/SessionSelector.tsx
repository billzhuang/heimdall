import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { listSessions, type SessionInfo } from '../sessionManager.js';

export interface SessionSelectorProps {
  onSelect: (session: SessionInfo) => void;
  onCancel: () => void;
  currentSessionId?: string | null;
}

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

// Sanitize text to avoid rendering issues with special characters
function sanitizeText(text: string, maxLen: number): string {
  if (!text) return '(empty)';
  // Replace newlines and control chars with space
  const clean = text.replace(/[\n\r\t\x00-\x1F]/g, ' ').trim();
  if (clean.length === 0) return '(empty)';
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen) + '...';
}

export function SessionSelector({
  onSelect,
  onCancel,
  currentSessionId,
}: SessionSelectorProps): React.ReactElement {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const hasLoaded = useRef(false);

  useEffect(() => {
    if (hasLoaded.current) return;
    hasLoaded.current = true;
    
    listSessions(15).then(result => {
      // Pre-select current session if it exists in the list
      if (currentSessionId && result.length > 0) {
        const currentIndex = result.findIndex(s => s.sessionId === currentSessionId);
        if (currentIndex >= 0) {
          setSelectedIndex(currentIndex);
        }
      }
      setSessions(result);
    }).catch(() => {
      setSessions([]);
    });
  }, [currentSessionId]);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (sessions && sessions.length > 0) {
      if (key.return) {
        onSelect(sessions[selectedIndex]);
        return;
      }

      if (key.upArrow) {
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : sessions.length - 1));
        return;
      }

      if (key.downArrow) {
        setSelectedIndex(prev => (prev < sessions.length - 1 ? prev + 1 : 0));
        return;
      }
    }
  });

  // Loading state - sessions is null until loaded
  if (sessions === null) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text color="yellow">Loading sessions...</Text>
      </Box>
    );
  }

  // Empty state
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text color="yellow">No saved sessions found.</Text>
        <Text color="gray">Press Esc to go back</Text>
      </Box>
    );
  }

  // Session list
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="cyan">Select Session to Resume</Text>
      <Text> </Text>
      {sessions.map((session, index) => {
        const isSelected = index === selectedIndex;
        const isCurrent = session.sessionId === currentSessionId;
        const indicator = isSelected ? '>' : ' ';
        const timeStr = formatRelativeTime(session.timestamp);
        const displayName = sanitizeText(session.name || session.firstMessage, 45);
        const namePrefix = session.name ? '[*] ' : '';
        const currentSuffix = isCurrent ? ' (current)' : '';
        const ctxInfo = session.context 
          ? ` [${session.context}/${session.namespace || 'default'}]` 
          : '';
        
        return (
          <Box key={session.sessionId} flexDirection="column">
            <Text color={isSelected ? 'cyan' : isCurrent ? 'green' : undefined}>
              {indicator} {namePrefix}{displayName}{currentSuffix}
            </Text>
            <Text color="gray">
              {'   '}{timeStr}{ctxInfo} ({session.messageCount} msgs)
            </Text>
          </Box>
        );
      })}
      <Text> </Text>
      <Text color="gray">Up/Down: navigate | Enter: select | Esc: cancel</Text>
    </Box>
  );
}
