import { useState, useCallback, useMemo } from 'react';
import type { OutputMessage, ConversationContext } from './agentRunner.js';
import { MODEL_MAP, getModelId } from '../constants.js';
import type { HeimdallConfig } from '../config.js';

export type AppMode = 'setup' | 'repl' | 'selector' | 'running';
export type SetupStep = 'context' | 'namespace' | 'done';
export type SelectorType = 'context' | 'namespace' | 'model';

export interface TUIState {
  // Configuration
  context: string | null;
  namespace: string;
  model: string;
  
  // UI State
  mode: AppMode;
  setupStep: SetupStep;
  activeSelector: SelectorType | null;
  
  // Data
  messages: OutputMessage[];
  kubeconfigPath: string;
  contexts: string[];
  currentContext: string | null;
  
  // Runtime
  isRunning: boolean;
  error: string | null;
}

export interface AppStateActions {
  // Mode transitions
  setMode: (mode: AppMode) => void;
  setSetupStep: (step: SetupStep) => void;
  openSelector: (selector: SelectorType) => void;
  closeSelector: () => void;
  
  // Selection updates
  setContext: (context: string) => void;
  setNamespace: (namespace: string) => void;
  setModel: (model: string) => void;
  
  // Data updates
  setContexts: (contexts: string[], currentContext: string | null) => void;
  setKubeconfigPath: (path: string) => void;
  
  // Message management
  addMessage: (message: OutputMessage) => void;
  clearMessages: () => void;
  
  // Runtime state
  setRunning: (running: boolean) => void;
  setError: (error: string | null) => void;
  
  // Config builder
  buildConfig: () => HeimdallConfig | null;
  getModelId: () => string;
}

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_NAMESPACE = 'all';

export function createInitialState(kubeconfigPath: string): TUIState {
  return {
    context: null,
    namespace: DEFAULT_NAMESPACE,
    model: DEFAULT_MODEL,
    mode: 'setup',
    setupStep: 'context',
    activeSelector: null,
    messages: [],
    kubeconfigPath,
    contexts: [],
    currentContext: null,
    isRunning: false,
    error: null,
  };
}

export function useAppState(initialKubeconfigPath: string): [TUIState, AppStateActions] {
  const [state, setState] = useState<TUIState>(() => 
    createInitialState(initialKubeconfigPath)
  );

  const setMode = useCallback((mode: AppMode) => {
    setState(prev => ({ ...prev, mode }));
  }, []);

  const setSetupStep = useCallback((setupStep: SetupStep) => {
    setState(prev => ({ ...prev, setupStep }));
  }, []);

  const openSelector = useCallback((selector: SelectorType) => {
    setState(prev => ({ 
      ...prev, 
      mode: 'selector',
      activeSelector: selector 
    }));
  }, []);

  const closeSelector = useCallback(() => {
    setState(prev => ({ 
      ...prev, 
      mode: prev.setupStep === 'done' ? 'repl' : 'setup',
      activeSelector: null 
    }));
  }, []);

  const setContext = useCallback((context: string) => {
    setState(prev => {
      const newState = { ...prev, context };
      // If in setup mode, advance to namespace step
      if (prev.mode === 'setup' || prev.mode === 'selector') {
        if (prev.setupStep === 'context') {
          newState.setupStep = 'namespace';
          newState.mode = 'setup';
          newState.activeSelector = null;
        } else {
          newState.mode = prev.setupStep === 'done' ? 'repl' : 'setup';
          newState.activeSelector = null;
        }
      }
      return newState;
    });
  }, []);

  const setNamespace = useCallback((namespace: string) => {
    setState(prev => {
      const newState = { ...prev, namespace };
      // If in setup mode, advance to done
      if (prev.mode === 'setup' || prev.mode === 'selector') {
        if (prev.setupStep === 'namespace') {
          newState.setupStep = 'done';
          newState.mode = 'repl';
          newState.activeSelector = null;
        } else {
          newState.mode = prev.setupStep === 'done' ? 'repl' : 'setup';
          newState.activeSelector = null;
        }
      }
      return newState;
    });
  }, []);

  const setModel = useCallback((model: string) => {
    setState(prev => ({ 
      ...prev, 
      model,
      mode: prev.setupStep === 'done' ? 'repl' : 'setup',
      activeSelector: null,
    }));
  }, []);

  const setContexts = useCallback((contexts: string[], currentContext: string | null) => {
    setState(prev => ({ ...prev, contexts, currentContext }));
  }, []);

  const setKubeconfigPath = useCallback((kubeconfigPath: string) => {
    setState(prev => ({ ...prev, kubeconfigPath }));
  }, []);

  const addMessage = useCallback((message: OutputMessage) => {
    setState(prev => ({ 
      ...prev, 
      messages: [...prev.messages, message] 
    }));
  }, []);

  const clearMessages = useCallback(() => {
    setState(prev => ({ ...prev, messages: [] }));
  }, []);

  const setRunning = useCallback((isRunning: boolean) => {
    setState(prev => ({ 
      ...prev, 
      isRunning,
      mode: isRunning ? 'running' : (prev.setupStep === 'done' ? 'repl' : 'setup'),
    }));
  }, []);

  const setError = useCallback((error: string | null) => {
    setState(prev => ({ ...prev, error }));
  }, []);

  const buildConfig = useCallback((): HeimdallConfig | null => {
    if (!state.context) return null;
    return {
      context: state.context,
      namespace: state.namespace,
      kubeconfig: state.kubeconfigPath,
    };
  }, [state.context, state.namespace, state.kubeconfigPath]);

  const getModelIdFn = useCallback((): string => {
    return getModelId(state.model);
  }, [state.model]);

  const actions: AppStateActions = useMemo(() => ({
    setMode,
    setSetupStep,
    openSelector,
    closeSelector,
    setContext,
    setNamespace,
    setModel,
    setContexts,
    setKubeconfigPath,
    addMessage,
    clearMessages,
    setRunning,
    setError,
    buildConfig,
    getModelId: getModelIdFn,
  }), [
    setMode, setSetupStep, openSelector, closeSelector,
    setContext, setNamespace, setModel, setContexts,
    setKubeconfigPath, addMessage, clearMessages,
    setRunning, setError, buildConfig, getModelIdFn,
  ]);

  return [state, actions];
}

/**
 * Build HeimdallConfig from state values (pure function for testing)
 */
export function buildConfigFromState(
  context: string | null,
  namespace: string,
  kubeconfigPath: string
): HeimdallConfig | null {
  if (!context) return null;
  return {
    context,
    namespace,
    kubeconfig: kubeconfigPath,
  };
}

/**
 * Get model options for selector
 */
export function getModelOptions(): Array<{ value: string; label: string }> {
  return Object.entries(MODEL_MAP).map(([key, info]) => ({
    value: key,
    label: info.label,
  }));
}
