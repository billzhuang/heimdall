import React from 'react';
import { Box, Text } from 'ink';
import { InputField } from './InputField.js';
import { HEIMDALL_ASCII_ART, HEIMDALL_VERSION, WELCOME_TIPS } from '../constants.js';

/**
 * Props for the WelcomeScreen component
 */
export interface WelcomeScreenProps {
  /** Application version string */
  version: string;
  /** Current Kubernetes context, or null if not configured */
  context: string | null;
  /** Current Kubernetes namespace */
  namespace: string;
  /** Callback when user submits input */
  onSubmit: (input: string) => void;
  /** Whether input is disabled (e.g., during processing) */
  disabled?: boolean;
}

/**
 * WelcomeScreen component displays the initial branded welcome view
 * when Heimdall starts. It shows ASCII art branding, version info,
 * tips panel, and K8s context information.
 * 
 * Structure:
 * - HeaderPanel (ASCII Art, Version, Greeting)
 * - TipsPanel (Command list with descriptions)
 * - ContextInfoPanel (K8s context, namespace - subtle)
 * - InputField (existing component)
 */
export function WelcomeScreen({
  version,
  context,
  namespace,
  onSubmit,
  disabled = false,
}: WelcomeScreenProps): React.ReactElement {
  return (
    <Box flexDirection="column" padding={1}>
      {/* HeaderPanel - ASCII Art, Version, Greeting (Task 2.2) */}
      <Box flexDirection="column" marginBottom={1}>
        {/* ASCII art logo in cyan for branding */}
        <Text color="cyan">{HEIMDALL_ASCII_ART}</Text>
        {/* Version string formatted as "Heimdall vX.Y.Z" */}
        <Text>Heimdall v{HEIMDALL_VERSION}</Text>
        {/* Welcome greeting message */}
        <Text>Welcome!</Text>
      </Box>

      {/* TipsPanel - Command list with descriptions (Task 2.3) */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        marginBottom={1}
      >
        {/* Tips panel header */}
        <Text bold>Tips for getting started</Text>
        <Box marginTop={1} flexDirection="column">
          {WELCOME_TIPS.map((tip) => (
            <Box key={tip.command}>
              <Text color="cyan">{tip.command}</Text>
              <Text color="gray"> - {tip.description}</Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* ContextInfoPanel - K8s context, namespace (Task 2.4) */}
      <Box flexDirection="column" marginBottom={1}>
        {context ? (
          <>
            {/* Display current K8s context in subtle gray */}
            <Text dimColor>Context: {context}</Text>
            {/* Display current namespace in subtle gray */}
            <Text dimColor>Namespace: {namespace}</Text>
          </>
        ) : (
          /* Show hint when context is null */
          <Text dimColor>Configure kubeconfig to get started</Text>
        )}
      </Box>

      {/* InputField - existing component (Task 2.5) */}
      <InputField onSubmit={onSubmit} disabled={disabled} />
    </Box>
  );
}
