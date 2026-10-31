import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import SupplierApp from './supplier/SupplierApp';
import MfgQuoteEntryApp from './supplier/MfgQuoteEntryApp';
import MfgRfqApp from './supplier/MfgRfqApp';

// Path-based split (no router): /supplier* mounts the off-Zoho supplier platform;
// /mfg-quote-entry is the manufacturer entering a supplier's quote; everything else is
// the existing nesting/take-off app. All are served the same index.html by Express, so
// the choice happens here at mount time.
const path = window.location.pathname;
const isSupplier = path.replace(/\/+$/, '').endsWith('/supplier') || path.startsWith('/supplier');
const isMfgQuoteEntry = path.startsWith('/mfg-quote-entry');
const isMfgRfq = path.startsWith('/mfg-rfq');

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(isMfgRfq ? <MfgRfqApp /> : isMfgQuoteEntry ? <MfgQuoteEntryApp /> : isSupplier ? <SupplierApp /> : <App />);
