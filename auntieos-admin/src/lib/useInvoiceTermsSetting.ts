import { useCallback, useEffect, useState } from 'react';
import { getBusinessSettings } from '../api/settings';
import { DEFAULT_BUSINESS_TIME_ZONE, resolveBusinessTimeZone } from './businessOperations';
import { DEFAULT_PAYMENT_TERMS, type InvoiceTermsCode } from './invoiceTerms';

/**
 * #1966: what New invoice needs from Settings: the Payment terms a new invoice
 * starts on, and the zone its visit days are counted in.
 *
 * Read from the owner's own `business_settings` document (the composer is an
 * owner screen; an Auntie never sees money). Until the read lands the status is
 * `loading`, and the composer shows that beside its Terms. A failed read keeps
 * the defaults, due on receipt and America/Chicago, which is what an unset
 * business has, and says so (`error`) with a retry.
 */
export interface InvoiceTermsSetting {
  status: 'loading' | 'ready' | 'error';
  paymentTerms: InvoiceTermsCode;
  timeZone: string;
  retry: () => void;
}

export function useInvoiceTermsSetting(): InvoiceTermsSetting {
  const [state, setState] = useState<Omit<InvoiceTermsSetting, 'retry'>>({
    status: 'loading',
    paymentTerms: DEFAULT_PAYMENT_TERMS,
    timeZone: DEFAULT_BUSINESS_TIME_ZONE,
  });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, status: 'loading' }));
    getBusinessSettings()
      .then((settings) => {
        if (!live) return;
        setState({
          status: 'ready',
          paymentTerms: settings.invoicePaymentTerms,
          timeZone: resolveBusinessTimeZone(settings.timeZone),
        });
      })
      .catch(() => {
        if (live) setState((s) => ({ ...s, status: 'error' }));
      });
    return () => {
      live = false;
    };
  }, [attempt]);
  return { ...state, retry };
}
