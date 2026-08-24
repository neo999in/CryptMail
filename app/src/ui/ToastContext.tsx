import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { IconName } from './Icon';
import { Toast } from './Toast';

type ToastConfig = {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  durationMs: number;
  icon?: IconName;
};

type ActiveToast = ToastConfig & {
  startedAt: number;
};

type ToastContextType = {
  showToast: (config: ToastConfig) => void;
  dismissToast: () => void;
};

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [activeToast, setActiveToast] = useState<ActiveToast | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissToast = useCallback(() => {
    setActiveToast(null);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const showToast = useCallback((config: ToastConfig) => {
    setActiveToast({
      ...config,
      startedAt: Date.now(),
    });

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      dismissToast();
    }, config.durationMs);
  }, [dismissToast]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleAction = useCallback(() => {
    if (activeToast?.onAction) {
      activeToast.onAction();
    }
    dismissToast();
  }, [activeToast, dismissToast]);

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
      {activeToast && (
        <Toast
          message={activeToast.message}
          actionLabel={activeToast.actionLabel}
          onAction={handleAction}
          onDismiss={dismissToast}
          durationMs={activeToast.durationMs}
          startedAt={activeToast.startedAt}
        />
      )}
    </ToastContext.Provider>
  );
}

