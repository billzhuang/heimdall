import { useState, useCallback, useMemo, useRef } from 'react';
import type { OutputMessage } from './agentRunner.js';
import { MODEL_MAP, getModelId } from './constants.js';
import type { HeimdallConfig } from './types.js';
import type { KubeconfigContext } from './kubeconfigParser.js';

export type AppMode = 'repl' | 'selector' | 'running';
export type SelectorType = 'context' | 'namespace' | 'model';

export interface TUIState {
  // Configuration
  context: string | null;
  namespace: string;
  model: string;
  
  // UI State
  mode: AppMode;
  activeSelector: SelectorType | null;
  
  // Data
  messages: OutputMessage[];
  kubeconfigPath: string;
  contexts: string[];
  
  // Status hints
  statusHint: string | null;
  
  // Runtime
  isRunning: boolean;
  error: string | null;
}

export interface AppStateActions {
  // Mode transitions
  setMode: (mode: AppMode) => void;
  openSelector: (selector: SelectorType) => void;
  closeSelector: () => void;
  
  // Selection updates
  setContext: (context: string) => void;
  setNamespace: (namespace: string) => void;
  setModel: (model: string) => void;
  
  // Data updates
  setKubeconfigPath: (path: string) => void;
  setContexts: (contexts: string[]) => void;
  setStatusHint: (hint: string | null) => void;
  
  // Message management
  addMessage: (message: OutputMessage) => void;
  clearMessages: () => void;
  
  // Runtime state
  setRunning: (running: boolean) => void;
  setError: (error: string | null) => void;
  
  // Config builder
  buildConfig: () => HeimdallConfig | null;
  getModelId: () => string;
  
  // Context data storage (for looking up default namespaces)
  setContextData: (data: KubeconfigContext[]) => void;
}

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_NAMESPACE = 'kube-system';

export function createInitialState(kubeconfigPath: string): TUIState {
  return {
    context: null,
    namespace: DEFAULT_NAMESPACE,
    model: DEFAULT_MODEL,
    mode: 'repl',
    activeSelector: null,
    messages: [],
    kubeconfigPath,
    contexts: [],
    statusHint: null,
    isRunning: false,
    error: null,
  };
}

export function useAppState(initialKubeconfigPath: string): [TUIState, AppStateActions] {
  const [state, setState] = useState<TUIState>(() => 
    createInitialState(initialKubeconfigPath)
  );
  
  // Store context data for looking up default namespaces
  const contextDataRef = useRef<KubeconfigContext[]>([]);

  const setMode = useCallback((mode: AppMode) => {
    setState(prev => ({ ...prev, mode }));
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
      mode: 'repl',
      activeSelector: null 
    }));
  }, []);

  const setContext = useCallback((context: string) => {
    // When context changes, reset namespace to context's default or kube-system
    const ctxData = contextDataRef.current.find(c => c.name === context);
    const defaultNs = ctxData?.namespace || 'kube-system';
    
    setState(prev => ({ 
      ...prev, 
      context,
      namespace: defaultNs,
      statusHint: null,
      mode: 'repl',
      activeSelector: null,
    }));
  }, []);

  const setNamespace = useCallback((namespace: string) => {
    setState(prev => ({ 
      ...prev, 
      namespace,
      mode: 'repl',
      activeSelector: null,
    }));
  }, []);
  
  const setContextData = useCallback((data: KubeconfigContext[]) => {
    contextDataRef.current = data;
  }, []);

  const setModel = useCallback((model: string) => {
    setState(prev => ({ 
      ...prev, 
      model,
      mode: 'repl',
      activeSelector: null,
    }));
  }, []);

  const setKubeconfigPath = useCallback((kubeconfigPath: string) => {
    setState(prev => ({ ...prev, kubeconfigPath }));
  }, []);

  const setContexts = useCallback((contexts: string[]) => {
    setState(prev => ({ ...prev, contexts }));
  }, []);

  const setStatusHint = useCallback((statusHint: string | null) => {
    setState(prev => ({ ...prev, statusHint }));
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
      mode: isRunning ? 'running' : 'repl',
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
    openSelector,
    closeSelector,
    setContext,
    setNamespace,
    setModel,
    setKubeconfigPath,
    setContexts,
    setStatusHint,
    addMessage,
    clearMessages,
    setRunning,
    setError,
    buildConfig,
    getModelId: getModelIdFn,
    setContextData,
  }), [
    setMode, openSelector, closeSelector,
    setContext, setNamespace, setModel,
    setKubeconfigPath, setContexts, setStatusHint, addMessage, clearMessages,
    setRunning, setError, buildConfig, getModelIdFn, setContextData,
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
