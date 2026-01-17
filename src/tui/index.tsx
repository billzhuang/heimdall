import React from 'react';
import { render } from 'ink';
import { homedir } from 'os';
import { resolve } from 'path';
import { App } from './components/App.js';

export interface TUIOptions {
  kubeconfig?: string;
  verbose?: boolean;
}

/**
 * Run the Ink-based TUI for Heimdall
 */
export async function runInkTUI(options: TUIOptions = {}): Promise<void> {
  // Determine kubeconfig path
  const kubeconfigPath = options.kubeconfig ||
    process.env.KUBECONFIG ||
    resolve(homedir(), '.kube/config');

  // Check if we're in a TTY environment
  if (!process.stdin.isTTY) {
    throw new Error('Interactive mode requires a terminal.');
  }

  const { waitUntilExit } = render(
    <App
      kubeconfig={kubeconfigPath}
      verbose={options.verbose}
    />
  );

  await waitUntilExit();
}
